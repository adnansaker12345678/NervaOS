import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { defaultSettings, type Settings, type AgentAction, type Attachment, type MessageBlock, type MessageMeta, type TaskPriority } from "@/lib/types";

export const workspaces = pgTable("aura_workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  settings: jsonb("settings").$type<Settings>().notNull().default(defaultSettings),
  terminalCwd: text("terminal_cwd").default("/").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** The workspace's private files. Terminal commands and the agent operate only on these rows. */
export const workspaceFiles = pgTable("aura_files", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  isDir: boolean("is_dir").default(false).notNull(),
  content: text("content").default("").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("aura_files_workspace_path_uidx").on(t.workspaceId, t.path)]);

export const conversations = pgTable("aura_conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  pinned: boolean("pinned").default(false).notNull(),
  archived: boolean("archived").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("aura_conversations_workspace_idx").on(t.workspaceId)]);

export const messages = pgTable("aura_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").$type<"user" | "assistant">().notNull(),
  content: text("content").notNull(),
  actions: jsonb("actions").$type<AgentAction[]>().notNull().default([]),
  blocks: jsonb("blocks").$type<MessageBlock[]>().notNull().default([]),
  meta: jsonb("meta").$type<MessageMeta | null>(),
  feedback: text("feedback").$type<"up" | "down" | null>(),
  attachments: jsonb("attachments").$type<Attachment[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("aura_messages_conversation_idx").on(t.conversationId)]);

export const tasks = pgTable("aura_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  completed: boolean("completed").default(false).notNull(),
  due: text("due"),
  priority: text("priority").$type<TaskPriority>().default("normal").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("aura_tasks_workspace_idx").on(t.workspaceId)]);

export const notes = pgTable("aura_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("aura_notes_workspace_idx").on(t.workspaceId)]);

/** Long-term facts the agent remembers about the user ("my dog's name is Riku"). */
export const memories = pgTable("aura_memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  fact: text("fact").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("aura_memories_workspace_idx").on(t.workspaceId)]);

/** Dated events: meetings, birthdays, trips. date is local "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm". */
export const events = pgTable("aura_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  date: text("date").notNull(),
  notes: text("notes").default("").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("aura_events_workspace_idx").on(t.workspaceId)]);

/** Saved web bookmarks with an optional note. */
export const bookmarks = pgTable("aura_bookmarks", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  title: text("title").notNull(),
  notes: text("notes").default("").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("aura_bookmarks_workspace_idx").on(t.workspaceId)]);
