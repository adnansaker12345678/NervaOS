import "server-only";
import type { Browser, BrowserContext, Page } from "playwright";
import { isPublicHost } from "@/lib/net-guard";

/**
 * A real Chromium browser for the agent. Sessions are per-workspace, ephemeral
 * (no saved cookies or logins), limited in number, and closed when idle.
 * Every request the browser makes is checked: only public http(s) hosts load.
 */

export type PageLink = { text: string; href: string };
export type PageField = { label: string; type: string };
export type PageState = {
  url: string;
  title: string;
  status: number | null;
  text: string;
  links: PageLink[];
  fields: PageField[];
  truncated: boolean;
  screenshot?: string;
};

export type BrowserAction = "open" | "click" | "type" | "press" | "scroll" | "back" | "forward" | "read" | "screenshot" | "close";

const MAX_SESSIONS = 3;
const IDLE_MS = 10 * 60_000;
const TEXT_LIMIT = 6000;
const VIEWPORT = { width: 1280, height: 800 };

type Session = { context: BrowserContext; page: Page; lastUsed: number };
type Registry = typeof globalThis & { __auraBrowser?: Browser | null; __auraBrowserStarting?: Promise<Browser> | null; __auraSessions?: Map<string, Session> };
const registry = globalThis as Registry;
const sessions = registry.__auraSessions ?? (registry.__auraSessions = new Map<string, Session>());

export class BrowserUnavailableError extends Error {}

function unavailable(reason: string) {
  return new BrowserUnavailableError(`The built-in Chromium browser couldn't start on this server (${reason}). Aura can still read public pages with its page reader; say so honestly and offer that.`);
}

/** Finds a Chromium binary: an explicit path, project-local browsers, or any Playwright cache on this host. */
function findChromium(): string | undefined {
  const roots: string[] = [];
  if (process.env.AURA_CHROMIUM_PATH) roots.push(process.env.AURA_CHROMIUM_PATH);
  const homes = [process.env.HOME, "/root", "/home/user", "/home/node", "/tmp", process.cwd()].filter(Boolean) as string[];
  for (const home of homes) {
    roots.push(`${home}/.cache/ms-playwright`, `${home}/.cache/ms-playwright-go`, `${home}/.browsers`, `${home}/.cache/puppeteer`);
  }
  roots.push(`${process.cwd()}/.browsers`, `${process.cwd()}/node_modules/.cache/ms-playwright`);
  const direct = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/snap/bin/chromium"];
  for (const candidate of direct) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const exists = (() => { try { return require("node:fs").existsSync(candidate); } catch { return false; } })();
    if (exists) return candidate;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  for (const root of roots) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries.sort().reverse()) {
      for (const relative of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]) {
        const full = path.join(root, entry, relative);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return undefined;
}

async function getBrowser(): Promise<Browser> {
  if (registry.__auraBrowser?.isConnected()) return registry.__auraBrowser;
  if (!registry.__auraBrowserStarting) {
    registry.__auraBrowserStarting = (async () => {
      let chromium: typeof import("playwright").chromium;
      try { ({ chromium } = await import("playwright")); }
      catch (error) { throw unavailable(error instanceof Error ? error.message.slice(0, 160) : "module missing"); }
      try {
        const browser = await chromium.launch({
          headless: true,
          executablePath: findChromium(),
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
        });
        browser.on("disconnected", () => { registry.__auraBrowser = null; registry.__auraBrowserStarting = null; sessions.clear(); });
        registry.__auraBrowser = browser;
        return browser;
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to launch";
        throw unavailable(message.includes("Executable doesn't exist") ? "Chromium isn't installed here" : message.slice(0, 160));
      } finally {
        if (!registry.__auraBrowser) registry.__auraBrowserStarting = null;
      }
    })();
  }
  try { return await registry.__auraBrowserStarting; }
  finally { if (registry.__auraBrowser) registry.__auraBrowserStarting = null; }
}

/** True when a browser can actually start here. Cached after the first successful launch. */
export async function browserAvailable(): Promise<{ available: boolean; reason?: string }> {
  try { await getBrowser(); return { available: true }; }
  catch (error) { return { available: false, reason: error instanceof Error ? error.message : "Chromium is unavailable." }; }
}

async function sessionPage(workspaceId: string, timezone: string): Promise<Session> {
  const existing = sessions.get(workspaceId);
  if (existing && existing.context.browser()?.isConnected()) {
    existing.lastUsed = Date.now();
    return existing;
  }
  sessions.delete(workspaceId);
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > IDLE_MS) { await session.context.close().catch(() => undefined); sessions.delete(id); }
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!oldest) break;
    await oldest[1].context.close().catch(() => undefined);
    sessions.delete(oldest[0]);
  }
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: timezone,
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  // Only public http(s) resources may load; this also stops metadata/loopback access.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    if (!/^https?:/i.test(url)) {
      if (/^(data|blob|about):/i.test(url)) return route.continue();
      return route.abort();
    }
    try {
      const host = new URL(url).hostname;
      if (await isPublicHost(host)) return route.continue();
    } catch { /* Fall through to abort. */ }
    return route.abort();
  });
  const page = await context.newPage();
  context.on("page", (popup) => { if (popup !== page) void popup.close().catch(() => undefined); });
  page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
  const session: Session = { context, page, lastUsed: Date.now() };
  sessions.set(workspaceId, session);
  return session;
}

async function settle(page: Page, ms = 700) {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

export async function capturePage(page: Page, includeScreenshot = true): Promise<PageState> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const body = await page.evaluate(() => {
    const root = (document.querySelector("main, article, [role=main]") ?? document.body) as HTMLElement;
    return (root?.innerText ?? "").replace(/\u00a0/g, " ");
  }).catch(() => "");
  const text = body.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].slice(0, 400).map((anchor) => {
    const element = anchor as HTMLAnchorElement;
    const label = ((element as HTMLElement).innerText || element.getAttribute("aria-label") || element.title || "").replace(/\s+/g, " ").trim();
    return { text: label.slice(0, 120), href: element.href };
  }).filter((link) => link.text && /^https?:/i.test(link.href))).catch(() => []);
  const unique: PageLink[] = [];
  for (const link of links) if (!unique.some((item) => item.href === link.href)) unique.push(link);
  const fields = await page.evaluate(() => [...document.querySelectorAll("input, textarea, select")].slice(0, 40).map((input) => {
    const element = input as HTMLInputElement;
    const label = (element.labels?.[0] as HTMLElement | undefined)?.innerText || element.getAttribute("aria-label") || element.placeholder || element.name || "";
    return { label: label.replace(/\s+/g, " ").trim().slice(0, 90), type: (element.type || element.tagName).toLowerCase() };
  }).filter((field) => field.type !== "hidden")).catch(() => []);
  let screenshot: string | undefined;
  if (includeScreenshot) {
    const buffer = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false, timeout: 15_000 }).catch(() => null);
    if (buffer) screenshot = `data:image/jpeg;base64,${buffer.toString("base64")}`;
  }
  return {
    url,
    title: title.slice(0, 200),
    status: null,
    text: text.slice(0, TEXT_LIMIT),
    links: unique.slice(0, 25),
    fields,
    truncated: text.length > TEXT_LIMIT,
    screenshot,
  };
}

function summarize(state: PageState): Record<string, unknown> {
  return ({
    url: state.url,
    title: state.title,
    text: state.text,
    truncated: state.truncated,
    links: state.links,
    fields: state.fields,
    note: state.screenshot ? "A screenshot of this page was shown to the user." : undefined,
  });
}

/** A failed navigation leaves Chromium on its own error page; say so plainly. */
function navigationFailed(state: PageState) {
  return state.url.startsWith("chrome-error://");
}

export async function browserOpen(workspaceId: string, timezone: string, rawUrl: string): Promise<{ state: PageState; forModel: Record<string, unknown> }> {
  const candidate = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error("That is not a valid web address."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses can be opened.");
  if (!await isPublicHost(url.hostname)) throw new Error("Private and local addresses cannot be opened in the browser.");
  const { page } = await sessionPage(workspaceId, timezone);
  const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error: unknown) => {
    throw new Error(/timeout/i.test(String(error)) ? "The page took too long to load." : "That page could not be loaded.");
  });
  await settle(page);
  const state = await capturePage(page);
  state.status = response?.status() ?? null;
  return { state, forModel: summarize(state) };
}

export async function browserAct(workspaceId: string, timezone: string, input: { action: string; selector?: string; text?: string; value?: string; key?: string }): Promise<{ state: PageState; forModel: Record<string, unknown> }> {
  const session = sessions.get(workspaceId);
  if (!session) throw new Error("No browser session is open. Use browser_open with a URL first.");
  const page = await sessionPage(workspaceId, timezone).then((item) => item.page);
  const text = (input.text ?? "").trim();
  const selector = (input.selector ?? "").trim();
  const action = (input.action ?? "").trim().toLowerCase();

  if (action === "click") {
    if (!text && !selector) throw new Error("Say what to click, by its visible text or a CSS selector.");
    const before = page.url();
    const candidates = selector ? [page.locator(selector)] : [
      page.getByRole("link", { name: text, exact: true }),
      page.getByRole("button", { name: text, exact: true }),
      page.getByRole("tab", { name: text, exact: true }),
      page.getByRole("link", { name: text }),
      page.getByRole("button", { name: text }),
      page.getByText(text, { exact: true }),
    ];
    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      if (!count) continue;
      const target = candidate.first();
      if (!await target.isVisible().catch(() => false)) continue;
      const href = await target.getAttribute("href").catch(() => null);
      const follow = href && /^https?:/i.test(href) ? href : null;
      if (follow) {
        // Following the link's own address is deterministic and avoids racing the page.
        const guarded = /^https?:/i.test(follow) ? follow : new URL(follow, before).toString();
        if (!await isPublicHost(new URL(guarded).hostname)) throw new Error("That link points to a private address, so it was not opened.");
        await page.goto(guarded, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      } else {
        await target.click({ timeout: 10_000 }).catch(() => undefined);
      }
      await settle(page, 900);
      const state = await capturePage(page);
      if (navigationFailed(state)) throw new Error(`“${text || selector}” led to a page that failed to load (${before}). Try another link or the page reader.`);
      return { state, forModel: { clicked: text || selector, ...summarize(state) } };
    }
    const state = await capturePage(page, false);
    const options = [...state.links.map((link) => `link “${link.text}”`)].slice(0, 15).join(", ");
    throw new Error(`Nothing on the page matched “${text || selector}”. Visible links: ${options || "none"}.`);
  }

  if (action === "type") {
    const value = input.value ?? "";
    if (!value) throw new Error("Give the text to type.");
    const target = selector ? page.locator(selector).first()
      : page.getByPlaceholder(text).first();
    let field = target;
    if (!selector) {
      const byPlaceholder = page.getByPlaceholder(text).first();
      const byLabel = page.getByLabel(text).first();
      const byRole = page.getByRole("textbox", { name: text }).first();
      field = (await byLabel.count().catch(() => 0)) ? byLabel : (await byRole.count().catch(() => 0)) ? byRole : byPlaceholder;
    }
    if (!await field.count().catch(() => 0)) field = page.locator("input:visible, textarea:visible, [contenteditable=true]:visible").first();
    if (!await field.count().catch(() => 0)) throw new Error("No text field was found on the page.");
    await field.fill(value, { timeout: 10_000 }).catch(async () => { await field.click(); await page.keyboard.type(value, { delay: 15 }); });
    await page.waitForTimeout(250);
    const state = await capturePage(page);
    return { state, forModel: { typed: text || selector || "first text field", ...summarize(state) } };
  }

  if (action === "press") {
    const key = (input.key || text || "Enter").trim();
    await page.keyboard.press(key).catch(() => { throw new Error(`The key “${key}” could not be pressed.`); });
    await settle(page, 900);
    const state = await capturePage(page);
    return { state, forModel: { pressed: key, ...summarize(state) } };
  }

  if (action === "scroll") {
    const direction = (input.value || text || "down").toLowerCase();
    if (direction === "top") await page.evaluate(() => window.scrollTo({ top: 0 }));
    else if (direction === "bottom") await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
    else await page.mouse.wheel(0, direction === "up" ? -700 : 700);
    await page.waitForTimeout(450);
    const state = await capturePage(page);
    return { state, forModel: { scrolled: direction, ...summarize(state) } };
  }

  if (action === "back" || action === "forward") {
    const response = action === "back" ? await page.goBack({ timeout: 20_000 }).catch(() => null) : await page.goForward({ timeout: 20_000 }).catch(() => null);
    if (!response) throw new Error(`There is no page to go ${action} to.`);
    await settle(page);
    const state = await capturePage(page);
    return { state, forModel: { navigated: action, ...summarize(state) } };
  }

  if (action === "screenshot") {
    const state = await capturePage(page);
    return { state, forModel: { screenshot: true, ...summarize(state) } };
  }

  if (action === "read") {
    const state = await capturePage(page, false);
    return { state, forModel: summarize(state) };
  }

  throw new Error("The browser can open, click, type, press a key, scroll, go back, go forward, read, take a screenshot, or close. Pick one of those.");
}

export async function browserRead(workspaceId: string): Promise<{ state: PageState; forModel: Record<string, unknown> }> {
  const session = sessions.get(workspaceId);
  if (!session) throw new Error("No browser session is open. Use browser_open with a URL first.");
  session.lastUsed = Date.now();
  const state = await capturePage(session.page, false);
  return { state, forModel: summarize(state) };
}

export async function browserShot(workspaceId: string): Promise<string | null> {
  const session = sessions.get(workspaceId);
  if (!session) return null;
  session.lastUsed = Date.now();
  return (await capturePage(session.page)).screenshot ?? null;
}

export async function browserStatus(workspaceId: string) {
  const session = sessions.get(workspaceId);
  if (!session) return { open: false as const };
  session.lastUsed = Date.now();
  const state = await capturePage(session.page, false);
  return { open: true as const, url: state.url, title: state.title, text: state.text.slice(0, 400) };
}

export async function browserClose(workspaceId: string) {
  const session = sessions.get(workspaceId);
  if (!session) return { closed: false };
  sessions.delete(workspaceId);
  await session.context.close().catch(() => undefined);
  return { closed: true };
}
