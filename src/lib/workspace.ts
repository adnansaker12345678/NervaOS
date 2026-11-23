import "server-only";
import { cookies, headers } from "next/headers";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookmarks, conversations, events, memories, notes, tasks, workspaces } from "@/db/schema";
import { defaultSettings, type Settings, type WorkspaceState } from "@/lib/types";
import { engineInfo } from "@/lib/ai";
import { listJobs } from "@/lib/jobs";

const COOKIE = "aura-workspace";
export const isUUID = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function persistCookie(jar: Awaited<ReturnType<typeof cookies>>, reqHeaders: Headers, workspaceId: string) {
  try {
    const isHttps = reqHeaders.get("x-forwarded-proto") === "https" || reqHeaders.get("referer")?.startsWith("https://");
    jar.set(COOKIE, workspaceId, {
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? "none" : "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  } catch {
    // In certain streaming contexts jar.set can throw; ignore safely
  }
}

export async function getWorkspace(request?: Request, targetConversationId?: string | null) {
  const reqHeaders = request ? request.headers : await headers();
  const headerId = reqHeaders.get("x-aura-workspace");
  const jar = await cookies();
  const cookieId = jar.get(COOKIE)?.value;

  // 1. Explicit workspace header sent by client (from localStorage)
  if (isUUID(headerId)) {
    const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, headerId)).limit(1);
    if (existing) {
      persistCookie(jar, reqHeaders, existing.id);
      return { ...existing, settings: { ...defaultSettings, ...existing.settings } };
    }
  }

  // 2. Cookie workspace ID
  if (isUUID(cookieId)) {
    const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, cookieId)).limit(1);
    if (existing) {
      persistCookie(jar, reqHeaders, existing.id);
      return { ...existing, settings: { ...defaultSettings, ...existing.settings } };
    }
  }

  // 3. Fallback: If continuing an existing conversation, recover its workspace!
  // This completely prevents "Conversation not found" if the browser was in an iframe
  // where cookies were blocked or partitioned.
  if (isUUID(targetConversationId)) {
    const [chat] = await db.select().from(conversations).where(eq(conversations.id, targetConversationId)).limit(1);
    if (chat) {
      const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, chat.workspaceId)).limit(1);
      if (existing) {
        persistCookie(jar, reqHeaders, existing.id);
        return { ...existing, settings: { ...defaultSettings, ...existing.settings } };
      }
    }
  }

  // 4. Create new workspace
  const [workspace] = await db.insert(workspaces).values({}).returning();
  persistCookie(jar, reqHeaders, workspace.id);
  return { ...workspace, settings: { ...defaultSettings, ...workspace.settings } };
}

export function cleanSettings(input: unknown): Partial<Settings> {
  if (!input || typeof input !== "object") return {};
  const source = input as Record<string, unknown>;
  const result: Partial<Settings> = {};
  if (typeof source.displayName === "string") result.displayName = source.displayName.trim().slice(0, 60);
  if (["light", "dark", "system"].includes(String(source.theme))) result.theme = source.theme as Settings["theme"];
  if (["balanced", "concise", "detailed"].includes(String(source.responseStyle))) result.responseStyle = source.responseStyle as Settings["responseStyle"];
  if (["auto", "en", "bn"].includes(String(source.language))) result.language = source.language as Settings["language"];
  if (["auto", "always", "off"].includes(String(source.planning))) result.planning = source.planning as Settings["planning"];
  for (const key of ["focusMode", "compactMode", "showSuggestions", "memory", "sound"] as const) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  return result;
}

export async function getWorkspaceState(workspace: Awaited<ReturnType<typeof getWorkspace>>): Promise<WorkspaceState> {
  const [chats, taskList, noteList, memoryList, eventList, bookmarkList] = await Promise.all([
    db.select().from(conversations).where(eq(conversations.workspaceId, workspace.id)).orderBy(desc(conversations.pinned), desc(conversations.updatedAt)),
    db.select().from(tasks).where(eq(tasks.workspaceId, workspace.id)).orderBy(desc(tasks.createdAt)),
    db.select().from(notes).where(eq(notes.workspaceId, workspace.id)).orderBy(desc(notes.createdAt)),
    db.select().from(memories).where(eq(memories.workspaceId, workspace.id)).orderBy(desc(memories.createdAt)),
    db.select().from(events).where(eq(events.workspaceId, workspace.id)).orderBy(events.date),
    db.select().from(bookmarks).where(eq(bookmarks.workspaceId, workspace.id)).orderBy(desc(bookmarks.createdAt)),
  ]);
  return {
    workspaceId: workspace.id,
    settings: workspace.settings,
    engine: engineInfo(),
    conversations: chats.map(({ workspaceId: _, ...chat }) => chat),
    tasks: taskList.map(({ workspaceId: _, ...task }) => task),
    notes: noteList.map(({ workspaceId: _, ...note }) => note),
    memories: memoryList.map(({ workspaceId: _, ...memory }) => memory),
    events: eventList.map(({ workspaceId: _, ...event }) => event),
    bookmarks: bookmarkList.map(({ workspaceId: _, ...bookmark }) => bookmark),
    jobs: listJobs(workspace.id),
  };
}

export async function ownedConversation(id: string, workspaceId: string) {
  if (!isUUID(id)) return null;
  // Primary check: conversation in requested workspace
  const [exact] = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.workspaceId, workspaceId))).limit(1);
  if (exact) return exact;
  // Rescue check: if conversation exists in any workspace, return it so the caller can adopt the workspace
  const [anywhere] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return anywhere || null;
}

export function publicRecord<T extends { workspaceId: string }>(record: T): Omit<T, "workspaceId"> {
  const { workspaceId: _workspaceId, ...data } = record;
  return data;
}

export function errorResponse(error: unknown) {
  console.error("Aura API:", error instanceof Error ? error.message : "Unexpected error");
  return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}
