import "server-only";
import { inflateRawSync, gunzipSync } from "node:zlib";
import { assertPublicUrl } from "@/lib/net-guard";

/**
 * Pure-Node, zero-host-shell package & network utilities for Aura's virtual workspace terminal:
 *   - pip install <pkg>       (fetches pure-Python wheels from pypi.org into /site-packages)
 *   - npm install <pkg>       (fetches npm tarballs from registry.npmjs.org into node_modules)
 *   - npm init [-y]           (creates package.json in cwd)
 *   - curl / wget <url>       (SSRF-guarded fetch into stdout or workspace file)
 *   - git clone <github-url>  (fetches public GitHub repo tarball into workspace folder)
 */

export type UnpackedEntry = { path: string; isDir: boolean; content: string };

const MAX_ARCHIVE_BYTES = 6 * 1024 * 1024;
const MAX_INSTALL_FILES = 140;
const MAX_FILE_CHARS = 300_000;
const FETCH_TIMEOUT_MS = 15_000;

function joinWorkspacePath(base: string, rel: string): string | null {
  const cleanBase = base === "/" ? "" : base.replace(/\/+$/, "");
  const parts: string[] = [];
  for (const seg of `${cleanBase}/${rel}`.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return null;
    if (seg.includes("\\") || seg.includes("\0") || seg.startsWith(".")) return null;
    if (!/^[\w.\- @]{1,100}$/.test(seg)) return null;
    parts.push(seg);
  }
  if (!parts.length || parts.length > 14) return null;
  return `/${parts.join("/")}`;
}

function safeRelSegment(rel: string): string | null {
  const parts: string[] = [];
  for (const seg of rel.replace(/^\/+/, "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === ".." || seg.includes("\\") || seg.includes("\0")) return null;
    if (seg.startsWith(".")) return null;
    if (!/^[\w.\- @]{1,90}$/.test(seg)) return null;
    parts.push(seg);
  }
  if (!parts.length || parts.length > 12) return null;
  return parts.join("/");
}

/** Fetches a public URL with SSRF checks on the initial URL and every redirect hop. */
async function safePublicFetch(rawUrl: string, headers: Record<string, string> = {}): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    const validated = await assertPublicUrl(current);
    const res = await fetch(validated.toString(), {
      headers: { "User-Agent": "Aura-Workspace-Terminal/1.0", ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect (${res.status}) missing location`);
      current = new URL(loc, validated).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects.");
}

/** Extracts text files from a .tar.gz buffer safely in memory. */
function extractTarGz(
  gzBuf: Buffer,
  stripComponents = 1,
  options: { skipDevNoise?: boolean } = {},
): { files: { rel: string; content: string }[]; skipped: number } {
  const tar = gunzipSync(gzBuf);
  const files: { rel: string; content: string }[] = [];
  let skipped = 0;
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeOct = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeOct || "0", 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (typeFlag !== "0" && typeFlag !== "\0") continue;
    if (size <= 0 || size > MAX_FILE_CHARS) { if (size > MAX_FILE_CHARS) skipped++; continue; }

    const parts = fullName.replace(/^\.\//, "").split("/").filter(Boolean);
    const stripped = parts.slice(stripComponents).join("/");
    const rel = safeRelSegment(stripped);
    if (!rel) continue;
    if (options.skipDevNoise && /\.(?:map|d\.ts|d\.mts|d\.cts)$/i.test(rel)) continue;

    if (files.length >= MAX_INSTALL_FILES) { skipped++; continue; }
    const slice = tar.subarray(dataStart, Math.min(dataEnd, tar.length));
    if (slice.includes(0)) { skipped++; continue; }
    files.push({ rel, content: slice.toString("utf8") });
  }
  return { files, skipped };
}

/** Extracts pure-Python files from a .whl (ZIP) buffer safely in memory using Central Directory. */
function extractWheelZip(zipBuf: Buffer): { files: { rel: string; content: string }[]; skipped: number } {
  // Locate End of Central Directory (0x06054b50)
  let eocd = -1;
  const searchStart = Math.max(0, zipBuf.length - 65_558);
  for (let i = zipBuf.length - 22; i >= searchStart; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("Invalid wheel archive (EOCD missing).");

  const entryCount = zipBuf.readUInt16LE(eocd + 10);
  const cdOffset = zipBuf.readUInt32LE(eocd + 16);
  const files: { rel: string; content: string }[] = [];
  let skipped = 0;
  let pos = cdOffset;

  for (let i = 0; i < entryCount && pos + 46 <= zipBuf.length; i++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const uncompSize = zipBuf.readUInt32LE(pos + 24);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localOffset = zipBuf.readUInt32LE(pos + 42);
    const rawName = zipBuf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/")) continue;
    // Skip .dist-info metadata bloat when keeping workspace lean (keep top-level .py/.txt/.json)
    if (/\.dist-info\//.test(rawName)) continue;
    if (uncompSize > MAX_FILE_CHARS || compSize > MAX_ARCHIVE_BYTES) { skipped++; continue; }
    if (localOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(localOffset) !== 0x04034b50) continue;

    const lNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const lExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compData = zipBuf.subarray(dataStart, dataStart + compSize);

    let out: Buffer;
    if (method === 0) out = compData;
    else if (method === 8) out = inflateRawSync(compData);
    else { skipped++; continue; }

    const rel = safeRelSegment(rawName);
    if (!rel) continue;
    if (files.length >= MAX_INSTALL_FILES) { skipped++; continue; }
    if (out.includes(0)) { skipped++; continue; }
    files.push({ rel, content: out.toString("utf8") });
  }
  return { files, skipped };
}

/** Installs a pure-Python package from PyPI into /site-packages inside the workspace. */
export async function pipInstall(pkgRaw: string): Promise<{ ok: boolean; output: string; entries: UnpackedEntry[] }> {
  const pkg = pkgRaw.trim().replace(/[=<>!~].*$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(pkg)) {
    return { ok: false, output: `pip: invalid package name "${pkgRaw}".`, entries: [] };
  }
  const metaRes = await safePublicFetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, { Accept: "application/json" });
  if (!metaRes.ok) {
    return { ok: false, output: `pip: package "${pkg}" not found on PyPI (HTTP ${metaRes.status}).`, entries: [] };
  }
  const meta = (await metaRes.json()) as {
    info?: { name?: string; version?: string; summary?: string };
    urls?: { packagetype?: string; filename?: string; url?: string; size?: number }[];
  };
  const wheel = (meta.urls ?? []).find((u) => u.packagetype === "bdist_wheel" && u.filename?.endsWith("-none-any.whl"));
  if (!wheel?.url) {
    return {
      ok: false,
      output: `pip: "${pkg}" (${meta.info?.version ?? "?"}) requires compiled native extensions (no pure-Python wheel). Try a pure-Python package or use the Direct Linux VM tab for native builds.`,
      entries: [],
    };
  }
  if ((wheel.size ?? 0) > MAX_ARCHIVE_BYTES) {
    return { ok: false, output: `pip: wheel for "${pkg}" is too large (${Math.round((wheel.size ?? 0) / 1024)} KB, max 6 MB).`, entries: [] };
  }
  const whlRes = await safePublicFetch(wheel.url);
  if (!whlRes.ok) return { ok: false, output: `pip: failed downloading wheel (HTTP ${whlRes.status}).`, entries: [] };
  const buf = Buffer.from(await whlRes.arrayBuffer());
  if (buf.length > MAX_ARCHIVE_BYTES) return { ok: false, output: `pip: downloaded archive exceeded 6 MB limit.`, entries: [] };

  const { files, skipped } = extractWheelZip(buf);
  const entries: UnpackedEntry[] = files
    .map((f) => ({ path: `/site-packages/${f.rel}`, isDir: false, content: f.content }))
    .filter((e) => e.path.length <= 200);

  return {
    ok: entries.length > 0,
    output: entries.length
      ? `Successfully installed ${meta.info?.name ?? pkg}-${meta.info?.version ?? "latest"} (${entries.length} files into /site-packages${skipped ? `, ${skipped} skipped` : ""}).\nImport it directly with python3 -c "import ${pkg.replace(/-/g, "_")} ..."!`
      : `pip: no pure-Python files could be extracted from ${pkg}.`,
    entries,
  };
}

/** Installs an npm package from registry.npmjs.org into <cwd>/node_modules/<pkg>. */
export async function npmInstall(pkgRaw: string, cwd: string): Promise<{ ok: boolean; output: string; entries: UnpackedEntry[] }> {
  const pkg = pkgRaw.trim().replace(/(?!^)@.*$/, "");
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg)) {
    return { ok: false, output: `npm: invalid package name "${pkgRaw}".`, entries: [] };
  }
  const metaRes = await safePublicFetch(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace("%2F", "/")}/latest`, { Accept: "application/json" });
  if (!metaRes.ok) {
    return { ok: false, output: `npm ERR! 404 Not Found - ${pkg} (HTTP ${metaRes.status})`, entries: [] };
  }
  const meta = (await metaRes.json()) as {
    name?: string;
    version?: string;
    dist?: { tarball?: string; unpackedSize?: number };
    dependencies?: Record<string, string>;
  };
  const tarball = meta.dist?.tarball;
  if (!tarball) return { ok: false, output: `npm: no tarball URL found for "${pkg}".`, entries: [] };

  const tarRes = await safePublicFetch(tarball);
  if (!tarRes.ok) return { ok: false, output: `npm: failed downloading tarball (HTTP ${tarRes.status}).`, entries: [] };
  const buf = Buffer.from(await tarRes.arrayBuffer());
  if (buf.length > MAX_ARCHIVE_BYTES) return { ok: false, output: `npm: tarball exceeded 6 MB limit.`, entries: [] };

  const { files, skipped } = extractTarGz(buf, 1, { skipDevNoise: true });
  const baseModules = cwd === "/" ? "/node_modules" : `${cwd}/node_modules`;
  const entries: UnpackedEntry[] = [];
  for (const f of files) {
    const full = joinWorkspacePath(`${baseModules}/${pkg}`, f.rel);
    if (full) entries.push({ path: full, isDir: false, content: f.content });
  }

  const depNames = Object.keys(meta.dependencies ?? {});
  const depNote = depNames.length ? `\nNote: peer/sub-dependencies (${depNames.slice(0, 6).join(", ")}${depNames.length > 6 ? "…" : ""}) can also be installed if needed.` : "";

  return {
    ok: entries.length > 0,
    output: entries.length
      ? `added ${meta.name ?? pkg}@${meta.version ?? "latest"} (${entries.length} files into ${baseModules}/${pkg}${skipped ? `, ${skipped} skipped` : ""}).${depNote}`
      : `npm: no text files extracted from ${pkg}.`,
    entries,
  };
}

/** Clones a public GitHub repository into <cwd>/<repo> via GitHub's tarball endpoint. */
export async function gitClone(repoUrl: string, cwd: string, targetDir?: string): Promise<{ ok: boolean; output: string; entries: UnpackedEntry[] }> {
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  if (!m) {
    return { ok: false, output: `git clone: give a public GitHub URL, e.g. https://github.com/owner/repo`, entries: [] };
  }
  const [, owner, repo] = m;
  const folderName = targetDir ? targetDir.replace(/[^A-Za-z0-9_.-]/g, "") : repo;
  if (!folderName) return { ok: false, output: `git clone: invalid destination folder name.`, entries: [] };

  const tarRes = await safePublicFetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`);
  if (!tarRes.ok) {
    return { ok: false, output: `git clone: could not fetch ${owner}/${repo} (HTTP ${tarRes.status}).`, entries: [] };
  }
  const buf = Buffer.from(await tarRes.arrayBuffer());
  if (buf.length > MAX_ARCHIVE_BYTES) {
    return { ok: false, output: `git clone: repository archive exceeds 6 MB limit.`, entries: [] };
  }

  const { files, skipped } = extractTarGz(buf, 1);
  const destRoot = cwd === "/" ? `/${folderName}` : `${cwd}/${folderName}`;
  const entries: UnpackedEntry[] = [];
  for (const f of files) {
    const full = joinWorkspacePath(destRoot, f.rel);
    if (full) entries.push({ path: full, isDir: false, content: f.content });
  }

  return {
    ok: entries.length > 0,
    output: `Cloned ${owner}/${repo} into ${destRoot} (${entries.length} files${skipped ? `, ${skipped} large/binary files skipped` : ""}).`,
    entries,
  };
}

/** SSRF-guarded curl/wget implementation saving into workspace file or returning text body. */
export async function runSafeCurl(args: string[], cwd: string): Promise<{ ok: boolean; output: string; saveTo?: string; content?: string }> {
  let outFile = "";
  let includeHeaders = false;
  let url = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-o" || arg === "--output" || arg === "-O") {
      if (arg === "-O") outFile = "__AUTO__";
      else if (args[i + 1]) { outFile = args[++i]; }
      continue;
    }
    if (arg === "-i" || arg === "--include" || arg === "-I" || arg === "--head") {
      includeHeaders = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (/^https?:\/\//i.test(arg)) url = arg;
  }

  if (!url) return { ok: false, output: "curl: provide an http:// or https:// URL." };

  const res = await safePublicFetch(url);
  const text = await res.text();
  if (outFile) {
    const fallbackName = new URL(url).pathname.split("/").filter(Boolean).pop() || "download.txt";
    const chosen = outFile === "__AUTO__" ? fallbackName : outFile;
    const targetPath = joinWorkspacePath(chosen.startsWith("/") ? "/" : cwd, chosen);
    if (!targetPath) return { ok: false, output: `curl: invalid output path "${chosen}".` };
    if (text.length > MAX_FILE_CHARS) return { ok: false, output: `curl: response too large to save (${text.length} chars, max 300,000).` };
    return {
      ok: res.ok,
      output: `HTTP ${res.status} — saved ${text.length} characters to ${targetPath}`,
      saveTo: targetPath,
      content: text,
    };
  }

  const headerText = includeHeaders
    ? `HTTP ${res.status} ${res.statusText}\ncontent-type: ${res.headers.get("content-type") ?? "unknown"}\n\n`
    : "";
  return {
    ok: res.ok,
    output: `${headerText}${text}`.slice(0, 6000) || `HTTP ${res.status}`,
  };
}
