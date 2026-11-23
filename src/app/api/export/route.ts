import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { errorResponse, getWorkspace, getWorkspaceState } from "@/lib/workspace";

export async function GET() {
  try {
    const workspace = await getWorkspace();
    const state = await getWorkspaceState(workspace);
    const chats = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, workspace.id));
    const allMessages = chats.length ? await db.select().from(messages).where(inArray(messages.conversationId, chats.map((c) => c.id))).orderBy(asc(messages.createdAt)) : [];
    return new Response(JSON.stringify({ app: "Aura", exportedAt: new Date().toISOString(), settings: state.settings, conversations: state.conversations, messages: allMessages, tasks: state.tasks, notes: state.notes, memories: state.memories, events: state.events, bookmarks: state.bookmarks }, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="aura-workspace-${new Date().toISOString().slice(0, 10)}.json"`, "Cache-Control": "no-store" },
    });
  } catch (error) { return errorResponse(error); }
}
