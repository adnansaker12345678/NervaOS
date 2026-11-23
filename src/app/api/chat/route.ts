import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, workspaces } from "@/db/schema";
import { runAgent } from "@/lib/agent";
import { appendTextBlock, extractActions, extractContent, upsertActionBlock } from "@/lib/blocks";
import { safeTimeZone } from "@/lib/tasks";
import { defaultSettings } from "@/lib/types";
import { errorResponse, getWorkspace, ownedConversation } from "@/lib/workspace";
import type { Attachment, ChatEvent, MessageBlock, MessageMeta } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const active = new Set<string>();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const regenerate = body.regenerate === true;
    const timezone = safeTimeZone(body.timezone);
    let content = typeof body.content === "string" ? body.content.trim() : "";
    if (content.length > 20000) return Response.json({ error: "Please keep messages under 20,000 characters." }, { status: 400 });

    const incoming = Array.isArray(body.attachments) ? body.attachments : [];
    if (incoming.length > 3) return Response.json({ error: "You can attach up to 3 files per message." }, { status: 400 });

    const attachments: Attachment[] = [];
    for (const file of incoming) {
      if (!file || typeof file.content !== "string" || typeof file.name !== "string" || file.content.length > 3000000) {
        return Response.json({ error: "Invalid attachment. Each file must be under 2 MB." }, { status: 400 });
      }
      if (file.type === "image" && !/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\s]+$/.test(file.content)) {
        return Response.json({ error: "Please attach a PNG, JPEG, WebP, or GIF image." }, { status: 400 });
      }
      if (file.type !== "image" && file.type !== "text") {
        return Response.json({ error: "Only images and text files are supported." }, { status: 400 });
      }
      if (file.type === "text" && file.content.length > 200000) {
        return Response.json({ error: "Text files must contain fewer than 200,000 characters." }, { status: 400 });
      }
      attachments.push({
        id: crypto.randomUUID(),
        name: file.name.slice(0, 200),
        type: file.type,
        mime: String(file.mime || "text/plain").slice(0, 80),
        content: file.content,
        size: Math.min(Number(file.size) || 0, 2097152),
      });
    }

    if (!regenerate && !content && !attachments.length) return Response.json({ error: "Write a message or attach a file first." }, { status: 400 });

    let conversationId = typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim() : null;
    let workspace = await getWorkspace(request, conversationId);

    let chat = null;
    if (conversationId) {
      chat = await ownedConversation(conversationId, workspace.id);
      if (chat && chat.workspaceId !== workspace.id) {
        // Adopt the workspace of the conversation so session always stays aligned
        const [adopted] = await db.select().from(workspaces).where(eq(workspaces.id, chat.workspaceId)).limit(1);
        if (adopted) {
          workspace = { ...adopted, settings: { ...defaultSettings, ...adopted.settings } };
        }
      }
    }

    if (regenerate && !chat) return Response.json({ error: "That conversation is no longer available." }, { status: 404 });
    if (!chat) {
      // If no conversation was found or provided, create a fresh one
      const [newChat] = await db.insert(conversations).values({
        workspaceId: workspace.id,
        title: (content || attachments[0]?.name || "New conversation").replace(/\n/g, " ").slice(0, 70),
      }).returning();
      conversationId = newChat.id;
      chat = newChat;
    }

    const chatId = chat.id;
    // Lock per conversation (not whole workspace) so background jobs and other chats stay unblocked.
    if (active.has(chatId)) return Response.json({ error: "Finishing the previous reply in this chat. Please wait a second." }, { status: 409 });
    active.add(chatId);

    let userMessage;
    let history;
    try {
      if (regenerate) {
        // Regenerating re-runs the last request, so it is only allowed when that reply changed nothing.
        const [last, previous] = await db.select().from(messages).where(eq(messages.conversationId, chatId)).orderBy(desc(messages.createdAt)).limit(2);
        if (!last || last.role !== "assistant" || !previous || previous.role !== "user") {
          active.delete(chatId);
          return Response.json({ error: "Only the latest reply can be regenerated." }, { status: 409 });
        }
        if (last.actions.length) {
          active.delete(chatId);
          return Response.json({ error: "That reply changed your workspace, so regenerating could repeat those changes. Send a new message instead." }, { status: 409 });
        }
        await db.delete(messages).where(eq(messages.id, last.id));
        userMessage = previous;
        content = previous.content;
      } else {
        [userMessage] = await db.insert(messages).values({ conversationId: chatId, role: "user", content, attachments }).returning();
      }
      await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, chatId));
      history = (await db.select().from(messages).where(eq(messages.conversationId, chatId)).orderBy(desc(messages.createdAt)).limit(30)).reverse();
    } catch (error) { active.delete(chatId); throw error; }

    const encoder = new TextEncoder();
    const aborter = new AbortController();
    const signal = AbortSignal.any([request.signal, aborter.signal, AbortSignal.timeout(280000)]);
    const currentWorkspaceId = workspace.id;

    const stream = new ReadableStream({
      async start(controller) {
        let blocks: MessageBlock[] = [];
        let closed = false;
        const startedAt = Date.now();
        let run: { engine: string | null; model: string | null; aiTurns: number } = { engine: null, model: null, aiTurns: 0 };
        const write = (event: ChatEvent) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
          catch { closed = true; }
        };
        // Engines send a few characters at a time. Sending each one separately makes the
        // browser redraw constantly, so text is grouped into ~40ms slices: still live, far smoother.
        let pendingText = "";
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const flush = () => {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          if (!pendingText) return;
          const text = pendingText;
          pendingText = "";
          write({ type: "delta", text });
        };
        const emit = (event: ChatEvent) => {
          if (event.type === "delta") {
            blocks = appendTextBlock(blocks, event.text);
            pendingText += event.text;
            if (!flushTimer) flushTimer = setTimeout(flush, 40);
            return;
          }
          flush();
          if (event.type === "action") blocks = upsertActionBlock(blocks, event.action);
          write(event);
        };
        try {
          emit({ type: "start", conversationId: chatId, workspaceId: currentWorkspaceId, userMessage: JSON.parse(JSON.stringify(userMessage)) });
          run = await runAgent({ workspace, conversationId: chatId, userText: content, emit, signal, clientGone: () => request.signal.aborted, localOnly: body.localOnly === true, timezone, planning: body.planning === "always" || body.planning === "off" ? body.planning : (workspace.settings.planning ?? "auto") }, history);
        } catch (error) {
          const stopped = request.signal.aborted;
          const message = stopped ? "Response stopped. Any completed workspace changes have been saved." : error instanceof Error ? error.message : "Something went wrong. Please try again.";
          if (!stopped) emit({ type: "error", error: message });
          const hasText = extractContent(blocks).length > 0;
          emit({ type: "delta", text: (hasText ? "\n\n" : "") + message });
        } finally {
          try {
            // Normalize any unfinished running actions to error if interrupted
            blocks = blocks.map((block) => block.type === "action" && block.action.status === "running"
              ? { type: "action", action: { ...block.action, status: "error", detail: "Stopped before completion" } }
              : block);
            let finalContent = extractContent(blocks);
            const finalActions = extractActions(blocks);
            if (!finalContent) {
              finalContent = finalActions.length ? "Done. Your changes are saved." : "I couldn’t finish a reply that time. Your message is saved — please try again.";
              blocks = appendTextBlock(blocks, finalContent);
            }
            const meta: MessageMeta = { engine: run.engine, model: run.model, aiTurns: run.aiTurns, steps: finalActions.length, durationMs: Date.now() - startedAt };
            const [message] = await db.insert(messages).values({ conversationId: chatId, role: "assistant", content: finalContent, actions: finalActions, blocks, meta }).returning();
            emit({ type: "done", message: JSON.parse(JSON.stringify(message)) });
          } catch { emit({ type: "error", error: "The response could not be saved. Please refresh and try again." }); }
          active.delete(chatId);
          if (!closed) { try { controller.close(); } catch { /* Client disconnected. */ } }
        }
      },
      cancel() { aborter.abort(); },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        // no-transform stops proxies and compression from holding the stream back.
        "Cache-Control": "no-cache, no-store, no-transform",
        "X-Accel-Buffering": "no",
        "x-aura-workspace": currentWorkspaceId,
      },
    });
  } catch (error) { return errorResponse(error); }
}
