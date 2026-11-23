import { getTableColumns, getTableName, SQL, type Table } from "drizzle-orm";
import { defaultSettings } from "@/lib/types";

type Row = Record<string, unknown>;
type JoinSpec = { type: "left" | "inner"; table: Table; on: unknown };
type RowContext = Record<string, Row | null>;

const globalForMock = globalThis as typeof globalThis & {
  __auraMockDbStore?: Map<string, Row[]>;
};

const store = globalForMock.__auraMockDbStore ?? (globalForMock.__auraMockDbStore = new Map<string, Row[]>());

function getTableRows(table: Table): Row[] {
  const name = getTableName(table);
  let rows = store.get(name);
  if (!rows) {
    rows = [];
    store.set(name, rows);
  }
  return rows;
}

const columnKeyCache = new WeakMap<object, Map<string, string>>();

function getColumnJsKey(col: { name: string; table?: Table }): string {
  if (!col.table) return col.name;
  let map = columnKeyCache.get(col.table);
  if (!map) {
    map = new Map<string, string>();
    const cols = getTableColumns(col.table);
    for (const [jsKey, colDef] of Object.entries(cols)) {
      map.set(colDef.name, jsKey);
    }
    columnKeyCache.set(col.table, map);
  }
  return map.get(col.name) ?? col.name;
}

function isColumn(chunk: unknown): chunk is { name: string; table: Table } {
  return Boolean(chunk && typeof chunk === "object" && "name" in chunk && "table" in chunk && (chunk as { table?: unknown }).table);
}

function isParam(chunk: unknown): chunk is { value: unknown; encoder: unknown } {
  return Boolean(chunk && typeof chunk === "object" && "value" in chunk && "encoder" in chunk);
}

function isStringChunk(chunk: unknown): chunk is { value: string[] } {
  return Boolean(chunk && typeof chunk === "object" && chunk.constructor?.name === "StringChunk" && Array.isArray((chunk as { value?: unknown }).value));
}

function isSQL(chunk: unknown): chunk is SQL {
  return Boolean(chunk && typeof chunk === "object" && (chunk instanceof SQL || Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)));
}

function resolveValue(chunk: unknown, ctx: RowContext): unknown {
  if (isColumn(chunk)) {
    const tName = getTableName(chunk.table);
    const key = getColumnJsKey(chunk);
    return ctx[tName]?.[key];
  }
  if (isParam(chunk)) return chunk.value;
  if (Array.isArray(chunk)) return chunk.map((item) => resolveValue(item, ctx));
  return chunk;
}

function likeToRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    } else if (ch === "%") {
      out += ".*";
    } else if (ch === "_") {
      out += ".";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out, "is");
}

function evalChunks(rawChunks: unknown[], ctx: RowContext): boolean {
  const chunks = rawChunks.filter((c) => {
    if (isStringChunk(c)) {
      const text = c.value.join("").trim();
      return text !== "" && text !== "(" && text !== ")";
    }
    return c !== undefined && c !== null;
  });

  if (chunks.length === 0) return true;
  if (chunks.length === 1) return evalExpr(chunks[0], ctx);

  // Split by top-level 'and' / 'or'
  const splitBy = (op: "and" | "or"): unknown[][] | null => {
    const groups: unknown[][] = [];
    let current: unknown[] = [];
    let found = false;
    for (const chunk of chunks) {
      if (isStringChunk(chunk) && chunk.value.join("").trim().toLowerCase() === op) {
        found = true;
        groups.push(current);
        current = [];
      } else {
        current.push(chunk);
      }
    }
    if (!found) return null;
    groups.push(current);
    return groups;
  };

  const orGroups = splitBy("or");
  if (orGroups) return orGroups.some((group) => evalChunks(group, ctx));

  const andGroups = splitBy("and");
  if (andGroups) return andGroups.every((group) => evalChunks(group, ctx));

  // Binary predicate: [left, op, right]
  if (chunks.length >= 3 && isStringChunk(chunks[1])) {
    const op = chunks[1].value.join("").trim().toLowerCase();
    const leftVal = resolveValue(chunks[0], ctx);
    const rightVal = resolveValue(chunks[2], ctx);
    if (op === "=") return leftVal === rightVal;
    if (op === "!=" || op === "<>") return leftVal !== rightVal;
    if (op === "ilike") {
      if (leftVal == null) return false;
      return likeToRegex(String(rightVal ?? "")).test(String(leftVal));
    }
    if (op === "like") {
      if (leftVal == null) return false;
      return new RegExp(likeToRegex(String(rightVal ?? "")).source, "s").test(String(leftVal));
    }
    if (op === "in") {
      const list = Array.isArray(rightVal) ? rightVal.map((v) => (isParam(v) ? v.value : v)) : [];
      return list.includes(leftVal);
    }
  }

  return true;
}

function evalExpr(expr: unknown, ctx: RowContext): boolean {
  if (!expr) return true;
  if (isSQL(expr)) return evalChunks((expr as unknown as { queryChunks: unknown[] }).queryChunks, ctx);
  return true;
}

function extractOrderSpec(expr: unknown): { col: { name: string; table: Table }; desc: boolean } | null {
  if (isColumn(expr)) return { col: expr, desc: false };
  if (isSQL(expr)) {
    const chunks = (expr as unknown as { queryChunks: unknown[] }).queryChunks;
    let col: { name: string; table: Table } | null = null;
    let isDesc = false;
    for (const c of chunks) {
      if (isColumn(c)) col = c;
      if (isStringChunk(c) && /\bdesc\b/i.test(c.value.join(""))) isDesc = true;
    }
    if (col) return { col, desc: isDesc };
  }
  return null;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const va = a instanceof Date ? a.getTime() : typeof a === "boolean" ? Number(a) : a;
  const vb = b instanceof Date ? b.getTime() : typeof b === "boolean" ? Number(b) : b;
  if (typeof va === "number" && typeof vb === "number") return va - vb;
  return String(va).localeCompare(String(vb));
}

function applyDefaults(tableName: string, input: Row): Row {
  const now = new Date();
  const base: Row = {
    id: input.id ?? crypto.randomUUID(),
    createdAt: input.createdAt ?? now,
    ...input,
  };
  switch (tableName) {
    case "aura_workspaces":
      return { settings: { ...defaultSettings }, terminalCwd: "/", ...base };
    case "aura_files":
      return { isDir: false, content: "", updatedAt: now, ...base };
    case "aura_conversations":
      return { pinned: false, archived: false, updatedAt: now, ...base };
    case "aura_messages":
      return { actions: [], blocks: [], meta: null, feedback: null, attachments: [], ...base };
    case "aura_tasks":
      return { completed: false, due: null, priority: "normal", ...base };
    case "aura_events":
    case "aura_bookmarks":
      return { notes: "", ...base };
    default:
      return base;
  }
}

function cloneRow<T extends Row>(row: T): T {
  return structuredClone(row);
}

export function createMockDb() {
  const makeSelectBuilder = (fields: Record<string, unknown> | undefined, distinct: boolean) => {
    let fromTable: Table | null = null;
    const joins: JoinSpec[] = [];
    let whereExpr: unknown = undefined;
    let orderExprs: unknown[] = [];
    let limitCount: number | undefined = undefined;

    const execute = (): Row[] => {
      if (!fromTable) return [];
      const baseName = getTableName(fromTable);
      let contexts: RowContext[] = getTableRows(fromTable).map((row) => ({ [baseName]: row }));

      for (const join of joins) {
        const joinName = getTableName(join.table);
        const joinRows = getTableRows(join.table);
        const nextContexts: RowContext[] = [];
        for (const ctx of contexts) {
          const matches = joinRows.filter((jRow) => evalExpr(join.on, { ...ctx, [joinName]: jRow }));
          if (matches.length > 0) {
            for (const m of matches) nextContexts.push({ ...ctx, [joinName]: m });
          } else if (join.type === "left") {
            nextContexts.push({ ...ctx, [joinName]: null });
          }
        }
        contexts = nextContexts;
      }

      if (whereExpr) {
        contexts = contexts.filter((ctx) => evalExpr(whereExpr, ctx));
      }

      if (orderExprs.length > 0) {
        const specs = orderExprs.map(extractOrderSpec).filter((s): s is NonNullable<typeof s> => Boolean(s));
        contexts.sort((ctxA, ctxB) => {
          for (const spec of specs) {
            const tName = getTableName(spec.col.table);
            const key = getColumnJsKey(spec.col);
            const cmp = compareValues(ctxA[tName]?.[key], ctxB[tName]?.[key]);
            if (cmp !== 0) return spec.desc ? -cmp : cmp;
          }
          return 0;
        });
      }

      let projected: Row[] = contexts.map((ctx) => {
        if (!fields) return cloneRow(ctx[baseName] ?? {});
        const out: Row = {};
        for (const [alias, col] of Object.entries(fields)) {
          if (isColumn(col)) {
            const tName = getTableName(col.table);
            const key = getColumnJsKey(col);
            out[alias] = ctx[tName]?.[key] ?? null;
          }
        }
        return out;
      });

      if (distinct) {
        const seen = new Set<string>();
        projected = projected.filter((row) => {
          const key = JSON.stringify(row);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      if (typeof limitCount === "number") {
        projected = projected.slice(0, limitCount);
      }
      return projected;
    };

    const builder = {
      from(table: Table) {
        fromTable = table;
        return builder;
      },
      leftJoin(table: Table, on: unknown) {
        joins.push({ type: "left", table, on });
        return builder;
      },
      innerJoin(table: Table, on: unknown) {
        joins.push({ type: "inner", table, on });
        return builder;
      },
      where(expr: unknown) {
        whereExpr = expr;
        return builder;
      },
      orderBy(...exprs: unknown[]) {
        orderExprs = exprs;
        return builder;
      },
      limit(n: number) {
        limitCount = n;
        return builder;
      },
      then<TResult1 = Row[], TResult2 = never>(
        onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve().then(execute).then(onfulfilled, onrejected);
      },
    };
    return builder;
  };

  return {
    execute: async () => ({ rows: [{ "?column?": 1 }] }),
    select: (fields?: Record<string, unknown>) => makeSelectBuilder(fields, false),
    selectDistinct: (fields?: Record<string, unknown>) => makeSelectBuilder(fields, true),
    insert(table: Table) {
      const tableName = getTableName(table);
      let inputRows: Row[] = [];
      let conflictConfig: { target: unknown; set: Row } | null = null;

      const execute = (): Row[] => {
        const rows = getTableRows(table);
        const inserted: Row[] = [];
        for (const item of inputRows) {
          const next = applyDefaults(tableName, item);
          if (conflictConfig) {
            const targets = Array.isArray(conflictConfig.target) ? conflictConfig.target : [conflictConfig.target];
            const targetKeys = targets.filter(isColumn).map((c) => getColumnJsKey(c));
            const existing = rows.find((r) => targetKeys.every((k) => r[k] === next[k]));
            if (existing) {
              Object.assign(existing, conflictConfig.set);
              inserted.push(cloneRow(existing));
              continue;
            }
          }
          rows.push(next);
          inserted.push(cloneRow(next));
        }
        return inserted;
      };

      const builder = {
        values(vals: Row | Row[]) {
          inputRows = Array.isArray(vals) ? vals : [vals];
          return builder;
        },
        onConflictDoUpdate(config: { target: unknown; set: Row }) {
          conflictConfig = config;
          return builder;
        },
        returning() {
          return Promise.resolve().then(execute);
        },
        then<TResult1 = Row[], TResult2 = never>(
          onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve().then(execute).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },
    update(table: Table) {
      const tableName = getTableName(table);
      let changes: Row = {};
      let whereExpr: unknown = undefined;

      const execute = (): Row[] => {
        const rows = getTableRows(table);
        const updated: Row[] = [];
        for (const row of rows) {
          if (evalExpr(whereExpr, { [tableName]: row })) {
            Object.assign(row, changes);
            updated.push(cloneRow(row));
          }
        }
        return updated;
      };

      const builder = {
        set(vals: Row) {
          changes = vals;
          return builder;
        },
        where(expr: unknown) {
          whereExpr = expr;
          return builder;
        },
        returning() {
          return Promise.resolve().then(execute);
        },
        then<TResult1 = Row[], TResult2 = never>(
          onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve().then(execute).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },
    delete(table: Table) {
      const tableName = getTableName(table);
      let whereExpr: unknown = undefined;

      const execute = (): Row[] => {
        const rows = getTableRows(table);
        const kept: Row[] = [];
        const removed: Row[] = [];
        for (const row of rows) {
          if (evalExpr(whereExpr, { [tableName]: row })) removed.push(row);
          else kept.push(row);
        }
        store.set(tableName, kept);

        if (tableName === "aura_conversations" && removed.length) {
          const ids = new Set(removed.map((r) => r.id));
          const msgs = store.get("aura_messages") ?? [];
          store.set("aura_messages", msgs.filter((m) => !ids.has(m.conversationId)));
        } else if (tableName === "aura_workspaces" && removed.length) {
          const ids = new Set(removed.map((r) => r.id));
          for (const child of ["aura_files", "aura_conversations", "aura_tasks", "aura_notes", "aura_memories", "aura_events", "aura_bookmarks"]) {
            const list = store.get(child) ?? [];
            store.set(child, list.filter((r) => !ids.has(r.workspaceId)));
          }
        }
        return removed.map(cloneRow);
      };

      const builder = {
        where(expr: unknown) {
          whereExpr = expr;
          return builder;
        },
        returning() {
          return Promise.resolve().then(execute);
        },
        then<TResult1 = Row[], TResult2 = never>(
          onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve().then(execute).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },
  };
}
