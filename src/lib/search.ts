import "server-only";
import { readPages } from "@/lib/reader";

/**
 * Aura's search engine. Freshness-first, like Google:
 * - If the server has a key (SERPER = Google SERP, BRAVE, or TAVILY), that runs first.
 * - Otherwise: Google News RSS + Bing News RSS for up-to-the-minute items (no key needed!),
 *   DuckDuckGo with real date filters, FreeSerp Global (fresh=1 + publish window), then Wikipedia.
 * Every result carries a date when the source knows it, and fresh queries always merge
 * the latest headlines with full readable articles.
 */

export type Freshness = "any" | "day" | "week" | "month" | "year";
export type SearchResult = { title: string; url: string; snippet: string; site: string; date?: string; kind?: "news" | "web" };
type Cache = Map<string, { at: number; results: SearchResult[] }>;
const registry = globalThis as typeof globalThis & { __auraSearchCache?: Cache };
const cache: Cache = registry.__auraSearchCache ?? (registry.__auraSearchCache = new Map());
const CACHE_MS = 10 * 60_000;
const FRESH_CACHE_MS = 60_000;

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/rss+xml",
  "Accept-Language": "en-US,en;q=0.9,bn;q=0.8",
};

const decode = (value: string) => value
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  .replace(/\s+/g, " ").trim();

const siteOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** "latest / today / news / খবর…" → treat as day-fresh even when the caller does not say. */
export function detectFreshness(query: string): Freshness {
  const q = query.toLowerCase();
  if (/\b(today|tonight|breaking|right now|latest|current|now|আজ|এখন|সর্বশেষ|সর্বশেষ)\b/.test(q)) return "day";
  if (/\b(this week|weekend)\b/.test(q)) return "week";
  if (/\b(news|headlines|update| খবর|হালনাগাদ)\b/.test(q)) return "week";
  return "any";
}

const WHEN_PARAM: Record<Exclude<Freshness, "any">, { gnews: string; ddg: string; days: number }> = {
  day: { gnews: "when:1d", ddg: "d", days: 1 },
  week: { gnews: "when:7d", ddg: "w", days: 7 },
  month: { gnews: "when:30d", ddg: "m", days: 31 },
  year: { gnews: "when:365d", ddg: "y", days: 366 },
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Bing wraps result links in bing.com/ck/a?u=a1<base64url>. Unwrap it to the real address. */
function unwrapBing(href: string): string {
  try {
    const url = new URL(href);
    if (/(^|\.)bing\.com$/i.test(url.hostname) && url.pathname.startsWith("/ck/a")) {
      const raw = url.searchParams.get("u") ?? "";
      if (raw.startsWith("a1")) {
        const decoded = Buffer.from(raw.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
      return "";
    }
    return href;
  } catch { return ""; }
}

function cleanUrl(href: string): string | null {
  let value = href;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    const redirected = url.searchParams.get("uddg");
    if (redirected) value = decodeURIComponent(redirected);
    const final = new URL(value);
    if (!/^https?:$/.test(final.protocol)) return null;
    if (/duckduckgo\.com$/i.test(final.hostname)) return null;
    return final.toString();
  } catch { return null; }
}

/* ---------------- optional keyed providers (true Google via Serper) ---------------- */

async function serper(query: string, freshness: Freshness, limit: number): Promise<SearchResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("no key");
  const tbs = freshness !== "any" ? { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[freshness] : undefined;
  const call = (endpoint: "search" | "news", num: number) => fetch(`https://google.serper.dev/${endpoint}`, { method: "POST", headers: { "X-API-KEY": key, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, num, ...(tbs ? { tbs } : {}) }), signal: AbortSignal.timeout(12_000) });
  const [searchRes, newsRes] = await Promise.all([call("search", Math.min(limit, 10)), freshness !== "any" ? call("news", 6) : Promise.resolve(null)]);
  if (!searchRes || !searchRes.ok) throw new Error(`Serper answered HTTP ${searchRes?.status ?? "?"}.`);
  const search = await searchRes.json() as { organic?: { title?: string; link?: string; snippet?: string; date?: string }[] };
  const news = newsRes && newsRes.ok ? (await newsRes.json() as { news?: { title?: string; link?: string; snippet?: string; date?: string; source?: string }[] }).news ?? [] : [];
  const out: SearchResult[] = [];
  for (const item of news) {
    if (!item.link || !item.title) continue;
    out.push({ title: item.title.slice(0, 200), url: item.link, snippet: (item.snippet ?? "").slice(0, 500), site: item.source || siteOf(item.link), date: item.date, kind: "news" });
  }
  for (const item of search.organic ?? []) {
    if (!item.link || !item.title) continue;
    out.push({ title: item.title.slice(0, 200), url: item.link, snippet: (item.snippet ?? "").slice(0, 500), site: siteOf(item.link), kind: "web" });
  }
  return out;
}

async function brave(query: string, freshness: Freshness, limit: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("no key");
  const fresh = freshness === "any" ? "" : `&freshness=${{ day: "pd", week: "pw", month: "pm", year: "py" }[freshness]}`;
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 10)}${fresh}`, {
    headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal: AbortSignal.timeout(12_000), cache: "no-store",
  });
  if (!response.ok) throw new Error(`Brave answered HTTP ${response.status}.`);
  const data = await response.json() as { web?: { results?: { title?: string; url?: string; description?: string; page_age?: string }[] } };
  return (data.web?.results ?? []).filter((r) => r.url && r.title).map((r) => ({ title: r.title!.slice(0, 200), url: r.url!, snippet: (r.description ?? "").slice(0, 500), site: siteOf(r.url!), date: r.page_age, kind: "web" as const }));
}

async function tavily(query: string, freshness: Freshness, limit: number): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("no key");
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: Math.min(limit, 8), ...(freshness === "any" ? {} : { topic: "news", days: { day: 1, week: 7, month: 31, year: 366 }[freshness] }) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Tavily answered HTTP ${response.status}.`);
  const data = await response.json() as { results?: { title?: string; url?: string; content?: string; published_date?: string }[] };
  return (data.results ?? []).filter((r) => r.url).map((r) => ({ title: (r.title ?? "Result").slice(0, 200), url: r.url!, snippet: (r.content ?? "").slice(0, 500), site: siteOf(r.url!), date: r.published_date?.slice(0, 10), kind: freshness === "any" ? "web" as const : "news" as const }));
}

/* ---------------- fresh free sources: real news, to the minute ---------------- */

function parseRssItems(xml: string, limit: number, kind: "news"): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of xml.split(/<item>|<entry>/).slice(1)) {
    if (out.length >= limit) break;
    const title = decode(block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] ?? "");
    const rawLink = block.match(/<link[^>]*>(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?<\/link>/i)?.[1]
      ?? block.match(/<link[^>]+href="([^"]+)"/i)?.[1] ?? "";
    const linkMatch = /https?:\/\/[^\s<"]+/.exec(rawLink.trim());
    const pubRaw = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) ?? block.match(/<dc:date>([\s\S]*?)<\/dc:date>/i) ?? [])[1] ?? "";
    const when = pubRaw.trim() ? new Date(pubRaw.trim()) : null;
    const date = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : undefined;
    if (!linkMatch || !title) continue;
    out.push({ title: title.slice(0, 200), url: linkMatch[0], snippet: "", site: "", date, kind });
  }
  return out;
}

/* ---------------- real Google through the server's own Chromium (keyless) ---------------- */

type GoogleBrowser = { browser: import("playwright").Browser; context: import("playwright").BrowserContext };
const gReg = globalThis as typeof globalThis & { __auraGoogle?: { session: GoogleBrowser | null; starting: Promise<GoogleBrowser> | null; downUntil: number; lastUsed: number; lastFetch: number } };
const googleState = gReg.__auraGoogle ?? (gReg.__auraGoogle = { session: null, starting: null, downUntil: 0, lastUsed: 0, lastFetch: 0 });
/** Consent cookies skip the EU interstitial; one search per 20s keeps Google happy on shared IPs. */
const GOOGLE_PACE_MS = 20_000;
const GOOGLE_BACKOFF_MS = 30 * 60_000;

/** "3 hours ago", "Yesterday", "12 Nov 2026"… → YYYY-MM-DD so date sorting works everywhere. */
function toIsoDate(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const rel = /(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const ms = { minute: 60e3, hour: 3600e3, day: 86_400e3, week: 604_800e3, month: 2_592e6, year: 31_536e6 }[rel[2].toLowerCase() as "minute"] ?? 0;
    return new Date(Date.now() - n * ms).toISOString().slice(0, 10);
  }
  if (/^\d+\s*mins?\s*ago$/i.test(text)) return new Date().toISOString().slice(0, 10);
  if (/yesterday/i.test(text)) return new Date(Date.now() - 86_400e3).toISOString().slice(0, 10);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
}

async function googleSession(): Promise<GoogleBrowser> {
  if (googleState.session?.browser.isConnected()) {
    googleState.lastUsed = Date.now();
    return googleState.session;
  }
  if (!googleState.starting) {
    googleState.starting = (async () => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"] });
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        locale: "en-US", viewport: { width: 1366, height: 900 },
      });
      await context.addCookies([
        { name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" },
        { name: "SOCS", value: "CAESHAgBEhJnd3NfMjAyNDAxMDEtMF9SQzEaAmVuIAEaBgiA_LyaBg", domain: ".google.com", path: "/" },
      ]);
      // Skip images/fonts: Google's text results are all we need, and it loads far faster.
      await context.route("**/*", (route) => {
        const type = route.request().resourceType();
        return type === "image" || type === "media" || type === "font" ? route.abort() : route.continue();
      });
      const session = { browser, context };
      googleState.session = session;
      googleState.lastUsed = Date.now();
      browser.on("disconnected", () => { if (googleState.session?.browser === browser) googleState.session = null; });
      return session;
    })();
  }
  try { return await googleState.starting; } finally { googleState.starting = null; }
}

/** Real Google web search, read through a headless Chromium on the server. No API key. */
async function googleBrowser(query: string, freshness: Freshness, limit: number): Promise<SearchResult[]> {
  if (Date.now() < googleState.downUntil) throw new Error("Google is resting after a recent challenge");
  if (Date.now() - googleState.lastFetch < GOOGLE_PACE_MS) throw new Error("Google pacing");
  let page: import("playwright").Page | null = null;
  try {
    const { context } = await googleSession();
    googleState.lastUsed = Date.now();
    googleState.lastFetch = Date.now();
    const tbs = freshness === "any" ? "" : `&tbs=qdr:${{ day: "d", week: "w", month: "m", year: "y" }[freshness]}`;
    page = await context.newPage();
    const response = await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=12${tbs}`, { waitUntil: "domcontentloaded", timeout: 14_000 }).catch(() => null);
    await page.waitForTimeout(900);
    const url = page.url();
    const status = response?.status() ?? 0;
    const bodyText = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 600);
    if (url.includes("/sorry/") || status === 429 || /unusual traffic|not a robot|captcha/i.test(bodyText)) throw new Error("Google asked for a human check");
    const raw = await page.evaluate(() => {
      const out: { title: string; href: string; snippet: string; age: string }[] = [];
      for (const anchor of Array.from(document.querySelectorAll("a")) as HTMLAnchorElement[]) {
        const heading = anchor.querySelector("h3");
        if (!heading || !anchor.href) continue;
        let href = anchor.href;
        const marker = href.indexOf("url?q=");
        if (href.includes("/url?") && marker !== -1) { try { href = decodeURIComponent(href.slice(marker + 6).split("&")[0] ?? ""); } catch { /* keep raw */ } }
        if (!/^https?:/i.test(href) || /google\./.test(href)) continue;
        const block = anchor.closest("div.g, div[class*=\"_NkH\"], div[data-hveid] div") as HTMLElement | null;
        const snippet = block ? [...block.querySelectorAll("div span")].map(s => s.textContent ?? "").filter(t => t.length > 60)[0] ?? "" : "";
        const age = block ? [...block.querySelectorAll("span")].map(s => s.textContent ?? "").find(t => /(minute|hour|day|week|month|year)s? ago|^yesterday$|^\d{1,2}\s\w{3,4}(,| \d{4})?$|\d+ mins? ago/i.test(t.trim())) ?? "" : "";
        out.push({ title: (heading.textContent ?? "").trim(), href, snippet: (snippet ?? "").trim(), age: (age ?? "").trim() });
        if (out.length >= 12) break;
      }
      return out;
    }).catch(() => [] as { title: string; href: string; snippet: string; age: string }[]);
    const results: SearchResult[] = [];
    for (const item of raw) {
      if (!item.title || results.some((existing) => existing.url === item.href)) continue;
      results.push({ title: item.title.slice(0, 200), url: item.href, snippet: item.snippet.slice(0, 500), site: siteOf(item.href), date: toIsoDate(item.age), kind: "web" });
      if (results.length >= limit) break;
    }
    if (!results.length) throw new Error("Google returned no readable results");
    return results;
  } catch (error) {
    // Challenged or failing? Rest the source for a while so searches stay fast on the other sources.
    const message = error instanceof Error ? error.message : "Google search failed";
    if (!/pacing/.test(message)) googleState.downUntil = Date.now() + GOOGLE_BACKOFF_MS;
    throw new Error(message);
  } finally {
    await page?.close().catch(() => undefined);
    // Close an idle Google browser after 5 minutes so deployments without a long-lived server stay light.
    if (googleState.session && Date.now() - googleState.lastUsed > 5 * 60_000) {
      const dying = googleState.session; googleState.session = null;
      await dying.browser.close().catch(() => undefined);
    }
  }
}

/** Google News headlines — the freshest free source there is, updated continuously. */
async function googleNews(query: string, when: string | null, limit: number): Promise<SearchResult[]> {
  const q = when ? `${query} ${when}` : query;
  const response = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Google News answered HTTP ${response.status}.`);
  const items = parseRssItems(await response.text(), limit, "news");
  return items.map((item) => ({ ...item, site: item.url.includes("news.google.com") ? "Google News" : siteOf(item.url) }));
}

/** Bing News RSS — links usually point straight at the real article, which is readable. */
async function bingNews(query: string, limit: number): Promise<SearchResult[]> {
  const response = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Bing News answered HTTP ${response.status}.`);
  const items = parseRssItems(await response.text(), limit, "news");
  for (const item of items) {
    const direct = unwrapBing(item.url);
    if (direct) { item.url = direct; item.site = siteOf(direct); }
  }
  return items.filter((item) => item.url);
}

/** Google News's redirect links are unreadable by the page reader; keep citations but read the rest. */
export const isRedirectLink = (url: string) => /news\.google\.(com|[a-z]{2})\/(rss|articles)/i.test(url) || /(^|\.)google\.[a-z.]+\/url\?/i.test(url);

/* ---------------- general web sources ---------------- */

/** DuckDuckGo's HTML page lists titles in result__a anchors and snippet text in result__snippet anchors, in order. */
export function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const titles: { title: string; url: string }[] = [];
  const titleRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = titleRegex.exec(html)) && titles.length < limit * 2) {
    const url = cleanUrl(match[1]);
    const title = decode(match[2]);
    if (url && title) titles.push({ title: title.slice(0, 200), url });
  }
  const snippets: string[] = [];
  const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((match = snippetRegex.exec(html)) && snippets.length < limit * 2) snippets.push(decode(match[1]).slice(0, 500));
  const results: SearchResult[] = [];
  for (const [index, item] of titles.entries()) {
    if (results.some((existing) => existing.url === item.url)) continue;
    results.push({ title: item.title, url: item.url, snippet: snippets[index] ?? "", site: siteOf(item.url), kind: "web" });
    if (results.length >= limit) break;
  }
  return results;
}

async function duckDuckGo(query: string, limit: number, freshness: Freshness): Promise<SearchResult[]> {
  const df = freshness === "any" ? "" : `&df=${WHEN_PARAM[freshness].ddg}`;
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${df}`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(20_000), cache: "no-store" });
  if (!response.ok) throw new Error(`DuckDuckGo answered HTTP ${response.status}.`);
  const html = await response.text();
  if (/anomaly|unusual traffic|are you a robot/i.test(html)) throw new Error("DuckDuckGo asked for a bot check.");
  return parseDuckDuckGo(html, limit);
}

/** FreeSerp Global: 3.1B-page index with freshness ranking and a publish-date window. */
async function freeSerp(query: string, limit: number, freshness: Freshness): Promise<SearchResult[]> {
  const fresh = freshness === "any" ? "" : `&fresh=1&published_from=${isoDaysAgo(WHEN_PARAM[freshness].days)}`;
  const response = await fetch(`https://freeserp.ai/api.php?index=web&q=${encodeURIComponent(query)}&size=${Math.min(10, limit)}${fresh}`, {
    headers: { "User-Agent": "AuraAgent/1.1 (+private workspace assistant)", Accept: "application/json" },
    signal: AbortSignal.timeout(10_000), cache: "no-store",
  });
  if (!response.ok) throw new Error(`FreeSerp answered HTTP ${response.status}.`);
  const data = await response.json().catch(() => null) as { ok?: boolean; results?: { url?: string; title?: string; snippet?: string; description?: string; domain?: string; published_at?: string | null }[] } | null;
  if (!data?.ok || !Array.isArray(data.results)) throw new Error("FreeSerp returned no results.");
  const results: SearchResult[] = [];
  for (const item of data.results) {
    const url = item.url ? cleanUrl(item.url) : null;
    const title = item.title ? decode(item.title) : "";
    if (!url || !title) continue;
    if (results.some((existing) => existing.url === url)) continue;
    results.push({ title: title.slice(0, 200), url, snippet: decode(item.snippet || item.description || "").slice(0, 500), site: item.domain?.replace(/^www\./, "") || siteOf(url), date: item.published_at ?? undefined, kind: "web" });
    if (results.length >= limit) break;
  }
  return results;
}

/** DuckDuckGo's HTML is a dependable second source when DuckDuckGo rate-limits this server. */
export function parseBing(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= limit) break;
    const anchor = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const url = cleanUrl(unwrapBing(anchor[1]));
    const title = decode(anchor[2]);
    if (!url || !title) continue;
    if (results.some((item) => item.url === url)) continue;
    const snippetMatch = /<p[^>]*class="[^"]*b_(?:lineclamp|algoSlug_icon)?[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ?? /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    results.push({ title: title.slice(0, 200), url, snippet: snippetMatch ? decode(snippetMatch[1]).slice(0, 500) : "", site: siteOf(url), kind: "web" });
  }
  return results;
}

async function bing(query: string, limit: number): Promise<SearchResult[]> {
  const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query).replace(/%20/g, "+")}&form=QBLH&setlang=en`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(20_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Bing answered HTTP ${response.status}.`);
  const html = await response.text();
  return parseBing(html, limit);
}

async function wikipedia(query: string, limit: number): Promise<SearchResult[]> {
  const api = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${Math.min(limit, 5)}&format=json&srprop=snippet`;
  const response = await fetch(api, { headers: { "User-Agent": "AuraAgent/1.1" }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Wikipedia answered HTTP ${response.status}.`);
  const data = await response.json().catch(() => null) as { query?: { search?: { title: string; snippet: string }[] } } | null;
  return (data?.query?.search ?? []).map((item) => ({
    title: item.title.slice(0, 200),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
    snippet: decode(item.snippet).slice(0, 400),
    site: "en.wikipedia.org",
    kind: "web" as const,
  }));
}

export type SearchOutcome = { results: SearchResult[]; source: string; tried: string[]; freshness: Freshness; news: number };

/**
 * Runs the search sources and merges them. Fresh queries always get the latest
 * headlines FIRST plus full web results for background — not one or the other.
 */
export async function searchWeb(query: string, limit = 8, wantedFreshness: Freshness | "auto" = "auto"): Promise<SearchOutcome> {
  const clean = query.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!clean) throw new Error("A search needs a few words.");
  const freshness: Freshness = wantedFreshness === "auto" ? detectFreshness(clean) : wantedFreshness;
  const key = `${freshness}:${limit}:${clean.toLowerCase()}`;
  const cached = cache.get(key);
  const ttl = freshness === "any" ? CACHE_MS : FRESH_CACHE_MS;
  if (cached && Date.now() - cached.at < ttl) return { results: cached.results, source: "cache", tried: [], freshness, news: cached.results.filter((r) => r.kind === "news").length };

  const tried: string[] = [];
  const errors: string[] = [];
  const collected: SearchResult[] = [];
  const push = (items: SearchResult[], label: string) => {
    for (const item of items) {
      if (collected.some((existing) => existing.url === item.url)) continue;
      collected.push(item);
    }
    if (!tried.includes(label)) tried.push(label);
  };

  const run = async (label: string, fn: () => Promise<SearchResult[]>) => {
    try { push(await fn(), label); return true; }
    catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message.slice(0, 60) : "failed"}`); return false; }
  };

  if (process.env.SERPER_API_KEY || process.env.BRAVE_API_KEY || process.env.TAVILY_API_KEY) {
    if (process.env.SERPER_API_KEY && await run("Google (Serper)", () => serper(clean, freshness, limit))) { /* got Google via API */ }
    if (process.env.BRAVE_API_KEY && collected.length < 4 && await run("Brave", () => brave(clean, freshness, limit))) { /* ok */ }
    if (process.env.TAVILY_API_KEY && collected.length < 4 && await run("Tavily", () => tavily(clean, freshness, limit))) { /* ok */ }
  }
  const keyedGoogle = tried.some((name) => name.includes("Google"));
  // Real Google web results (through the server's Chromium) run alongside the live news feeds.
  const racers: Promise<unknown>[] = [
    keyedGoogle ? Promise.resolve() : run("Google", () => googleBrowser(clean, freshness, limit)),
  ];
  if (freshness !== "any") {
    racers.push(run("Google News", () => googleNews(clean, WHEN_PARAM[freshness].gnews, 6)));
    racers.push(run("Bing News", () => bingNews(clean, 6)));
  }
  await Promise.all(racers);
  if (freshness !== "any" && !collected.some((r) => r.kind === "news")) await run("Google News", () => googleNews(clean, null, 6));
  if (collected.filter((r) => r.kind !== "news").length < 4) {
    await run("FreeSerp", () => freeSerp(clean, limit, freshness));
    await run("DuckDuckGo", () => duckDuckGo(clean, limit, freshness));
  }
  if (collected.length < 3) {
    await run("Bing", () => bing(clean, limit));
    await run("Wikipedia", () => wikipedia(clean, Math.min(limit, 5)));
  }
  if (!collected.length) throw new Error(`No search results came back for “${clean}”. ${errors.slice(0, 2).join(" · ")}`.trim());

  // News items first (newest date first), then the web results.
  const byDate = (a: SearchResult, b: SearchResult) => (b.date ?? "").localeCompare(a.date ?? "");
  const newsItems = collected.filter((r) => r.kind === "news").sort(byDate);
  const webItems = collected.filter((r) => r.kind !== "news");
  const results = [...newsItems, ...webItems].slice(0, freshness === "any" ? limit : limit + newsItems.length);
  const sourceLabel = `${tried.join(" + ")}${errors.length ? ` · ${errors.length} skipped` : ""}`;
  cache.set(key, { at: Date.now(), results });
  if (cache.size > 60) cache.delete([...cache.keys()][0]);
  return { results, source: sourceLabel, tried, freshness, news: results.filter((r) => r.kind === "news").length };
}

export type Research = {
  query: string;
  source: string;
  freshness: Freshness;
  news: number;
  results: SearchResult[];
  pages: { title: string; url: string; site: string; text: string; truncated: boolean }[];
  failed: { url: string; error: string }[];
};

/**
 * Search, then read the best matching pages so the answer is based on several full
 * articles plus dated headlines — not only one-line snippets.
 */
export async function research(query: string, options: { limit?: number; pages?: number; maxChars?: number; freshness?: Freshness | "auto" } = {}): Promise<Research> {
  const limit = Math.min(10, Math.max(3, options.limit ?? 8));
  const { results, source, tried, freshness } = await searchWeb(query, limit, options.freshness ?? "auto");
  const wanted = Math.min(options.pages ?? 3, 4);
  const maxChars = options.maxChars ?? 4500;
  // Readable pages: skip redirect wrappers (news.google.com links); direct article URLs from news feeds are fair game.
  const readable = results.filter((item) => !isRedirectLink(item.url));
  const queue: SearchResult[] = [];
  const seenSites = new Set<string>();
  for (const item of [...readable.filter((item) => item.kind !== "news"), ...readable.filter((item) => item.kind === "news")]) {
    if (seenSites.has(item.site)) continue;
    seenSites.add(item.site);
    queue.push(item);
  }
  for (const item of readable) if (!queue.includes(item)) queue.push(item);
  for (const item of results) if (!queue.includes(item) && !isRedirectLink(item.url) && queue.length < wanted + 3) queue.push(item);

  const pages: Research["pages"] = [];
  const failed: Research["failed"] = [];
  let index = 0;
  while (index < queue.length && pages.length < wanted) {
    const batch = queue.slice(index, index + (wanted - pages.length));
    index += batch.length;
    if (!batch.length) break;
    const read = await readPages(batch.map((item) => item.url), { maxChars });
    for (const page of read.pages) {
      const text = page.text.trim();
      if (text.length < 200) {
        failed.push({ url: page.url, error: `Only ${text.length} readable characters — the page is probably built by JavaScript or is blocking readers. Cite its search snippet instead.` });
        continue;
      }
      pages.push({ title: page.title || page.url, url: page.url, site: siteOf(page.url), text, truncated: page.truncated });
    }
    failed.push(...read.failed);
  }
  const sourceLabel = `${source}${freshness !== "any" ? ` · ${freshness}-fresh` : ""}`;
  return { query, source: sourceLabel, freshness, news: results.filter((item) => item.kind === "news").length, results, pages, failed };
}
