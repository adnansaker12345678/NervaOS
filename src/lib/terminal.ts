import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceFiles, workspaces } from "@/db/schema";
import { runRemoteTerminal, type RemoteWorkspaceEntry } from "@/lib/remote-terminal";
import { gitClone, npmInstall, pipInstall, runSafeCurl, type UnpackedEntry } from "@/lib/pkg-install";

/**
 * Aura's terminal is a hybrid virtual Linux shell:
 * - Simple workspace navigation/file shortcuts (pwd, cd, ls, cat, write, calc) stay instant in PostgreSQL.
 * - Package & network tools (pip install, npm init/install, git clone, curl/wget) unpack safely into the workspace DB.
 * - Linux commands, pipes (|), redirects (>), Python (with /site-packages), Node (with node_modules),
 *   SQLite, and C/C++ execute inside a keyless remote virtual Linux container (Wandbox / Paiza.io / Codapi).
 */

export const MAX_OUTPUT = 6000;
const MAX_FILE_CHARS = 300_000;
const MAX_ENTRIES = 1000;
const MAX_LINE = 400;

type Entry = { path: string; isDir: boolean; content: string };
export type TerminalResult = { ok: boolean; output: string; cwd: string; changed: boolean; engine?: string };

const HELP = `Aura Virtual Linux Terminal — keyless cloud sandbox + workspace sync
  Built-in instant commands:
    pwd, ls, cd, tree, stat, mkdir, cat, head, wc, write, append, touch, grep, rm, calc, clear
  Package managers & network (persisted in workspace):
    pip install <pkg>, pip list, npm init -y, npm install <pkg>, npm list
    curl [-i|-o file] <url>, wget <url>, git clone https://github.com/owner/repo
  Remote virtual Linux server (Wandbox · Paiza.io · Codapi):
    Full Bash: pipes (|), redirects (> >>), chaining (&& ;), heredocs (<< EOF)
    Runtimes: python3 -c "..." / python3 file.py, node -e "..." / node file.js, sqlite3 "..."
  Full Root VM:
    Switch to the "Direct Linux VM" tab for root apk/pacman (JSLinux Alpine / v86 Arch Linux).
  Example: mkdir app && cd app && npm install ms && echo "console.log(require('ms')('2h'))" > index.js && node index.js`;

/**
 * Splits a command line into words, honouring single and double quotes.
 * Backslash escapes a quote or another backslash (so \" stays inside quotes);
 * other backslashes are kept verbatim so write's \n convention keeps working.
 */
export function tokenize(line: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let hasToken = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\" && (line[i + 1] === '"' || line[i + 1] === "'" || line[i + 1] === "\\")) {
      current += line[i + 1];
      hasToken = true;
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; hasToken = true; continue; }
    if (/\s/.test(char)) {
      if (hasToken) { tokens.push(current); current = ""; hasToken = false; }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (quote) return null;
  if (hasToken) tokens.push(current);
  return tokens;
}

export function normalize(cwd: string, input: string): string | null {
  if (!input || input.length > 220 || /[\0\\]/.test(input)) return null;
  const start = input.startsWith("/") ? "" : cwd;
  const parts: string[] = [];
  for (const segment of `${start}/${input}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { parts.pop(); continue; }
    if (!/^[\w.\- @]{1,90}$/.test(segment) || segment.startsWith(".")) return null;
    parts.push(segment);
  }
  if (parts.length > 14) return null;
  return `/${parts.join("/")}`;
}

const parentOf = (path: string) => (path.lastIndexOf("/") <= 0 ? "/" : path.slice(0, path.lastIndexOf("/")));
const isUnder = (path: string, folder: string) => (folder === "/" ? path !== "/" : path.startsWith(`${folder}/`));

async function loadEntries(workspaceId: string): Promise<Entry[]> {
  const rows = await db.select({ path: workspaceFiles.path, isDir: workspaceFiles.isDir, content: workspaceFiles.content })
    .from(workspaceFiles).where(eq(workspaceFiles.workspaceId, workspaceId));
  return rows;
}

function children(entries: Entry[], folder: string) {
  const seen = new Map<string, Entry>();
  for (const entry of entries) {
    if (parentOf(entry.path) === folder && entry.path !== folder) seen.set(entry.path, entry);
  }
  return [...seen.values()].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path));
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || "/";
const dirsCount = (entries: Entry[], folder: string) => entries.filter((entry) => entry.path.startsWith(folder === "/" ? "/" : `${folder}/`)).length;

/** Writes or appends file content that was parsed verbatim (quotes kept as typed). */
async function runWrite(options: { workspaceId: string; cwd: string; entries: Entry[]; name: string; pathArg: string; body: string; explicitDelete: boolean }): Promise<TerminalResult> {
  const { workspaceId, name } = options;
  if (name === "echo") return { ok: true, output: options.body.replace(/\\n/g, "\n").slice(0, MAX_OUTPUT), cwd: options.cwd, changed: false };
  const target = options.pathArg ? normalize(options.cwd, options.pathArg) : null;
  if (!target || target === "/") return { ok: false, output: `${name}: give a file path, such as notes/idea.txt.`, cwd: options.cwd, changed: false };
  if (options.entries.some((entry) => entry.path === target && entry.isDir)) return { ok: false, output: `${name}: ${options.pathArg} is a folder.`, cwd: options.cwd, changed: false };
  const body = options.body.replace(/\\n/g, "\n");
  if (!body) return { ok: false, output: `${name}: add some text after the path.`, cwd: options.cwd, changed: false };
  if (body.length > MAX_LINE * 200) return { ok: false, output: "That text is too long for one file write.", cwd: options.cwd, changed: false };
  const current = options.entries.find((entry) => entry.path === target)?.content ?? "";
  const next = name === "append" ? (current ? `${current}\n${body}` : body) : body;
  if (next.length > MAX_FILE_CHARS) return { ok: false, output: "That file would be too large. Keep files under 100,000 characters.", cwd: options.cwd, changed: false };
  const folders = new Set<string>();
  let folder = parentOf(target);
  while (folder !== "/") { if (!options.entries.some((entry) => entry.path === folder)) folders.add(folder); folder = parentOf(folder); }
  const creating = !options.entries.some((entry) => entry.path === target);
  if (options.entries.length + folders.size + (creating ? 1 : 0) > MAX_ENTRIES) return { ok: false, output: "This workspace has reached its file limit. Delete something first.", cwd: options.cwd, changed: false };
  if (folders.size) await db.insert(workspaceFiles).values([...folders].map((path) => ({ workspaceId, path, isDir: true, content: "" })));
  if (creating) await db.insert(workspaceFiles).values({ workspaceId, path: target, isDir: false, content: next });
  else await db.update(workspaceFiles).set({ content: next, updatedAt: new Date() }).where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.path, target)));
  return { ok: true, output: `${creating ? "Created" : "Saved"} ${target} (${next.length} characters)`, cwd: options.cwd, changed: true };
}

/** Extracts unquoted parts of a command line to detect shell operators like |, >, &&, ;, $(), <<. */
function unquotedText(line: string): string {
  let quoted: "'" | '"' | null = null;
  let bare = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\" && (line[i + 1] === '"' || line[i + 1] === "'" || line[i + 1] === "\\")) { i++; continue; }
    if (quoted) { if (char === quoted) quoted = null; continue; }
    if (char === "'" || char === '"') { quoted = char; continue; }
    bare += char;
  }
  return bare;
}

const isPkgPath = (path: string) =>
  path === "/site-packages" || path.startsWith("/site-packages/") || path === "/node_modules" || /(?:^|\/)node_modules(?:\/|$)/.test(path);

/** Upserts unpacked package/clone files and parent folders into workspaceFiles, respecting MAX_ENTRIES. */
async function upsertEntries(workspaceId: string, before: Entry[], unpacked: UnpackedEntry[]): Promise<{ inserted: number; updated: number; dropped: number }> {
  const beforeMap = new Map(before.map((e) => [e.path, e]));
  const staged = new Map<string, Entry>();

  for (const item of unpacked) {
    const norm = normalize("/", item.path);
    if (!norm || norm === "/") continue;
    staged.set(norm, { path: norm, isDir: item.isDir, content: item.content });
    let parent = parentOf(norm);
    while (parent !== "/") {
      if (!staged.has(parent) && !beforeMap.has(parent)) staged.set(parent, { path: parent, isDir: true, content: "" });
      parent = parentOf(parent);
    }
  }

  const toInsert: Entry[] = [];
  const toUpdate: Entry[] = [];
  for (const [path, item] of staged) {
    const prev = beforeMap.get(path);
    if (!prev) toInsert.push(item);
    else if (!prev.isDir && !item.isDir && prev.content !== item.content) toUpdate.push(item);
  }

  // Sort directories first, then core code/manifest files before ancillary files when truncating
  toInsert.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path));
  const capacity = Math.max(0, MAX_ENTRIES - before.length);
  const dropped = Math.max(0, toInsert.length - capacity);
  const finalInsert = toInsert.slice(0, capacity);

  for (let i = 0; i < finalInsert.length; i += 100) {
    const chunk = finalInsert.slice(i, i + 100);
    await db.insert(workspaceFiles).values(
      chunk.map((item) => ({ workspaceId, path: item.path, isDir: item.isDir, content: item.content })),
    );
  }
  for (const item of toUpdate) {
    await db.update(workspaceFiles).set({ content: item.content, updatedAt: new Date() })
      .where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.path, item.path)));
  }
  return { inserted: finalInsert.length, updated: toUpdate.length, dropped };
}

/** Syncs files created/updated in the remote virtual Linux container back into workspaceFiles. */
async function syncRemoteEntries(options: {
  workspaceId: string;
  before: Entry[];
  after: RemoteWorkspaceEntry[];
  explicitDelete: boolean;
}): Promise<boolean> {
  const { workspaceId, before, after, explicitDelete } = options;
  const beforeMap = new Map(before.map((e) => [e.path, e]));
  const afterMap = new Map<string, RemoteWorkspaceEntry>();

  for (const item of after) {
    const norm = normalize("/", item.path);
    if (!norm || norm === "/") continue;
    afterMap.set(norm, { path: norm, isDir: item.isDir, content: item.content });
    // Ensure parent directories exist
    let parent = parentOf(norm);
    while (parent !== "/") {
      if (!afterMap.has(parent)) afterMap.set(parent, { path: parent, isDir: true, content: "" });
      parent = parentOf(parent);
    }
  }

  let changed = false;
  const toInsert: Entry[] = [];
  const toUpdate: Entry[] = [];

  for (const [path, item] of afterMap) {
    const prev = beforeMap.get(path);
    if (!prev) {
      toInsert.push(item);
      changed = true;
    } else if (!prev.isDir && !item.isDir && prev.content !== item.content) {
      toUpdate.push(item);
      changed = true;
    }
  }

  const toDelete: string[] = [];
  if (explicitDelete) {
    for (const prev of before) {
      // Never auto-purge package trees that may have been skipped by Bash upload caps
      if (isPkgPath(prev.path)) continue;
      if (!afterMap.has(prev.path)) {
        toDelete.push(prev.path);
        changed = true;
      }
    }
  }

  if (before.length + toInsert.length - toDelete.length > MAX_ENTRIES) {
    toInsert.splice(Math.max(0, MAX_ENTRIES - before.length + toDelete.length));
  }

  if (toInsert.length) {
    await db.insert(workspaceFiles).values(
      toInsert.map((item) => ({ workspaceId, path: item.path, isDir: item.isDir, content: item.content })),
    );
  }
  for (const item of toUpdate) {
    await db.update(workspaceFiles).set({ content: item.content, updatedAt: new Date() })
      .where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.path, item.path)));
  }
  for (const path of toDelete) {
    await db.delete(workspaceFiles)
      .where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.path, path)));
  }

  return changed;
}

type ChainSegment = { cmd: string; op: "&&" | ";" | null };

/** Splits top-level `&&` and `;` outside quotes, backticks, subshells, and heredocs. */
function splitCompoundCommand(line: string, bare: string): ChainSegment[] {
  if (/<<\s*['"]?[A-Za-z0-9_-]+/.test(bare)) return [{ cmd: line.trim(), op: null }];
  const segments: ChainSegment[] = [];
  let quote: "'" | '"' | null = null;
  let inBacktick = false;
  let parenDepth = 0;
  let start = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (inBacktick) { if (ch === "`") inBacktick = false; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "`") { inBacktick = true; continue; }
    if (ch === "(") { parenDepth++; continue; }
    if (ch === ")" && parenDepth > 0) { parenDepth--; continue; }
    if (parenDepth > 0) continue;

    if (ch === "&" && line[i + 1] === "&") {
      const cmd = line.slice(start, i).trim();
      if (cmd) segments.push({ cmd, op: "&&" });
      i++;
      start = i + 1;
      continue;
    }
    if (ch === ";") {
      const cmd = line.slice(start, i).trim();
      if (cmd) segments.push({ cmd, op: ";" });
      start = i + 1;
    }
  }
  const tail = line.slice(start).trim();
  if (tail) segments.push({ cmd: tail, op: null });
  return segments.length ? segments : [{ cmd: line.trim(), op: null }];
}

const HYBRID_HEAD_RE = /^(?:cd|pwd|mkdir|touch|write|append|calc|pip3?|npm|git|curl|wget|python3?|py|nodejs?|sqlite3?|apt(?:-get)?|apk|brew|yum|dnf)\b/i;

export async function runTerminal(options: { workspaceId: string; command: string; explicitDelete: boolean; _noSplit?: boolean }): Promise<TerminalResult> {
  const [workspace] = await db.select({ cwd: workspaces.terminalCwd }).from(workspaces).where(eq(workspaces.id, options.workspaceId)).limit(1);
  const cwd = workspace?.cwd || "/";
  const line = options.command.trim();
  if (!line) return { ok: true, output: "", cwd, changed: false, engine: "workspace" };
  if (line.length > 4000) return { ok: false, output: "That command is too long for the terminal.", cwd, changed: false, engine: "workspace" };

  const bare = unquotedText(line);

  // Guard AI deletion unless explicitly asked (checked up-front for both single and chained commands)
  if (!options.explicitDelete && /\brm\b/.test(bare)) {
    return { ok: false, output: "rm is only used when you explicitly ask to delete something. Tell me to delete it and I will.", cwd, changed: false, engine: "workspace" };
  }

  // Sequential chain execution when chaining hybrid commands (cd, pip, npm, git, curl, python3, node, sqlite3, etc.)
  if (!options._noSplit) {
    const chain = splitCompoundCommand(line, bare);
    if (chain.length > 1 && chain.some((seg) => HYBRID_HEAD_RE.test(seg.cmd))) {
      const outputs: string[] = [];
      let currentCwd = cwd;
      let anyChanged = false;
      const engines = new Set<string>();
      for (let i = 0; i < chain.length; i++) {
        const seg = chain[i];
        const res = await runTerminal({
          workspaceId: options.workspaceId,
          command: seg.cmd,
          explicitDelete: options.explicitDelete,
          _noSplit: true,
        });
        currentCwd = res.cwd;
        if (res.changed) anyChanged = true;
        if (res.engine && res.engine !== "workspace") engines.add(res.engine);
        if (res.output && res.output !== "(done)") outputs.push(res.output);
        if (!res.ok && seg.op === "&&") {
          return {
            ok: false,
            output: outputs.join("\n").slice(0, MAX_OUTPUT) || "Command chain failed.",
            cwd: currentCwd,
            changed: anyChanged,
            engine: [...engines].join(" · ") || "workspace",
          };
        }
      }
      return {
        ok: true,
        output: outputs.join("\n").slice(0, MAX_OUTPUT) || "(done)",
        cwd: currentCwd,
        changed: anyChanged,
        engine: [...engines].join(" · ") || "workspace",
      };
    }
  }

  const hasShellOps = /[|><;&`\n]|\$\(|<</.test(bare);

  // Instant built-in write/append (and plain echo without redirects/pipes)
  const verbatim = /^(write|append|echo)\s/i.exec(line);
  if (verbatim && !hasShellOps) {
    const name = verbatim[1].toLowerCase();
    let rest = line.slice(verbatim[0].length).trimStart();
    let pathArg = "";
    if (name !== "echo") {
      if (rest[0] === '"' || rest[0] === "'") {
        const quote = rest[0];
        let i = 1, out = "";
        let closed = false;
        while (i < rest.length) {
          const char = rest[i];
          if (char === "\\" && (rest[i + 1] === '"' || rest[i + 1] === "'" || rest[i + 1] === "\\")) { out += rest[i + 1]; i += 2; continue; }
          if (char === quote) { closed = true; i++; break; }
          out += char; i++;
        }
        if (!closed) return { ok: false, output: `${name}: the file path quote was never closed.`, cwd, changed: false, engine: "workspace" };
        pathArg = out.replace(/[:,]+$/, "").trim();
        rest = rest.slice(i).replace(/^\s*[,;:]\s*/, "");
      } else {
        const space = rest.search(/\s/);
        pathArg = (space === -1 ? rest : rest.slice(0, space)).replace(/[:,]+$/, "");
        rest = space === -1 ? "" : rest.slice(space + 1);
      }
      if (!pathArg) return { ok: false, output: `${name}: give a file path, such as notes/idea.txt.`, cwd, changed: false, engine: "workspace" };
    }
    let body = rest.trim();
    if (body.length >= 2 && ((body[0] === '"' && body.at(-1) === '"') || (body[0] === "'" && body.at(-1) === "'"))) body = body.slice(1, -1);
    body = body.replace(/\\(["'\\])/g, "$1");
    const res = await runWrite({ workspaceId: options.workspaceId, cwd, entries: await loadEntries(options.workspaceId), name, pathArg, body, explicitDelete: options.explicitDelete });
    return { ...res, engine: "workspace" };
  }

  const entries = await loadEntries(options.workspaceId);
  const words = hasShellOps ? null : tokenize(line);
  const name = words?.[0] ?? "";
  const rawArgs = words ? words.slice(1) : [];

  // Package managers & safe network tools (pure-Node, SSRF-guarded, persisted to workspace DB)
  if (!hasShellOps && words && words.length) {
    const isPyPip = (name === "python" || name === "python3" || name === "py") && rawArgs[0] === "-m" && (rawArgs[1] === "pip" || rawArgs[1] === "pip3");
    if (name === "pip" || name === "pip3" || isPyPip) {
      const pipArgs = isPyPip ? rawArgs.slice(2) : rawArgs;
      const sub = (pipArgs[0] || "").toLowerCase();
      if (sub === "install" || sub === "i") {
        let reqFile = "";
        const pkgs: string[] = [];
        for (let i = 1; i < pipArgs.length; i++) {
          const a = pipArgs[i];
          if ((a === "-r" || a === "--requirement") && pipArgs[i + 1]) { reqFile = pipArgs[++i]; continue; }
          if (a.startsWith("-")) continue;
          pkgs.push(a);
        }
        if (reqFile) {
          const normReq = normalize(cwd, reqFile);
          const reqEntry = normReq ? entries.find((e) => !e.isDir && e.path === normReq) : undefined;
          if (!reqEntry) return { ok: false, output: `pip: could not read requirements file "${reqFile}".`, cwd, changed: false, engine: "pip · pypi" };
          for (const lineItem of reqEntry.content.split("\n")) {
            const clean = lineItem.replace(/#.*$/, "").trim();
            if (clean) pkgs.push(clean);
          }
        }
        if (!pkgs.length) return { ok: false, output: "pip install: specify one or more package names, e.g. pip install tabulate", cwd, changed: false, engine: "pip · pypi" };
        const logs: string[] = [];
        let changed = false;
        let allOk = true;
        let currentEntries = entries;
        for (const pkg of pkgs.slice(0, 6)) {
          const res = await pipInstall(pkg);
          logs.push(res.output);
          if (!res.ok) { allOk = false; continue; }
          const saved = await upsertEntries(options.workspaceId, currentEntries, res.entries);
          if (saved.inserted + saved.updated > 0) {
            changed = true;
            currentEntries = await loadEntries(options.workspaceId);
          }
          if (saved.dropped > 0) logs.push(`Note: workspace limit reached; ${saved.dropped} extra files omitted.`);
        }
        return { ok: allOk, output: logs.join("\n").slice(0, MAX_OUTPUT), cwd, changed, engine: "pip · pypi" };
      }
      if (sub === "list" || sub === "freeze") {
        const mods = new Set<string>();
        for (const e of entries) {
          if (!e.path.startsWith("/site-packages/")) continue;
          const top = e.path.slice("/site-packages/".length).split("/")[0];
          if (top) mods.add(top.replace(/\.py$/, ""));
        }
        return { ok: true, output: mods.size ? `Installed in /site-packages:\n${[...mods].sort().join("\n")}` : "(no pip packages installed yet)", cwd, changed: false, engine: "pip · pypi" };
      }
      if (sub === "--version" || sub === "-V") {
        return { ok: true, output: "pip 24.3 (PyPI pure-Python wheel installer -> /site-packages)", cwd, changed: false, engine: "pip · pypi" };
      }
    }

    if (name === "npm") {
      const sub = (rawArgs[0] || "").toLowerCase();
      const pkgJsonPath = cwd === "/" ? "/package.json" : `${cwd}/package.json`;
      if (sub === "init") {
        const existing = entries.find((e) => !e.isDir && e.path === pkgJsonPath);
        if (existing) return { ok: true, output: `${pkgJsonPath} already exists.`, cwd, changed: false, engine: "npm · registry" };
        const pkgName = (cwd === "/" ? "workspace" : baseName(cwd)).toLowerCase().replace(/[^a-z0-9-_]/g, "-") || "app";
        const content = JSON.stringify({ name: pkgName, version: "1.0.0", main: "index.js", scripts: {}, dependencies: {} }, null, 2);
        await upsertEntries(options.workspaceId, entries, [{ path: pkgJsonPath, isDir: false, content }]);
        return { ok: true, output: `Wrote ${pkgJsonPath}:\n${content}`, cwd, changed: true, engine: "npm · registry" };
      }
      if (sub === "install" || sub === "i" || sub === "add") {
        const pkgs = rawArgs.slice(1).filter((a) => !a.startsWith("-"));
        let currentEntries = entries;
        if (!pkgs.length) {
          const pj = currentEntries.find((e) => !e.isDir && e.path === pkgJsonPath);
          if (!pj) return { ok: false, output: "npm install: specify a package name (e.g. npm install ms) or create package.json with npm init -y.", cwd, changed: false, engine: "npm · registry" };
          try {
            const parsed = JSON.parse(pj.content) as { dependencies?: Record<string, string> };
            pkgs.push(...Object.keys(parsed.dependencies ?? {}));
          } catch {
            return { ok: false, output: `npm: could not parse ${pkgJsonPath}.`, cwd, changed: false, engine: "npm · registry" };
          }
          if (!pkgs.length) return { ok: true, output: "up to date (no dependencies listed in package.json).", cwd, changed: false, engine: "npm · registry" };
        }
        const logs: string[] = [];
        let changed = false;
        let allOk = true;
        const addedDeps: Record<string, string> = {};
        for (const pkg of pkgs.slice(0, 6)) {
          const res = await npmInstall(pkg, cwd);
          logs.push(res.output);
          if (!res.ok) { allOk = false; continue; }
          const saved = await upsertEntries(options.workspaceId, currentEntries, res.entries);
          if (saved.inserted + saved.updated > 0) {
            changed = true;
            currentEntries = await loadEntries(options.workspaceId);
          }
          const verMatch = /added\s+@?[^@\s]+@([^\s(]+)/.exec(res.output);
          addedDeps[pkg.replace(/(?!^)@.*$/, "")] = verMatch ? `^${verMatch[1]}` : "latest";
          if (saved.dropped > 0) logs.push(`Note: workspace limit reached; ${saved.dropped} extra files omitted.`);
        }
        const pj = currentEntries.find((e) => !e.isDir && e.path === pkgJsonPath);
        if (pj && Object.keys(addedDeps).length) {
          try {
            const parsed = JSON.parse(pj.content) as { dependencies?: Record<string, string> };
            parsed.dependencies = { ...(parsed.dependencies ?? {}), ...addedDeps };
            await upsertEntries(options.workspaceId, currentEntries, [{ path: pkgJsonPath, isDir: false, content: JSON.stringify(parsed, null, 2) }]);
            changed = true;
          } catch {
            // Keep existing invalid package.json untouched
          }
        }
        return { ok: allOk, output: logs.join("\n").slice(0, MAX_OUTPUT), cwd, changed, engine: "npm · registry" };
      }
      if (sub === "list" || sub === "ls") {
        const prefix = cwd === "/" ? "/node_modules/" : `${cwd}/node_modules/`;
        const mods = new Set<string>();
        for (const e of entries) {
          const matchPrefix = e.path.startsWith(prefix) ? prefix : e.path.startsWith("/node_modules/") ? "/node_modules/" : "";
          if (!matchPrefix) continue;
          const rest = e.path.slice(matchPrefix.length).split("/");
          if (!rest[0]) continue;
          mods.add(rest[0].startsWith("@") && rest[1] ? `${rest[0]}/${rest[1]}` : rest[0]);
        }
        return { ok: true, output: mods.size ? `Installed packages:\n${[...mods].sort().join("\n")}` : "(no npm packages installed yet)", cwd, changed: false, engine: "npm · registry" };
      }
      if (sub === "run" && rawArgs[1]) {
        const pj = entries.find((e) => !e.isDir && e.path === pkgJsonPath);
        if (!pj) return { ok: false, output: `npm run: missing ${pkgJsonPath}.`, cwd, changed: false, engine: "npm · registry" };
        try {
          const parsed = JSON.parse(pj.content) as { scripts?: Record<string, string> };
          const scriptCmd = parsed.scripts?.[rawArgs[1]];
          if (!scriptCmd) return { ok: false, output: `npm ERR! Missing script: "${rawArgs[1]}"`, cwd, changed: false, engine: "npm · registry" };
          return runTerminal({ workspaceId: options.workspaceId, command: scriptCmd, explicitDelete: options.explicitDelete });
        } catch {
          return { ok: false, output: `npm run: invalid JSON in ${pkgJsonPath}.`, cwd, changed: false, engine: "npm · registry" };
        }
      }
    }

    if (name === "git") {
      const sub = (rawArgs[0] || "").toLowerCase();
      if (sub === "clone" && rawArgs[1]) {
        const res = await gitClone(rawArgs[1], cwd, rawArgs[2]);
        if (!res.ok) return { ok: false, output: res.output, cwd, changed: false, engine: "git · github" };
        const saved = await upsertEntries(options.workspaceId, entries, res.entries);
        return {
          ok: true,
          output: saved.dropped ? `${res.output}\nNote: workspace limit reached; ${saved.dropped} extra files omitted.` : res.output,
          cwd,
          changed: saved.inserted + saved.updated > 0,
          engine: "git · github",
        };
      }
    }

    if (name === "curl" || name === "wget") {
      const mappedArgs = name === "wget"
        ? rawArgs.map((arg) => (arg === "-O" ? "-o" : arg))
        : rawArgs;
      try {
        const res = await runSafeCurl(mappedArgs, cwd);
        let changed = false;
        if (res.saveTo && res.content !== undefined) {
          const saved = await upsertEntries(options.workspaceId, entries, [{ path: res.saveTo, isDir: false, content: res.content }]);
          changed = saved.inserted + saved.updated > 0;
        }
        return { ok: res.ok, output: res.output.slice(0, MAX_OUTPUT), cwd, changed, engine: "curl · network" };
      } catch (err) {
        return { ok: false, output: `${name}: ${err instanceof Error ? err.message : String(err)}`, cwd, changed: false, engine: "curl · network" };
      }
    }

    if (name === "apt" || name === "apt-get" || name === "apk" || name === "brew" || name === "yum" || name === "dnf") {
      return {
        ok: false,
        output: `${name}: Cloud Sandbox is an ephemeral serverless sandbox where system root packages (${name}) aren't persisted across runs.\n• Use pip install <pkg>, npm install <pkg>, curl <url>, git clone <url>, python3, node, sqlite3, or gcc right here.\n• Or click the "Direct Linux VM" tab at the top of the Terminal drawer for a full root Alpine / Debian Linux VM with real apk / apt!`,
        cwd,
        changed: false,
        engine: "workspace",
      };
    }
  }

  const SIMPLE_LOCAL = new Set(["help", "pwd", "date", "echo", "calc", "ls", "tree", "stat", "cd", "mkdir", "cat", "head", "wc", "touch", "grep", "rm"]);
  const KNOWN_FLAGS = new Set(["-p", "--parents", "-r", "-R", "--recursive", "-f", "--force", "-rf", "-a", "--all"]);
  const hasUnknownFlags = rawArgs.some((arg) => arg.startsWith("-") && !KNOWN_FLAGS.has(arg));

  // Route Linux tools, pipelines, redirects, chains, flags (-la, -n, etc.), Python, Node, SQLite to the keyless remote server
  if (hasShellOps || !words || !words.length || !SIMPLE_LOCAL.has(name) || hasUnknownFlags) {
    const remote = await runRemoteTerminal({ command: line, cwd, entries });
    let changed = false;
    let nextCwd = cwd;
    if (remote.syncedEntries) {
      const synced = await syncRemoteEntries({
        workspaceId: options.workspaceId,
        before: entries,
        after: remote.syncedEntries,
        explicitDelete: options.explicitDelete,
      });
      if (synced) changed = true;
    }
    if (remote.cwd && remote.cwd !== cwd) {
      const validCwd = normalize("/", remote.cwd);
      if (validCwd) {
        await db.update(workspaces).set({ terminalCwd: validCwd }).where(eq(workspaces.id, options.workspaceId));
        nextCwd = validCwd;
        changed = true;
      }
    }
    return {
      ok: remote.ok,
      output: remote.output.slice(0, MAX_OUTPUT),
      cwd: nextCwd,
      changed,
      engine: remote.engine,
    };
  }

  const args = ["mkdir", "rm", "ls", "cd", "cat", "head", "wc"].includes(name) ? rawArgs.filter((arg, index) => !(index === 0 && KNOWN_FLAGS.has(arg))) : rawArgs;
  const fail = (output: string) => ({ ok: false, output, cwd, changed: false, engine: "workspace" });
  const done = (output: string, changed = false) => ({ ok: true, output: output.slice(0, MAX_OUTPUT), cwd, changed, engine: "workspace" });

  const exists = (path: string) => path === "/" || entries.some((entry) => entry.path === path);
  const find = (path: string) => entries.find((entry) => entry.path === path);

  switch (name) {
    case "help": return done(HELP);
    case "pwd": return done(cwd);
    case "date": return done(new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC");
    case "echo": return done(args.join(" "));
    case "calc": {
      const { evaluate } = await import("@/lib/calc");
      try { return done(String(evaluate(args.join(" ")))); } catch (error) { return fail(error instanceof Error ? error.message : "Could not calculate that."); }
    }
    case "ls": {
      const target = args[0] ? normalize(cwd, args[0]) : cwd;
      if (!target) return fail("Use a plain folder name, such as ls notes or ls /.");
      if (!exists(target) || (target !== "/" && !find(target)?.isDir)) return fail(`ls: ${args[0] ?? cwd}: no such folder`);
      const list = children(entries, target);
      return done(list.length ? list.map((entry) => `${baseName(entry.path)}${entry.isDir ? "/" : ""}`).join("\n") : "(empty folder)");
    }
    case "tree": {
      const target = args[0] ? normalize(cwd, args[0]) : cwd;
      if (!target) return fail("tree: use a plain folder name.");
      if (!(target === "/" || exists(target))) return fail(`tree: ${args[0] ?? cwd}: no such folder`);
      const dirs = entries.filter((entry) => entry.isDir).map((entry) => entry.path);
      const lines: string[] = [];
      const walk = (folder: string, prefix: string) => {
        if (lines.length >= 200) return;
        const kids = children(entries, folder);
        kids.forEach((entry, index) => {
          const last = index === kids.length - 1;
          lines.push(`${prefix}${last ? "└── " : "├── "}${baseName(entry.path)}${entry.isDir ? "/" : ""}`);
          if (entry.isDir) walk(entry.path, prefix + (last ? "    " : "│   "));
        });
      };
      lines.push(`${target}/`);
      walk(target, "");
      return done(lines.join("\n") || "(empty)");
    }
    case "stat": {
      const target = args[0] ? normalize(cwd, args[0]) : null;
      if (!target) return fail("stat: give a file or folder path.");
      if (target === "/") return done(`/  directory  ${dirsCount(entries, "/")} entries`);
      const entry = find(target);
      if (!entry) return fail(`stat: ${args[0]}: no such file or folder`);
      if (entry.isDir) return done(`${target}  directory  ${dirsCount(entries, target)} entries`);
      return done(`${target}\n  file  ${entry.content.length} characters  last change: ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`);
    }
    case "cd": {
      const target = args[0] ? normalize(cwd, args[0]) : "/";
      if (!target) return fail("cd: use a plain folder name.");
      if (!(target === "/" || find(target)?.isDir)) return fail(`cd: ${args[0] ?? "/"}: no such folder`);
      await db.update(workspaces).set({ terminalCwd: target }).where(eq(workspaces.id, options.workspaceId));
      return { ok: true, output: target, cwd: target, changed: true };
    }
    case "mkdir": {
      if (!args.length) return fail("mkdir: give a folder name.");
      const targets = args.map((arg) => normalize(cwd, arg));
      if (targets.some((target) => !target || target === "/")) return fail("mkdir: that name is not allowed.");
      const toCreate = new Set<string>();
      for (const target of targets as string[]) {
        const parts = target.split("/").filter(Boolean);
        for (let index = 1; index <= parts.length; index++) {
          const path = `/${parts.slice(0, index).join("/")}`;
          const existing = find(path);
          if (existing && !existing.isDir) return fail(`mkdir: ${path} is a file.`);
          if (!existing) toCreate.add(path);
        }
      }
      if (entries.length + toCreate.size > MAX_ENTRIES) return fail("This workspace has reached its file limit. Delete something first.");
      if (toCreate.size) await db.insert(workspaceFiles).values([...toCreate].map((path) => ({ workspaceId: options.workspaceId, path, isDir: true, content: "" })));
      return done(toCreate.size ? `Created ${[...toCreate].join(", ")}` : "Folder already exists.", toCreate.size > 0);
    }
    case "cat":
    case "head":
    case "wc": {
      const target = args[0] ? normalize(cwd, args[0]) : null;
      if (!target) return fail(`${name}: give a file path.`);
      const file = find(target);
      if (!file || file.isDir) return fail(`${name}: ${args[0]}: no such file`);
      if (name === "cat") return done(file.content || "(empty file)");
      if (name === "head") {
        const count = Math.min(200, Math.max(1, Number(args[1]) || 10));
        return done(file.content.split("\n").slice(0, count).join("\n"));
      }
      const lines = file.content ? file.content.split("\n").length : 0;
      const words = file.content.split(/\s+/).filter(Boolean).length;
      return done(`${lines} lines, ${words} words, ${file.content.length} characters  ${target}`);
    }
    case "touch": {
      const target = args[0] ? normalize(cwd, args[0]) : null;
      if (!target || target === "/") return fail(`touch: give a file path, such as notes/idea.txt`);
      if (find(target)?.isDir) return fail(`touch: ${args[0]} is a folder.`);
      const current = find(target)?.content ?? "";
      const next = current;
      if (next.length > MAX_FILE_CHARS) return fail("That file would be too large. Keep files under 100,000 characters.");
      const folders = new Set<string>();
      let folder = parentOf(target);
      while (folder !== "/") { if (!exists(folder)) folders.add(folder); folder = parentOf(folder); }
      const creating = !find(target);
      if (entries.length + folders.size + (creating ? 1 : 0) > MAX_ENTRIES) return fail("This workspace has reached its file limit. Delete something first.");
      if (folders.size) await db.insert(workspaceFiles).values([...folders].map((path) => ({ workspaceId: options.workspaceId, path, isDir: true, content: "" })));
      if (creating) await db.insert(workspaceFiles).values({ workspaceId: options.workspaceId, path: target, isDir: false, content: next });
      else await db.update(workspaceFiles).set({ content: next, updatedAt: new Date() }).where(and(eq(workspaceFiles.workspaceId, options.workspaceId), eq(workspaceFiles.path, target)));
      return done(`${creating ? "Created" : "Saved"} ${target} (${next.length} characters)`, true);
    }
    case "grep": {
      if (args.length < 2) return fail("grep: use grep <text> <file or folder>.");
      const needle = args[0].toLowerCase();
      const target = normalize(cwd, args[1]);
      if (!target) return fail("grep: give a valid path.");
      const files = target === "/" ? entries.filter((e) => !e.isDir) : entries.filter((e) => !e.isDir && (e.path === target || isUnder(e.path, target)));
      if (!files.length) return fail(`grep: ${args[1]}: no such file or folder`);
      const hits: string[] = [];
      for (const file of files) {
        file.content.split("\n").forEach((text, index) => { if (text.toLowerCase().includes(needle)) hits.push(`${file.path}:${index + 1}: ${text.slice(0, 200)}`); });
      }
      return done(hits.length ? hits.slice(0, 100).join("\n") : "No matches.");
    }
    case "rm": {
      const target = args[0] ? normalize(cwd, args[0]) : null;
      if (!target || target === "/") return fail("rm: give a file or folder path.");
      if (!options.explicitDelete) return fail("rm is only used when you explicitly ask to delete something. Tell me to delete it and I will.");
      const item = find(target);
      if (!item) return fail(`rm: ${args[0]}: no such file or folder`);
      if (item.isDir && children(entries, target).length) return fail(`rm: ${target} is not empty. Remove its files first.`);
      await db.delete(workspaceFiles).where(and(eq(workspaceFiles.workspaceId, options.workspaceId), eq(workspaceFiles.path, target)));
      return done(`Deleted ${target}`, true);
    }
    default:
      return fail(`${name}: command not found. Type help to see what's available.`);
  }
}
