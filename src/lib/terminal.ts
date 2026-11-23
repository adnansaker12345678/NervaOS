import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceFiles, workspaces } from "@/db/schema";

/**
 * Aura's terminal is a sandboxed, virtual shell. It never starts a process and
 * never touches the server's filesystem. Every command reads and writes only
 * this workspace's own rows in PostgreSQL, using an explicit allowlist.
 */

export const MAX_OUTPUT = 6000;
const MAX_FILE_CHARS = 100_000;
const MAX_ENTRIES = 500;
const MAX_LINE = 400;

type Entry = { path: string; isDir: boolean; content: string };
export type TerminalResult = { ok: boolean; output: string; cwd: string; changed: boolean };

const HELP = `Aura terminal — a private, sandboxed workspace shell (no server access)
  help                       show this list
  pwd                        print the current folder
  ls [path]                  list a folder (folders end with /)
  cd [path]                  change folder ( .. and / work )
  mkdir <path>               create a folder (parents are created too)
  cat <path>                 show a file
  head <path> [lines]        first lines of a file
  wc <path>                  lines, words, and characters
  write <path> <text>        create or overwrite a file (\\n makes a new line)
  append <path> <text>       add text to the end of a file
  touch <path>               create an empty file if missing
  grep <text> <path>         find lines containing text (file or folder)
  rm <path>                  delete a file or empty folder (only when you ask to delete)
  echo <text>                print text
  date                       current UTC date and time
  calc <expression>          exact arithmetic, e.g. calc (12+8)*3.5
Quoted words keep spaces: write /notes/idea.txt "Hello world"
Pipes (|), redirects (>), chaining (&&, ;) and $() are not available.`;

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
  if (!input || input.length > 200 || /[\0\\]/.test(input)) return null;
  const start = input.startsWith("/") ? "" : cwd;
  const parts: string[] = [];
  for (const segment of `${start}/${input}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { parts.pop(); continue; }
    if (!/^[\w.\- ]{1,80}$/.test(segment) || segment.startsWith(".")) return null;
    parts.push(segment);
  }
  if (parts.length > 12) return null;
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

export async function runTerminal(options: { workspaceId: string; command: string; explicitDelete: boolean }): Promise<TerminalResult> {
  const [workspace] = await db.select({ cwd: workspaces.terminalCwd }).from(workspaces).where(eq(workspaces.id, options.workspaceId)).limit(1);
  let cwd = workspace?.cwd || "/";
  const line = options.command.trim();
  if (!line) return { ok: true, output: "", cwd, changed: false };
  if (line.length > 1000) return { ok: false, output: "That command is too long for the terminal.", cwd, changed: false };
  // write/append/echo take free-form text: everything after the path is content,
  // verbatim. Quotes inside the text (apostrophes, HTML) must not break parsing,
  // and since the text is only stored or shown — never executed — no guard applies.
  const verbatim = /^(write|append|echo)\s/i.exec(line);
  if (verbatim) {
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
        if (!closed) return { ok: false, output: `${name}: the file path quote was never closed.`, cwd, changed: false };
        pathArg = out.replace(/[:,]+$/, "").trim();
        rest = rest.slice(i).replace(/^\s*[,;:]\s*/, "");
      } else {
        const space = rest.search(/\s/);
        pathArg = (space === -1 ? rest : rest.slice(0, space)).replace(/[:,]+$/, "");
        rest = space === -1 ? "" : rest.slice(space + 1);
      }
      if (!pathArg) return { ok: false, output: `${name}: give a file path, such as notes/idea.txt.`, cwd, changed: false };
    }
    let body = rest.trim();
    // Unwrap one layer of matching quotes, then unescape quotes (\n stays for the newline step).
    if (body.length >= 2 && ((body[0] === '"' && body.at(-1) === '"') || (body[0] === "'" && body.at(-1) === "'"))) body = body.slice(1, -1);
    body = body.replace(/\\(["'\\])/g, "$1");
    return runWrite({ workspaceId: options.workspaceId, cwd, entries: await loadEntries(options.workspaceId), name, pathArg, body, explicitDelete: options.explicitDelete });
  }
  // Shell metacharacters are only dangerous outside quotes: quoted text is saved verbatim,
  // so write page.html "<b>hi</b>" works while cat a | wc stays blocked.
  let quoted: "'" | '"' | null = null;
  let bare = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\" && (line[i + 1] === '"' || line[i + 1] === "'" || line[i + 1] === "\\")) { i++; continue; }
    if (quoted) { if (char === quoted) quoted = null; continue; }
    if (char === "'" || char === '"') { quoted = char; continue; }
    bare += char;
  }
  if (/[|><;&`]|\$\(/.test(bare)) {
    return { ok: false, output: "Pipes (|), redirects (>), chaining (&&, ;), and command substitution are not available. If < > | & are part of your text, wrap it in quotes: write notes/page.html \"<b>hi</b>\".", cwd, changed: false };
  }
  const words = tokenize(line);
  if (!words || !words.length) return { ok: false, output: "Unclosed quotes in the command.", cwd, changed: false };
  const [name, ...rawArgs] = words;
  // Agents habitually type real-shell flags; ours need none (parents are always created).
  const KNOWN_FLAGS = new Set(["-p", "--parents", "-r", "-R", "--recursive", "-f", "--force", "-rf", "-l", "-a", "-la", "-al", "-h", "--all", "-n", "--human-readable"]);
  const args = ["mkdir", "rm", "ls", "cd", "cat", "head", "wc"].includes(name) ? rawArgs.filter((arg, index) => !(index === 0 && KNOWN_FLAGS.has(arg))) : rawArgs;
  const fail = (output: string) => ({ ok: false, output, cwd, changed: false });
  const done = (output: string, changed = false) => ({ ok: true, output: output.slice(0, MAX_OUTPUT), cwd, changed });

  const entries = await loadEntries(options.workspaceId);
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
