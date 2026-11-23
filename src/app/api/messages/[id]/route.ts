import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { errorResponse, getWorkspace, isUUID } from "@/lib/workspace";

type Context = { params: Promise<{ id: string }> };

/** Saves a thumbs up/down on one of this workspace's own assistant replies. */
export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    if (!isUUID(id)) return Response.json({ error: "Invalid message." }, { status: 400 });
    const workspace = await getWorkspace(request);
    const body = await request.json();
    const feedback = body.feedback === "up" || body.feedback === "down" ? body.feedback : null;
    const [owned] = await db.select({ id: messages.id })
      .from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.id, id), eq(messages.role, "assistant"), eq(conversations.workspaceId, workspace.id))).limit(1);
    if (!owned) return Response.json({ error: "Message not found." }, { status: 404 });
    await db.update(messages).set({ feedback }).where(eq(messages.id, id));
    return Response.json({ id, feedback });
  } catch (error) { return errorResponse(error); }
}
