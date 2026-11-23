import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { errorResponse, getWorkspace } from "@/lib/workspace";

export async function GET(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const q = new URL(request.url).searchParams.get("q")?.trim().slice(0, 120) || "";
    const term = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const results = await db.selectDistinct({
      id: conversations.id, title: conversations.title, pinned: conversations.pinned,
      archived: conversations.archived, createdAt: conversations.createdAt, updatedAt: conversations.updatedAt,
    }).from(conversations).leftJoin(messages, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.workspaceId, workspace.id), q ? or(ilike(conversations.title, term), ilike(messages.content, term)) : undefined))
      .orderBy(desc(conversations.updatedAt)).limit(100);
    return Response.json(results, {
      headers: { "x-aura-workspace": workspace.id },
    });
  } catch (error) { return errorResponse(error); }
}
