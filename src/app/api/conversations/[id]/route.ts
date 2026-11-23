import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { errorResponse, getWorkspace, ownedConversation, publicRecord } from "@/lib/workspace";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const workspace = await getWorkspace(request, id);
    const chat = await ownedConversation(id, workspace.id);
    if (!chat) return Response.json({ error: "Conversation not found." }, { status: 404 });
    const list = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
    return Response.json({ conversation: publicRecord(chat), messages: list }, {
      headers: { "x-aura-workspace": workspace.id },
    });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const workspace = await getWorkspace(request, id);
    const chat = await ownedConversation(id, workspace.id);
    if (!chat) return Response.json({ error: "Conversation not found." }, { status: 404 });
    const body = await request.json();
    const changes: { title?: string; pinned?: boolean; archived?: boolean; updatedAt: Date } = { updatedAt: new Date() };
    if (typeof body.title === "string" && body.title.trim()) changes.title = body.title.trim().slice(0, 160);
    if (typeof body.pinned === "boolean") changes.pinned = body.pinned;
    if (typeof body.archived === "boolean") changes.archived = body.archived;
    const [updated] = await db.update(conversations).set(changes).where(eq(conversations.id, chat.id)).returning();
    return Response.json(publicRecord(updated), {
      headers: { "x-aura-workspace": workspace.id },
    });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const workspace = await getWorkspace(request, id);
    const chat = await ownedConversation(id, workspace.id);
    if (!chat) return Response.json({ error: "Conversation not found." }, { status: 404 });
    await db.delete(conversations).where(eq(conversations.id, chat.id));
    return Response.json({ ok: true }, {
      headers: { "x-aura-workspace": workspace.id },
    });
  } catch (error) { return errorResponse(error); }
}
