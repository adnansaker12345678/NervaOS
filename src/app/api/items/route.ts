import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookmarks, events, memories, notes, tasks } from "@/db/schema";
import { parseDue, parsePriority, safeTimeZone } from "@/lib/tasks";
import { errorResponse, getWorkspace, isUUID, publicRecord } from "@/lib/workspace";

const cleanTitle = (value: unknown, max = 300) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "");

function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url = value.trim().slice(0, 2000);
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch { return null; }
}

export async function POST(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const body = await request.json();
    const title = cleanTitle(body.title);
    if (!title || !["task", "note", "memory", "event", "bookmark"].includes(body.kind)) {
      return Response.json({ error: "A title and valid item type are required." }, { status: 400 });
    }
    const headers = { "x-aura-workspace": workspace.id };
    if (body.kind === "task") {
      const due = body.due ? parseDue(body.due, safeTimeZone(body.timezone)) : null;
      if (body.due && !due) return Response.json({ error: "That due date is not valid." }, { status: 400 });
      const [item] = await db.insert(tasks).values({ workspaceId: workspace.id, title, due, priority: parsePriority(body.priority) }).returning();
      return Response.json(publicRecord(item), { headers });
    }
    if (body.kind === "note") {
      const [item] = await db.insert(notes).values({ workspaceId: workspace.id, title, content: String(body.content || "").slice(0, 30000) }).returning();
      return Response.json(publicRecord(item), { headers });
    }
    if (body.kind === "memory") {
      const fact = cleanTitle(body.fact || body.title);
      if (!fact) return Response.json({ error: "Say the fact to remember." }, { status: 400 });
      const [item] = await db.insert(memories).values({ workspaceId: workspace.id, fact }).returning();
      return Response.json(publicRecord(item), { headers });
    }
    if (body.kind === "event") {
      const date = parseDue(body.date, safeTimeZone(body.timezone));
      if (!date) return Response.json({ error: "Give a real date as YYYY-MM-DD or YYYY-MM-DDTHH:mm." }, { status: 400 });
      const [item] = await db.insert(events).values({ workspaceId: workspace.id, title, date, notes: String(body.notes || "").slice(0, 2000) }).returning();
      return Response.json(publicRecord(item), { headers });
    }
    const url = cleanUrl(body.url);
    if (!url) return Response.json({ error: "That is not a valid web address." }, { status: 400 });
    const [item] = await db.insert(bookmarks).values({ workspaceId: workspace.id, url, title, notes: String(body.notes || "").slice(0, 2000) }).returning();
    return Response.json(publicRecord(item), { headers });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const body = await request.json();
    if (!isUUID(body.id)) return Response.json({ error: "Invalid item." }, { status: 400 });
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 300) : undefined;
    const headers = { "x-aura-workspace": workspace.id };
    if (body.kind === "task") {
      const changes: { title?: string; completed?: boolean; due?: string | null; priority?: "low" | "normal" | "high" } = { ...(title ? { title } : {}), ...(typeof body.completed === "boolean" ? { completed: body.completed } : {}) };
      if (body.due === null || body.due === "") changes.due = null;
      else if (body.due !== undefined) {
        const due = parseDue(body.due, safeTimeZone(body.timezone));
        if (!due) return Response.json({ error: "That due date is not valid." }, { status: 400 });
        changes.due = due;
      }
      if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
      if (!Object.keys(changes).length) return Response.json({ error: "No changes supplied." }, { status: 400 });
      const [item] = await db.update(tasks).set(changes).where(and(eq(tasks.id, body.id), eq(tasks.workspaceId, workspace.id))).returning();
      return item ? Response.json(publicRecord(item), { headers }) : Response.json({ error: "Task not found." }, { status: 404 });
    }
    if (body.kind === "note") {
      const changes = { ...(title ? { title } : {}), ...(typeof body.content === "string" ? { content: body.content.slice(0, 30000) } : {}) };
      if (!Object.keys(changes).length) return Response.json({ error: "No changes supplied." }, { status: 400 });
      const [item] = await db.update(notes).set(changes).where(and(eq(notes.id, body.id), eq(notes.workspaceId, workspace.id))).returning();
      return item ? Response.json(publicRecord(item), { headers }) : Response.json({ error: "Note not found." }, { status: 404 });
    }
    if (body.kind === "memory") {
      const fact = cleanTitle(body.fact || body.title);
      if (!fact) return Response.json({ error: "No changes supplied." }, { status: 400 });
      const [item] = await db.update(memories).set({ fact }).where(and(eq(memories.id, body.id), eq(memories.workspaceId, workspace.id))).returning();
      return item ? Response.json(publicRecord(item), { headers }) : Response.json({ error: "Memory not found." }, { status: 404 });
    }
    if (body.kind === "event") {
      const changes: { title?: string; date?: string; notes?: string } = { ...(title ? { title } : {}) };
      if (body.date !== undefined) {
        const date = parseDue(body.date, safeTimeZone(body.timezone));
        if (!date) return Response.json({ error: "That date is not valid." }, { status: 400 });
        changes.date = date;
      }
      if (typeof body.notes === "string") changes.notes = body.notes.slice(0, 2000);
      if (!Object.keys(changes).length) return Response.json({ error: "No changes supplied." }, { status: 400 });
      const [item] = await db.update(events).set(changes).where(and(eq(events.id, body.id), eq(events.workspaceId, workspace.id))).returning();
      return item ? Response.json(publicRecord(item), { headers }) : Response.json({ error: "Event not found." }, { status: 404 });
    }
    if (body.kind !== "bookmark") return Response.json({ error: "Invalid item type." }, { status: 400 });
    const changes: { title?: string; url?: string; notes?: string } = { ...(title ? { title } : {}) };
    if (body.url !== undefined) {
      const url = cleanUrl(body.url);
      if (!url) return Response.json({ error: "That is not a valid web address." }, { status: 400 });
      changes.url = url;
    }
    if (typeof body.notes === "string") changes.notes = body.notes.slice(0, 2000);
    if (!Object.keys(changes).length) return Response.json({ error: "No changes supplied." }, { status: 400 });
    const [item] = await db.update(bookmarks).set(changes).where(and(eq(bookmarks.id, body.id), eq(bookmarks.workspaceId, workspace.id))).returning();
    return item ? Response.json(publicRecord(item), { headers }) : Response.json({ error: "Bookmark not found." }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const workspace = await getWorkspace(request);
    const body = await request.json();
    if (!isUUID(body.id)) return Response.json({ error: "Invalid item." }, { status: 400 });
    if (body.kind === "task") await db.delete(tasks).where(and(eq(tasks.id, body.id), eq(tasks.workspaceId, workspace.id)));
    else if (body.kind === "note") await db.delete(notes).where(and(eq(notes.id, body.id), eq(notes.workspaceId, workspace.id)));
    else if (body.kind === "memory") await db.delete(memories).where(and(eq(memories.id, body.id), eq(memories.workspaceId, workspace.id)));
    else if (body.kind === "event") await db.delete(events).where(and(eq(events.id, body.id), eq(events.workspaceId, workspace.id)));
    else if (body.kind === "bookmark") await db.delete(bookmarks).where(and(eq(bookmarks.id, body.id), eq(bookmarks.workspaceId, workspace.id)));
    else return Response.json({ error: "Invalid item type." }, { status: 400 });
    return Response.json({ ok: true }, { headers: { "x-aura-workspace": workspace.id } });
  } catch (error) { return errorResponse(error); }
}
