import "server-only";
import { assertPublicUrl } from "@/lib/net-guard";

/** Reads a public web page and returns its readable text. No images, scripts, navigation, or trackers. */

const MAX_BYTES = 900_000;
const MAX_REDIRECTS = 3;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", middot: "·", bull: "•" };
const decode = (value: string) => value
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[String(name).toLowerCase()] ?? whole);

/** Keeps paragraph and heading structure so the model reads real sentences, not a soup of words. */
export function extractText(html: string): { title: string; text: string } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const meta = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1];
  const description = meta ? decode(meta).trim() : "";
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template|iframe|form|nav|footer|header|aside|dialog)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|blockquote|dd|dt|figcaption|table|pre)>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, "\n## ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  body = decode(body)
    .replace(/[ \t\u00a0\u200b]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // Drop short lines that are usually menus, buttons, or cookie notices.
    .split("\n")
    .filter((line) => line.trim().length > 2 || line.startsWith("##"))
    .join("\n")
    .trim();
  const text = [description ? `${description}\n\n${body}` : body].join("").trim();
  return { title, text };
}

async function fetchWithGuard(start: URL, signal: AbortSignal) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: {
        "User-Agent": "AuraAgent/1.1 (+private workspace assistant; respects robots)",
        Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
        "Accept-Language": "en-US,en;q=0.9,bn;q=0.8",
      },
      cache: "no-store",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error("The page redirected without a destination.");
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new Error("The page redirected too many times.");
}

type PageRead = { url: string; title: string; text: string; truncated: boolean; chars: number; status: number };

async function readBody(response: Response, maxChars: number): Promise<{ raw: string; type: string }> {
  const type = response.headers.get("content-type") || "";
  if (!/text\/|application\/(json|xhtml\+xml|xml|rss\+xml|atom\+xml)/i.test(type)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("That address is not a readable text page (it may be an image, video, or a download).");
  }
  if (!response.body) return { raw: "", type };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return { raw, type };
}

/** Wikipedia has a clean plain-text API, which is far better than scraping its article HTML. */
async function wikipediaPlainText(url: URL): Promise<{ title: string; text: string } | null> {
  const match = /^([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/i.exec(`${url.hostname}${url.pathname}`);
  if (!match) return null;
  const title = decodeURIComponent(match[2]).replace(/_/g, " ");
  const api = new URL("https://" + url.hostname + "/w/api.php");
  api.search = new URLSearchParams({ action: "query", prop: "extracts", explaintext: "1", redirects: "1", format: "json", titles: title }).toString();
  const response = await fetch(api, { signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "AuraAgent/1.1" }, cache: "no-store" });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null) as { query?: { pages?: Record<string, { title?: string; extract?: string }> } } | null;
  const page = Object.values(data?.query?.pages ?? {})[0];
  if (!page?.extract) return null;
  return { title: page.title || title, text: page.extract.trim() };
}

export async function readPage(rawUrl: string, options: { maxChars?: number; signal?: AbortSignal } = {}): Promise<PageRead> {
  const maxChars = Math.min(30_000, Math.max(800, options.maxChars ?? 12_000));
  const signal = options.signal ?? new AbortController().signal;
  const url = await assertPublicUrl(rawUrl);
  if (/\.wikipedia\.org$/i.test(url.hostname) || /\.wikipedia\.org$/i.test(url.hostname.replace(/^www\./, ""))) {
    const wiki = await wikipediaPlainText(url).catch(() => null);
    if (wiki?.text) return { url: url.toString(), title: wiki.title, text: wiki.text.slice(0, maxChars), truncated: wiki.text.length > maxChars, chars: Math.min(wiki.text.length, maxChars), status: 200 };
  }
  const { response, finalUrl } = await fetchWithGuard(url, signal);
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`That page returned HTTP ${response.status}.`); }
  const { raw, type } = await readBody(response, maxChars);
  const parsed = /html/i.test(type) ? extractText(raw) : { title: finalUrl.pathname.split("/").filter(Boolean).at(-1) ?? finalUrl.hostname, text: raw.trim() };
  const text = parsed.text.replace(/\n{3,}/g, "\n\n").trim();
  return { url: finalUrl.toString(), title: parsed.title.slice(0, 200), text: text.slice(0, maxChars), truncated: text.length > maxChars, chars: Math.min(text.length, maxChars), status: response.status };
}

/** Reads several pages at once. Failures are reported, never silently dropped. */
export async function readPages(urls: string[], options: { maxChars?: number } = {}): Promise<{ pages: PageRead[]; failed: { url: string; error: string }[] }> {
  const settled = await Promise.allSettled(urls.map((url) => readPage(url, { maxChars: options.maxChars })));
  const pages: PageRead[] = [];
  const failed: { url: string; error: string }[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") pages.push(result.value);
    else failed.push({ url: urls[index], error: result.reason instanceof Error ? result.reason.message : "Could not be read." });
  });
  return { pages, failed };
}
