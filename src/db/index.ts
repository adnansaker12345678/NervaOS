import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createMockDb } from "@/db/mock";

const databaseUrl = process.env.DATABASE_URL;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __auraMockDbWarned?: boolean;
  __auraDbTargetPromise?: Promise<NodePgDatabase>;
  __auraMockInstance?: NodePgDatabase;
};

const SCHEMA_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS "aura_workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "terminal_cwd" text NOT NULL DEFAULT '/',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "aura_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "aura_workspaces"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "is_dir" boolean NOT NULL DEFAULT false,
  "content" text NOT NULL DEFAULT '',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "aura_files_workspace_path_uidx" ON "aura_files" ("workspace_id", "path");
CREATE TABLE IF NOT EXISTS "aura_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "aura_workspaces"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "pinned" boolean NOT NULL DEFAULT false,
  "archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "aura_conversations_workspace_idx" ON "aura_conversations" ("workspace_id");
CREATE TABLE IF NOT EXISTS "aura_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "aura_conversations"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "actions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "blocks" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "meta" jsonb,
  "feedback" text,
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "aura_messages_conversation_idx" ON "aura_messages" ("conversation_id");
CREATE TABLE IF NOT EXISTS "aura_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "aura_workspaces"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "completed" boolean NOT NULL DEFAULT false,
  "due" text,
  "priority" text NOT NULL DEFAULT 'normal',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "aura_tasks_workspace_idx" ON "aura_tasks" ("workspace_id");
CREATE TABLE IF NOT EXISTS "aura_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "aura_workspaces"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "aura_notes_workspace_idx" ON "aura_notes" ("workspace_id");
CREATE TABLE IF NOT EXISTS "aura_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "aura_workspaces"("id") ON DELETE CASCADE,
  "fact" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "aura_memories_workspace_idx" ON "aura_memories" ("workspace_id");
CREATE TABLE IF NOT EXISTS "aura_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "aura_workspaces"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "date" text NOT NULL,
  "notes" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "aura_events_workspace_idx" ON "aura_events" ("workspace_id");
CREATE TABLE IF NOT EXISTS "aura_bookmarks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "aura_workspaces"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "title" text NOT NULL,
  "notes" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "aura_bookmarks_workspace_idx" ON "aura_bookmarks" ("workspace_id");
`;

function getMockInstance(): NodePgDatabase {
  if (!globalForDb.__auraMockInstance) {
    globalForDb.__auraMockInstance = createMockDb() as unknown as NodePgDatabase;
  }
  return globalForDb.__auraMockInstance;
}

let poolInstance: Pool | null = null;
let dbInstance: NodePgDatabase;

if (databaseUrl) {
  poolInstance =
    globalForDb.__arenaNextJsPostgresqlPool ??
    new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 2500,
    });
  if (process.env.NODE_ENV !== "production") {
    globalForDb.__arenaNextJsPostgresqlPool = poolInstance;
  }
  const pgDb = drizzle(poolInstance);
  const activePool = poolInstance;

  const resolveDb = (): Promise<NodePgDatabase> => {
    if (!globalForDb.__auraDbTargetPromise) {
      globalForDb.__auraDbTargetPromise = (async () => {
        try {
          await activePool.query("SELECT 1");
          try {
            await activePool.query('SELECT 1 FROM "aura_workspaces" LIMIT 1');
          } catch (tableErr) {
            const code = (tableErr as { code?: string })?.code;
            if (code === "42P01") {
              await activePool.query(SCHEMA_BOOTSTRAP_SQL);
            } else {
              throw tableErr;
            }
          }
          return pgDb;
        } catch (err) {
          if (!globalForDb.__auraMockDbWarned) {
            globalForDb.__auraMockDbWarned = true;
            console.warn(
              "[Aura DB] PostgreSQL unreachable — falling back to in-memory workspace store:",
              err instanceof Error ? err.message : "connection error",
            );
          }
          return getMockInstance();
        }
      })();
    }
    return globalForDb.__auraDbTargetPromise;
  };

  const wrapBuilder = (op: "select" | "selectDistinct" | "insert" | "update" | "delete", args: unknown[]) => {
    const calls: { method: string; args: unknown[] }[] = [];
    const run = async () => {
      const target = await resolveDb();
      let cur = (target[op] as unknown as (...a: unknown[]) => Record<string, unknown>)(...args);
      for (const step of calls) {
        const fn = cur[step.method];
        if (typeof fn === "function") {
          cur = (fn as (...a: unknown[]) => Record<string, unknown>).apply(cur, step.args);
        }
      }
      return await (cur as unknown as Promise<unknown>);
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              run().then(onFulfilled, onRejected);
          }
          if (prop === "catch") {
            return (onRejected?: (e: unknown) => unknown) => run().catch(onRejected);
          }
          if (prop === "finally") {
            return (onFinally?: () => void) => run().finally(onFinally);
          }
          return (...methodArgs: unknown[]) => {
            calls.push({ method: String(prop), args: methodArgs });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };

  dbInstance = {
    execute: (...args: unknown[]) =>
      resolveDb().then((target) => (target.execute as (...a: unknown[]) => Promise<unknown>)(...args)),
    select: (...args: unknown[]) => wrapBuilder("select", args),
    selectDistinct: (...args: unknown[]) => wrapBuilder("selectDistinct", args),
    insert: (...args: unknown[]) => wrapBuilder("insert", args),
    update: (...args: unknown[]) => wrapBuilder("update", args),
    delete: (...args: unknown[]) => wrapBuilder("delete", args),
  } as unknown as NodePgDatabase;
} else {
  if (!globalForDb.__auraMockDbWarned) {
    globalForDb.__auraMockDbWarned = true;
    console.warn("[AI Studio] DATABASE_URL not set — using in-memory mock database (data will not persist across restarts).");
  }
  dbInstance = getMockInstance();
}

export const pool = poolInstance;
export const db = dbInstance;
