export type Settings = {
  displayName: string;
  theme: "light" | "dark" | "system";
  responseStyle: "balanced" | "concise" | "detailed";
  language: "auto" | "en" | "bn";
  focusMode: boolean;
  compactMode: boolean;
  showSuggestions: boolean;
  memory: boolean;
  sound: boolean;
  planning: PlanningMode;
};

/** auto: plan only when it helps · always: a plan before every job · off: never. */
export type PlanningMode = "auto" | "always" | "off";
export type PlanStepStatus = "pending" | "active" | "done" | "skipped" | "failed";
/** Stable ids (s1, s2…): steps can never be removed or reordered, only closed. */
export type PlanStep = { id: string; title: string; status: PlanStepStatus; note?: string };

export const defaultSettings: Settings = {
  displayName: "",
  theme: "light",
  responseStyle: "balanced",
  language: "auto",
  focusMode: false,
  compactMode: false,
  showSuggestions: true,
  memory: true,
  sound: false,
  planning: "auto",
};

export type EngineInfo = {
  id: string;
  label: string;
  model: string;
  keyless: boolean;
  vision: boolean;
  note: string;
  alternates: number;
  cooldownSeconds: number;
};

export type Attachment = {
  id: string;
  name: string;
  type: "image" | "text";
  mime: string;
  content: string;
  size: number;
};

export type AgentAction = {
  id: string;
  type: "task" | "note" | "settings" | "navigate" | "conversation" | "terminal" | "web" | "search" | "calc" | "time" | "workspace" | "browser" | "skill" | "memory" | "event" | "bookmark" | "plan";
  title: string;
  detail?: string;
  status?: "running" | "done" | "error";
  data?: Record<string, unknown>;
};

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "action"; action: AgentAction };

/** How a reply was produced. engine is null when Aura acted instantly without any AI request. */
export type MessageMeta = { engine: string | null; model: string | null; aiTurns: number; steps: number; durationMs: number };

export type Message = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  actions: AgentAction[];
  blocks?: MessageBlock[];
  attachments: Attachment[];
  meta?: MessageMeta | null;
  feedback?: "up" | "down" | null;
  /** Browser-only: keeps the same on-screen element when the saved copy replaces the live one. */
  clientId?: string;
  createdAt: string;
};

export type Conversation = {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
};

export type TaskPriority = "low" | "normal" | "high";
/** due is a local date ("2026-11-16") or local date-time ("2026-11-16T09:00") in the user's own time zone. */
export type Task = { id: string; title: string; completed: boolean; due: string | null; priority: TaskPriority; createdAt: string | Date };
export type TaskSummary = Pick<Task, "id" | "title" | "completed" | "due" | "priority">;
export type Note = { id: string; title: string; content: string; createdAt: string | Date };
export type Memory = { id: string; fact: string; createdAt: string | Date };
/** date is local "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in the user's own time zone. */
export type CalEvent = { id: string; title: string; date: string; notes: string; createdAt: string | Date };
export type Bookmark = { id: string; url: string; title: string; notes: string; createdAt: string | Date };
export type BackgroundJob = {
  id: string;
  conversationId: string;
  tool: string;
  label: string;
  detail: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  output?: string;
  image?: string;
  panel?: string;
};
export type Panel = "settings" | "history" | "tasks" | "notes" | "help" | "terminal" | "browser" | "library" | "skills" | null;
export type WorkspaceState = {
  workspaceId: string;
  settings: Settings;
  engine: EngineInfo;
  conversations: Conversation[];
  tasks: Task[];
  notes: Note[];
  memories: Memory[];
  events: CalEvent[];
  bookmarks: Bookmark[];
  jobs?: BackgroundJob[];
};

export type ChatEvent =
  | { type: "start"; conversationId: string; workspaceId?: string; userMessage: Message }
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "action"; action: AgentAction }
  | { type: "done"; message: Message }
  | { type: "error"; error: string };
