import "server-only";
import { randomUUID } from "node:crypto";

/**
 * Keyless remote virtual Linux terminal engine pool.
 *
 * Rotates automatically across free, zero-key cloud execution servers:
 *   1. Wandbox (wandbox.org) — Ubuntu x86_64 Linux container (bash, Python, Node, TypeScript, C/C++, Go, Rust, SQLite)
 *   2. Paiza.io (api.paiza.io, public guest runner) — Ubuntu aarch64 Linux container (bash, Python, Node, etc.)
 *   3. Codapi (api.codapi.org) — Cloud sandbox fallback for Python, SQLite, Go, Rust, Ruby, PHP, Lua
 *
 * Host isolation: Aura's Next.js server never spawns local OS shells or reads host files/env vars.
 */

export type RemoteWorkspaceEntry = {
  path: string;
  isDir: boolean;
  content: string;
};

export type RemoteExecResult = {
  ok: boolean;
  output: string;
  engine: string;
  cwd?: string;
  syncedEntries?: RemoteWorkspaceEntry[];
};

const TIMEOUT_MS = 14_000;
const MAX_UPLOAD_FILES = 80;
const MAX_UPLOAD_TOTAL_CHARS = 180_000;
const MAX_CODE_FILES = 140;
const MAX_CODE_TOTAL_CHARS = 650_000;
const MAX_CODE_FILE_CHARS = 300_000;
const MAX_SYNC_FILE_CHARS = 300_000;
const MAX_OUTPUT_CHARS = 6000;

const cooldowns = new Map<string, number>();

function isCooling(name: string): boolean {
  const until = cooldowns.get(name) ?? 0;
  return Date.now() < until;
}

function setCooldown(name: string, ms = 90_000): void {
  cooldowns.set(name, Date.now() + ms);
}

export function terminalEngineInfo() {
  return {
    keyless: true,
    engines: [
      { id: "wandbox", label: "Wandbox · Ubuntu Linux", available: !isCooling("wandbox") },
      { id: "paiza", label: "Paiza.io · Ubuntu Linux", available: !isCooling("paiza") },
      { id: "codapi", label: "Codapi · Cloud Sandbox", available: !isCooling("codapi") },
    ],
  };
}

function safeRelPath(path: string): string | null {
  if (!path || !path.startsWith("/")) return null;
  const trimmed = path.slice(1);
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  if (!parts.length || parts.length > 14) return null;
  for (const part of parts) {
    if (part === "." || part === ".." || part.startsWith(".")) return null;
    if (!/^[\w.\- @]{1,90}$/.test(part)) return null;
  }
  return parts.join("/");
}

const isPkgEntryPath = (path: string) =>
  path === "/site-packages" || path.startsWith("/site-packages/") || path === "/node_modules" || /(?:^|\/)node_modules(?:\/|$)/.test(path);

/** Builds a POSIX bash wrapper that materializes workspace files, runs user command, and emits a nonce-guarded workspace diff. */
function buildBashScript(options: {
  command: string;
  cwd: string;
  entries: RemoteWorkspaceEntry[];
  nonce: string;
}): string {
  const { command, cwd, entries, nonce } = options;
  const relCwd = safeRelPath(cwd) ?? "";
  const lines: string[] = [
    `WS_ROOT="/tmp/aura_ws_$$"`,
    `mkdir -p "$WS_ROOT"`,
    `WS_ROOT=$(cd "$WS_ROOT" && pwd -P 2>/dev/null || printf '%s' "$WS_ROOT")`,
  ];

  if (relCwd) {
    lines.push(`mkdir -p "$WS_ROOT/${relCwd}"`);
  }

  for (const entry of entries) {
    if (!entry.isDir) continue;
    const rel = safeRelPath(entry.path);
    if (rel) lines.push(`mkdir -p "$WS_ROOT/${rel}"`);
  }

  // Prioritize user workspace files before package files so installed libs don't evict user scripts in Bash
  const orderedFiles = [
    ...entries.filter((e) => !e.isDir && !isPkgEntryPath(e.path)),
    ...entries.filter((e) => !e.isDir && isPkgEntryPath(e.path)),
  ];

  let totalChars = 0;
  let count = 0;
  for (const entry of orderedFiles) {
    if (count >= MAX_UPLOAD_FILES) break;
    if (entry.content.length > 40_000 || totalChars + entry.content.length > MAX_UPLOAD_TOTAL_CHARS) continue;
    const rel = safeRelPath(entry.path);
    if (!rel) continue;
    totalChars += entry.content.length;
    count++;
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    if (parent) lines.push(`mkdir -p "$WS_ROOT/${parent}"`);
    const b64 = Buffer.from(entry.content, "utf8").toString("base64");
    lines.push(`printf '%s' '${b64}' | base64 -d > "$WS_ROOT/${rel}"`);
  }

  const cmdB64 = Buffer.from(command, "utf8").toString("base64");
  const startDir = relCwd ? `"$WS_ROOT/${relCwd}"` : `"$WS_ROOT"`;
  lines.push(
    `cd ${startDir} 2>/dev/null || cd "$WS_ROOT"`,
    `export HOME="$WS_ROOT"`,
    `printf '%s' '${cmdB64}' | base64 -d > "/tmp/aura_cmd_$$.sh"`,
    `bash "/tmp/aura_cmd_$$.sh"`,
    `__AURA_RC=$?`,
    `__AURA_NEW_PWD=$(pwd -P 2>/dev/null || pwd)`,
    `printf '\\n__AURA_SYNC_${nonce}__\\n'`,
    `printf 'CWD:%s\\n' "$__AURA_NEW_PWD"`,
    `printf 'ROOT:%s\\n' "$WS_ROOT"`,
    `if [ -d "$WS_ROOT" ]; then`,
    `  find "$WS_ROOT" -maxdepth 12 -type d 2>/dev/null | while IFS= read -r d; do`,
    `    rel="\${d#"$WS_ROOT"}"`,
    `    [ -n "$rel" ] && printf 'D:%s\\n' "$rel"`,
    `  done`,
    `  find "$WS_ROOT" -maxdepth 12 -type f -size -${MAX_SYNC_FILE_CHARS}c 2>/dev/null | head -n 120 | while IFS= read -r f; do`,
    `    rel="\${f#"$WS_ROOT"}"`,
    `    b64=$(base64 < "$f" 2>/dev/null | tr -d '\\n')`,
    `    printf 'F:%s:%s\\n' "$rel" "$b64"`,
    `  done`,
    `fi`,
    `printf '__AURA_SYNC_END_${nonce}__\\n'`,
    `rm -rf "$WS_ROOT" "/tmp/aura_cmd_$$.sh" 2>/dev/null || true`,
    `exit $__AURA_RC`,
  );
  return lines.join("\n");
}

function parseBashSyncOutput(rawOutput: string, nonce: string, fallbackCwd: string): {
  cleanOutput: string;
  cwd: string;
  syncedEntries?: RemoteWorkspaceEntry[];
} {
  const startMarker = `__AURA_SYNC_${nonce}__`;
  const endMarker = `__AURA_SYNC_END_${nonce}__`;
  const startIdx = rawOutput.indexOf(startMarker);
  const endIdx = rawOutput.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { cleanOutput: rawOutput.trimEnd(), cwd: fallbackCwd };
  }

  const before = rawOutput.slice(0, startIdx).replace(/\n$/, "");
  const after = rawOutput.slice(endIdx + endMarker.length).trim();
  const cleanOutput = [before, after].filter(Boolean).join("\n").trimEnd();
  const block = rawOutput.slice(startIdx + startMarker.length, endIdx);

  let reportedPwd = "";
  let reportedRoot = "";
  const parsedEntries: RemoteWorkspaceEntry[] = [];

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("CWD:")) {
      reportedPwd = trimmed.slice(4).trim();
    } else if (trimmed.startsWith("ROOT:")) {
      reportedRoot = trimmed.slice(5).trim();
    } else if (trimmed.startsWith("D:")) {
      const rel = safeRelPath(trimmed.slice(2));
      if (rel) parsedEntries.push({ path: `/${rel}`, isDir: true, content: "" });
    } else if (trimmed.startsWith("F:")) {
      const rest = trimmed.slice(2);
      const colon = rest.indexOf(":");
      if (colon <= 0) continue;
      const rawPath = rest.slice(0, colon);
      const b64 = rest.slice(colon + 1);
      const rel = safeRelPath(rawPath);
      if (!rel) continue;
      try {
        const content = Buffer.from(b64, "base64").toString("utf8");
        if (content.length <= MAX_SYNC_FILE_CHARS && !content.includes("\0")) {
          parsedEntries.push({ path: `/${rel}`, isDir: false, content });
        }
      } catch {
        // Ignore unparseable entries
      }
    }
  }

  let nextCwd = fallbackCwd;
  if (reportedRoot && reportedPwd.startsWith(reportedRoot)) {
    const suffix = reportedPwd.slice(reportedRoot.length);
    if (!suffix || suffix === "/") nextCwd = "/";
    else {
      const rel = safeRelPath(suffix);
      if (rel) nextCwd = `/${rel}`;
    }
  }

  return {
    cleanOutput,
    cwd: nextCwd,
    syncedEntries: parsedEntries,
  };
}

/** Calls Wandbox compile.json (free, keyless Ubuntu Linux container). */
async function callWandbox(payload: {
  compiler: string;
  code: string;
  codes?: { file: string; code: string }[];
  options?: string;
}): Promise<{ ok: boolean; output: string }> {
  const response = await fetch("https://wandbox.org/api/compile.json", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Wandbox HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    status?: string;
    signal?: string;
    compiler_output?: string;
    compiler_error?: string;
    program_output?: string;
    program_error?: string;
    program_message?: string;
  };
  const statusOk = data.status === "0" && !data.signal;
  const mainOut = data.program_output || (!data.compiler_error && !data.program_error ? data.program_message : "") || "";
  const parts = [
    data.compiler_output?.trim(),
    data.compiler_error?.trim(),
    mainOut,
    data.program_error && !mainOut.includes(data.program_error) ? data.program_error : "",
  ].filter((part): part is string => Boolean(part && part.length));
  const combined = parts.join("\n") || (data.signal ? `Terminated by signal: ${data.signal}` : "");
  return { ok: statusOk, output: combined };
}

/** Calls Paiza.io community runner (free, keyless Ubuntu Linux container). */
async function callPaiza(language: string, sourceCode: string): Promise<{ ok: boolean; output: string }> {
  const body = new URLSearchParams({
    source_code: sourceCode,
    language,
    api_key: "guest",
  });
  const createRes = await fetch("https://api.paiza.io/runners/create", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!createRes.ok) {
    throw new Error(`Paiza HTTP ${createRes.status}`);
  }
  const created = (await createRes.json()) as { id?: string; error?: string };
  if (!created.id) {
    throw new Error(created.error || "Paiza did not return a runner id");
  }

  for (let attempt = 0; attempt < 18; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 3 ? 550 : 750));
    const detailRes = await fetch(
      `https://api.paiza.io/runners/get_details?id=${encodeURIComponent(created.id)}&api_key=guest`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!detailRes.ok) continue;
    const detail = (await detailRes.json()) as {
      status?: string;
      build_stdout?: string | null;
      build_stderr?: string | null;
      build_exit_code?: string | null;
      stdout?: string | null;
      stderr?: string | null;
      exit_code?: string | null;
      result?: string | null;
    };
    if (detail.status === "completed") {
      const ok = (detail.exit_code === "0" || detail.exit_code === null) && detail.result !== "failure" && detail.result !== "timeout";
      const parts = [detail.build_stdout, detail.build_stderr, detail.stdout, detail.stderr]
        .filter((part): part is string => Boolean(part && part.trim().length));
      return { ok, output: parts.join("\n") };
    }
  }
  throw new Error("Paiza execution timed out");
}

/** Calls Codapi cloud sandbox (free, keyless). */
async function callCodapi(sandbox: string, files: Record<string, string>): Promise<{ ok: boolean; output: string }> {
  const response = await fetch("https://api.codapi.org/v1/exec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sandbox, command: "run", files }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codapi HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
  }
  const data = (await response.json()) as { ok?: boolean; stdout?: string; stderr?: string };
  const output = [data.stdout, data.stderr].filter((part): part is string => Boolean(part && part.length)).join("\n");
  return { ok: Boolean(data.ok), output };
}

type RuntimeIntent =
  | { kind: "python"; code: string; label: string }
  | { kind: "node"; code: string; label: string }
  | { kind: "sqlite"; code: string; label: string }
  | { kind: "bash" };

function parseUnquotedFlagValue(rest: string, flags: string[]): string | null {
  const trimmed = rest.trim();
  for (const flag of flags) {
    if (!trimmed.startsWith(flag)) continue;
    const after = trimmed.slice(flag.length).trim();
    if (!after) return null;
    if ((after.startsWith('"') && after.endsWith('"')) || (after.startsWith("'") && after.endsWith("'"))) {
      return after.slice(1, -1).replace(/\\(["'\\])/g, "$1").replace(/\\n/g, "\n");
    }
    return after;
  }
  return null;
}

/** Detects clean single-runtime CLI invocations (python3, node, sqlite3) so they route to dedicated cloud runtimes. */
function detectRuntimeIntent(command: string, cwd: string, entries: RemoteWorkspaceEntry[]): RuntimeIntent {
  const trimmed = command.trim();
  // Leave pipelines, chaining, redirects, or subshells to Bash
  if (/[|><;&`]|\$\(|<<|\n/.test(trimmed)) {
    // Allow quotes inside -c "..." or -e "..."
    const pyInline = /^(?:python3?|py)\s+(-c\s+[\s\S]+)$/i.exec(trimmed);
    if (pyInline) {
      const code = parseUnquotedFlagValue(pyInline[1], ["-c"]);
      if (code !== null) return { kind: "python", code, label: "python3" };
    }
    const nodeInline = /^(?:node|nodejs)\s+((-e|--eval|-p|--print)\s+[\s\S]+)$/i.exec(trimmed);
    if (nodeInline) {
      const isPrint = /^(-p|--print)\b/i.test(nodeInline[1]);
      const raw = parseUnquotedFlagValue(nodeInline[1], ["-e", "--eval", "-p", "--print"]);
      if (raw !== null) return { kind: "node", code: isPrint ? `console.log(${raw})` : raw, label: "node" };
    }
    const sqlInline = /^sqlite3?\s+(?::memory:\s+)?(["'][\s\S]+["'])$/i.exec(trimmed);
    if (sqlInline) {
      const query = sqlInline[1].slice(1, -1);
      return { kind: "sqlite", code: query, label: "sqlite3" };
    }
    return { kind: "bash" };
  }

  const pyInline = /^(?:python3?|py)\s+(-c\s+[\s\S]+)$/i.exec(trimmed);
  if (pyInline) {
    const code = parseUnquotedFlagValue(pyInline[1], ["-c"]);
    if (code !== null) return { kind: "python", code, label: "python3" };
  }
  if (/^(?:python3?|py)\s+--version$/i.test(trimmed)) {
    return { kind: "python", code: "import sys; print('Python', sys.version.split()[0])", label: "python3" };
  }
  const pyFile = /^(?:python3?|py)\s+([^\s-][^\s]*)$/i.exec(trimmed);
  if (pyFile) {
    const cleanArg = pyFile[1].replace(/^(?:\.\/)+/, "");
    const relTarget = cleanArg.startsWith("/") ? cleanArg : `${cwd === "/" ? "" : cwd}/${cleanArg}`;
    const norm = safeRelPath(relTarget);
    const entry = norm ? entries.find((e) => !e.isDir && e.path === `/${norm}`) : undefined;
    if (entry) return { kind: "python", code: entry.content, label: "python3" };
  }

  const nodeInline = /^(?:node|nodejs)\s+((-e|--eval|-p|--print)\s+[\s\S]+)$/i.exec(trimmed);
  if (nodeInline) {
    const isPrint = /^(-p|--print)\b/i.test(nodeInline[1]);
    const raw = parseUnquotedFlagValue(nodeInline[1], ["-e", "--eval", "-p", "--print"]);
    if (raw !== null) return { kind: "node", code: isPrint ? `console.log(${raw})` : raw, label: "node" };
  }
  if (/^(?:node|nodejs)\s+(?:-v|--version)$/i.test(trimmed)) {
    return { kind: "node", code: "console.log(process.version)", label: "node" };
  }
  const nodeFile = /^(?:node|nodejs)\s+([^\s-][^\s]*)$/i.exec(trimmed);
  if (nodeFile) {
    const cleanArg = nodeFile[1].replace(/^(?:\.\/)+/, "");
    const relTarget = cleanArg.startsWith("/") ? cleanArg : `${cwd === "/" ? "" : cwd}/${cleanArg}`;
    const norm = safeRelPath(relTarget);
    const entry = norm ? entries.find((e) => !e.isDir && e.path === `/${norm}`) : undefined;
    if (entry) return { kind: "node", code: entry.content, label: "node" };
  }

  const sqlInline = /^sqlite3?\s+(?::memory:\s+)?(.+)$/i.exec(trimmed);
  if (sqlInline) {
    let q = sqlInline[1].trim();
    if ((q.startsWith('"') && q.endsWith('"')) || (q.startsWith("'") && q.endsWith("'"))) q = q.slice(1, -1);
    return { kind: "sqlite", code: q, label: "sqlite3" };
  }

  return { kind: "bash" };
}

function buildWandboxCodes(
  entries: RemoteWorkspaceEntry[],
  cwd: string,
  runtime: "python" | "node",
): { codes: { file: string; code: string }[]; hasSitePackages: boolean } {
  const relCwd = safeRelPath(cwd);
  const cwdPrefix = relCwd ? `${relCwd}/` : "";
  const codes: { file: string; code: string }[] = [];
  const seen = new Set<string>();
  let total = 0;

  const pushCode = (file: string, content: string) => {
    if (!file || seen.has(file) || codes.length >= MAX_CODE_FILES) return false;
    if (content.length > MAX_CODE_FILE_CHARS || total + content.length > MAX_CODE_TOTAL_CHARS) return false;
    seen.add(file);
    total += content.length;
    codes.push({ file, code: content });
    return true;
  };

  // 1. User workspace files (not installed package trees)
  for (const entry of entries) {
    if (entry.isDir || isPkgEntryPath(entry.path)) continue;
    const rel = safeRelPath(entry.path);
    if (!rel) continue;
    const file = cwdPrefix && rel.startsWith(cwdPrefix) ? rel.slice(cwdPrefix.length) : rel;
    pushCode(file, entry.content);
  }

  let hasSitePackages = false;

  // 2. Installed Python packages from /site-packages
  if (runtime === "python") {
    for (const entry of entries) {
      if (entry.isDir || !entry.path.startsWith("/site-packages/")) continue;
      if (/\.(?:md|rst|txt)$/i.test(entry.path) && !entry.path.endsWith(".py")) continue;
      const rel = safeRelPath(entry.path);
      if (!rel) continue;
      if (pushCode(rel, entry.content)) hasSitePackages = true;
    }
  }

  // 3. Installed Node modules (<cwd>/node_modules first, then /node_modules)
  if (runtime === "node") {
    const cwdNmPrefix = `${cwdPrefix}node_modules/`;
    const isSkipDoc = (path: string) => /(?:^|\/)(?:README|CHANGELOG|LICENSE|HISTORY)(?:\.[^/]+)?$/i.test(path);
    for (const entry of entries) {
      if (entry.isDir || isSkipDoc(entry.path)) continue;
      const rel = safeRelPath(entry.path);
      if (!rel) continue;
      if (rel.startsWith(cwdNmPrefix)) {
        pushCode(`node_modules/${rel.slice(cwdNmPrefix.length)}`, entry.content);
      }
    }
    if (cwdPrefix) {
      for (const entry of entries) {
        if (entry.isDir || isSkipDoc(entry.path)) continue;
        const rel = safeRelPath(entry.path);
        if (!rel || !rel.startsWith("node_modules/")) continue;
        pushCode(rel, entry.content);
      }
    }
  }

  return { codes, hasSitePackages };
}

/** Inserts site-packages onto sys.path after any leading encoding comment or `from __future__` import. */
function injectPythonSitePackages(code: string): string {
  const hook = 'import sys as _aura_sys, os as _aura_os; _aura_sp = _aura_os.path.abspath("site-packages"); _aura_sp not in _aura_sys.path and _aura_sys.path.insert(0, _aura_sp)';
  const lines = code.split("\n");
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("from __future__ ")) {
      insertAt = i + 1;
      continue;
    }
    break;
  }
  lines.splice(insertAt, 0, hook);
  return lines.join("\n");
}

/** Runs a command against Aura's keyless remote virtual server pool (Wandbox -> Paiza.io -> Codapi). */
export async function runRemoteTerminal(options: {
  command: string;
  cwd: string;
  entries: RemoteWorkspaceEntry[];
}): Promise<RemoteExecResult> {
  const { command, cwd, entries } = options;
  const intent = detectRuntimeIntent(command, cwd, entries);

  if (intent.kind === "python") {
    const { codes, hasSitePackages } = buildWandboxCodes(entries, cwd, "python");
    const preparedCode = hasSitePackages ? injectPythonSitePackages(intent.code) : intent.code;
    const errs: string[] = [];
    if (!isCooling("wandbox")) {
      try {
        const res = await callWandbox({ compiler: "cpython-3.14.10", code: preparedCode, ...(codes.length ? { codes } : {}) });
        return { ok: res.ok, output: res.output.slice(0, MAX_OUTPUT_CHARS) || (res.ok ? "(no output)" : "Python exited with error."), engine: "wandbox · python3", cwd };
      } catch (err) {
        errs.push(`Wandbox: ${err instanceof Error ? err.message : String(err)}`);
        setCooldown("wandbox", 60_000);
      }
    }
    if (!isCooling("paiza")) {
      try {
        const res = await callPaiza("python3", intent.code);
        return { ok: res.ok, output: res.output.slice(0, MAX_OUTPUT_CHARS) || (res.ok ? "(no output)" : "Python exited with error."), engine: "paiza · python3", cwd };
      } catch (err) {
        errs.push(`Paiza: ${err instanceof Error ? err.message : String(err)}`);
        setCooldown("paiza", 60_000);
      }
    }
    if (!isCooling("codapi")) {
      try {
        const files: Record<string, string> = { "": preparedCode };
        for (const item of codes.slice(0, 40)) files[item.file] = item.code;
        const res = await callCodapi("python", files);
        return { ok: res.ok, output: res.output.slice(0, MAX_OUTPUT_CHARS) || (res.ok ? "(no output)" : "Python exited with error."), engine: "codapi · python", cwd };
      } catch (err) {
        errs.push(`Codapi: ${err instanceof Error ? err.message : String(err)}`);
        setCooldown("codapi", 60_000);
      }
    }
    return { ok: false, output: `Remote Python sandbox unavailable (${errs.join("; ") || "cooling down"}).`, engine: "remote-unavailable", cwd };
  }

  if (intent.kind === "node") {
    const { codes } = buildWandboxCodes(entries, cwd, "node");
    const errs: string[] = [];
    if (!isCooling("wandbox")) {
      try {
        const res = await callWandbox({ compiler: "nodejs-20.17.0", code: intent.code, ...(codes.length ? { codes } : {}) });
        return { ok: res.ok, output: res.output.slice(0, MAX_OUTPUT_CHARS) || (res.ok ? "(no output)" : "Node exited with error."), engine: "wandbox · node", cwd };
      } catch (err) {
        errs.push(`Wandbox: ${err instanceof Error ? err.message : String(err)}`);
        setCooldown("wandbox", 60_000);
      }
    }
    if (!isCooling("paiza")) {
      try {
        const res = await callPaiza("javascript", intent.code);
        return { ok: res.ok, output: res.output.slice(0, MAX_OUTPUT_CHARS) || (res.ok ? "(no output)" : "Node exited with error."), engine: "paiza · node", cwd };
      } catch (err) {
        errs.push(`Paiza: ${err instanceof Error ? err.message : String(err)}`);
        setCooldown("paiza", 60_000);
      }
    }
    return { ok: false, output: `Remote Node sandbox unavailable (${errs.join("; ") || "cooling down"}).`, engine: "remote-unavailable", cwd };
  }

  if (intent.kind === "sqlite") {
    const errs: string[] = [];
    if (!isCooling("codapi")) {
      try {
        const res = await callCodapi("sqlite", { "": intent.code });
        return { ok: res.ok, output: res.output.slice(0, MAX_OUTPUT_CHARS) || (res.ok ? "(ok)" : "SQLite error."), engine: "codapi · sqlite", cwd };
      } catch (err) {
        errs.push(`Codapi: ${err instanceof Error ? err.message : String(err)}`);
        setCooldown("codapi", 60_000);
      }
    }
    if (!isCooling("wandbox")) {
      try {
        const res = await callWandbox({ compiler: "sqlite-3.46.1", code: intent.code });
        return { ok: res.ok, output: res.output.slice(0, MAX_OUTPUT_CHARS) || (res.ok ? "(ok)" : "SQLite error."), engine: "wandbox · sqlite", cwd };
      } catch (err) {
        errs.push(`Wandbox: ${err instanceof Error ? err.message : String(err)}`);
        setCooldown("wandbox", 60_000);
      }
    }
    return { ok: false, output: `Remote SQLite sandbox unavailable (${errs.join("; ") || "cooling down"}).`, engine: "remote-unavailable", cwd };
  }

  // Full Ubuntu Linux Bash container (Wandbox primary -> Paiza.io fallback)
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
  const script = buildBashScript({ command, cwd, entries, nonce });
  const errs: string[] = [];

  if (!isCooling("wandbox")) {
    try {
      const raw = await callWandbox({ compiler: "bash", code: script });
      const parsed = parseBashSyncOutput(raw.output, nonce, cwd);
      return {
        ok: raw.ok,
        output: parsed.cleanOutput.slice(0, MAX_OUTPUT_CHARS) || (raw.ok ? "(done)" : "Command exited with non-zero status."),
        engine: "wandbox · linux",
        cwd: parsed.cwd,
        syncedEntries: parsed.syncedEntries,
      };
    } catch (err) {
      errs.push(`Wandbox: ${err instanceof Error ? err.message : String(err)}`);
      setCooldown("wandbox", 60_000);
    }
  }

  if (!isCooling("paiza")) {
    try {
      const raw = await callPaiza("bash", script);
      const parsed = parseBashSyncOutput(raw.output, nonce, cwd);
      return {
        ok: raw.ok,
        output: parsed.cleanOutput.slice(0, MAX_OUTPUT_CHARS) || (raw.ok ? "(done)" : "Command exited with non-zero status."),
        engine: "paiza · linux",
        cwd: parsed.cwd,
        syncedEntries: parsed.syncedEntries,
      };
    } catch (err) {
      errs.push(`Paiza: ${err instanceof Error ? err.message : String(err)}`);
      setCooldown("paiza", 60_000);
    }
  }

  return {
    ok: false,
    output: `Virtual Linux server engines are temporarily unavailable (${errs.join("; ") || "all cooling down"}). Try again shortly or use built-in workspace commands (ls, cat, write, grep).`,
    engine: "remote-unavailable",
    cwd,
  };
}
