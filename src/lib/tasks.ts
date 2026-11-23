import type { TaskPriority, TaskSummary } from "@/lib/types";

/** Task helpers shared by the agent, instant commands, and the items API. No database access here. */

export type TaskInput = { title: string; due: string | null; priority: TaskPriority };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

export function safeTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 64) return "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return value; } catch { return "UTC"; }
}

/** Today's date ("YYYY-MM-DD") in the given time zone. */
export function localDate(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Current local date and time ("YYYY-MM-DDTHH:mm") in the given time zone. */
export function localDateTime(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function addDays(date: string, days: number): string {
  const match = DATE.exec(date);
  if (!match) return date;
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return value.toISOString().slice(0, 10);
}

function validDate(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day && year >= 2000 && year <= 2100;
}

/**
 * Accepts a local date, a local date-time, an ISO timestamp with offset, or the words today/tomorrow.
 * Returns "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in the user's time zone, or null when it is not a real date.
 */
export function parseDue(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "today") return localDate(timeZone);
  if (lower === "tomorrow") return addDays(localDate(timeZone), 1);
  // A timestamp with an explicit offset is converted into the user's local time.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) && DATE_TIME.test(raw)) {
    const instant = new Date(raw);
    return Number.isNaN(instant.getTime()) ? null : localDateTime(timeZone, instant);
  }
  const dateTime = DATE_TIME.exec(raw);
  if (dateTime) {
    const [, y, m, d, hh, mm] = dateTime.map(Number) as unknown as number[];
    if (!validDate(y, m, d) || hh > 23 || mm > 59) return null;
    return `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${dateTime[4]}:${dateTime[5]}`;
  }
  const date = DATE.exec(raw);
  if (date && validDate(Number(date[1]), Number(date[2]), Number(date[3]))) return raw;
  return null;
}

export function parsePriority(value: unknown): TaskPriority {
  const lower = typeof value === "string" ? value.toLowerCase().trim() : "";
  if (["high", "urgent", "important", "critical"].includes(lower)) return "high";
  if (["low", "minor", "someday"].includes(lower)) return "low";
  return "normal";
}

/** Reads a day word and an explicit clock time from plain text. Vague phrases such as "morning" are left alone. */
export function detectDue(textValue: string, timeZone: string): string | null {
  const lower = textValue.toLowerCase();
  let day: string | null = null;
  if (/\b(?:today|tonight)\b/.test(lower) || /(?<![\u0980-\u09ff])আজ(?:কে)?(?![\u0980-\u09ff])/.test(textValue)) day = localDate(timeZone);
  if (/\btomorrow\b/.test(lower) || /আগামীকাল/.test(textValue) || /(?<![\u0980-\u09ff])কাল(?:কে)?(?![\u0980-\u09ff])/.test(textValue)) day = addDays(localDate(timeZone), 1);
  if (!day) return null;
  const clock = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(lower) ?? /\bat\s+(\d{1,2}):(\d{2})\b/.exec(lower);
  if (!clock) return day;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  const meridiem = clock[3];
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return day;
  return `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const cleanTitle = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 300) : "");

/**
 * Models describe tasks in many shapes. This accepts all the reasonable ones:
 * { tasks: [{ title, due, priority }] }, { tasks: ["a", "b"] }, { titles: [...] }, { titles: "a" }, { title: "a" }.
 */
export function normalizeTaskInputs(args: Record<string, unknown>, timeZone: string): TaskInput[] {
  const result: TaskInput[] = [];
  const sharedDue = parseDue(args.due ?? args.dueDate ?? args.due_date, timeZone);
  const sharedPriority = parsePriority(args.priority);
  const add = (entry: unknown) => {
    if (typeof entry === "string") {
      const title = cleanTitle(entry);
      if (title) result.push({ title, due: sharedDue, priority: sharedPriority });
      return;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const item = entry as Record<string, unknown>;
      const title = cleanTitle(item.title ?? item.name ?? item.task ?? item.text);
      if (!title) return;
      const due = parseDue(item.due ?? item.dueDate ?? item.due_date ?? item.date, timeZone) ?? sharedDue;
      result.push({ title, due, priority: item.priority === undefined ? sharedPriority : parsePriority(item.priority) });
    }
  };
  for (const key of ["tasks", "titles", "items", "title", "task"]) {
    const value = args[key];
    if (Array.isArray(value)) value.forEach(add);
    else if (value !== undefined) add(value);
    if (result.length) break;
  }
  return result.slice(0, 20);
}

export const taskSummary = (task: TaskSummary): TaskSummary => ({ id: task.id, title: task.title, completed: task.completed, due: task.due, priority: task.priority });

/** Finds one task by id, exact title, or a unique partial title. */
export function findTask<T extends { id: string; title: string }>(all: T[], reference: unknown): { task?: T; error?: string } {
  const value = typeof reference === "string" ? reference.trim() : "";
  if (!value) return { error: "Say which task you mean, by its title." };
  const byId = all.find((task) => task.id === value);
  if (byId) return { task: byId };
  const lower = value.toLowerCase();
  const exact = all.filter((task) => task.title.toLowerCase() === lower);
  if (exact.length === 1) return { task: exact[0] };
  const partial = all.filter((task) => task.title.toLowerCase().includes(lower) || lower.includes(task.title.toLowerCase()));
  if (partial.length === 1) return { task: partial[0] };
  if (partial.length > 1) return { error: `Several tasks match: ${partial.slice(0, 5).map((task) => `“${task.title}”`).join(", ")}. Use the full title.` };
  return { error: `No task matches “${value.slice(0, 80)}”.` };
}
