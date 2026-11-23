const WORKSPACE_KEY = "aura-workspace-id";

export function getClientWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function setClientWorkspaceId(id: string) {
  if (typeof window === "undefined" || !id) return;
  try {
    localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    // ignore
  }
}

export function workspaceHeaders(customHeaders?: HeadersInit): HeadersInit {
  const id = getClientWorkspaceId();
  return {
    "Content-Type": "application/json",
    ...(id ? { "x-aura-workspace": id } : {}),
    ...customHeaders,
  };
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: workspaceHeaders(options?.headers),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  if (data && typeof data === "object" && typeof data.workspaceId === "string") {
    setClientWorkspaceId(data.workspaceId);
  }
  return data as T;
}

export function relativeDate(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function userTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** Turns a stored local due value ("2026-11-16" or "2026-11-16T09:00") into a short label. */
export function formatDue(due: string | null | undefined): { label: string; overdue: boolean } | null {
  if (!due) return null;
  const hasTime = due.length > 10;
  const [year, month, day] = due.slice(0, 10).split("-").map(Number);
  const [hour, minute] = hasTime ? due.slice(11, 16).split(":").map(Number) : [23, 59];
  const date = new Date(year, month - 1, day, hour, minute);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((new Date(year, month - 1, day).getTime() - today.getTime()) / 86_400_000);
  const dayLabel = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday"
    : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(year !== now.getFullYear() ? { year: "numeric" } : {}) });
  const time = hasTime ? ` · ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
  return { label: `${dayLabel}${time}`, overdue: date.getTime() < now.getTime() };
}
