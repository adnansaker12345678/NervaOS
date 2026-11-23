import "server-only";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { bookmarks, events, memories } from "@/db/schema";
import { evaluate } from "@/lib/calc";
import { runJavascript } from "@/lib/coderun";
import { convertUnit, textTool } from "@/lib/localtools";
import { generateImage, makeQrCode } from "@/lib/media";
import { readPage } from "@/lib/reader";
import { research } from "@/lib/search";
import { parseDue } from "@/lib/tasks";
import { cryptoSkill, currencySkill, defineSkill, holidaysSkill, newsSkill, translateSkill, weatherSkill, wikiSkill } from "@/lib/world";

/** Reusable abilities the agent can call. Each returns plain JSON for the model and an optional receipt for the user. */
export type SkillOutcome = {
  result: unknown;
  receipt?: {
    type: "web" | "search" | "terminal" | "calc" | "time" | "skill" | "memory" | "event" | "bookmark";
    title: string; detail?: string; output?: string; ok?: boolean; image?: string; skill?: string;
    results?: { title: string; url: string; snippet: string; site: string }[];
  };
};

export type SkillContext = { workspaceId: string; timezone: string };

const def = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false } },
});

export const skillDefinitions = [
  def("calculate", "Compute an exact arithmetic result. Always use this for any calculation instead of doing math yourself.",
    { expression: { type: "string", description: "For example (12 + 8) * 3.5 or sqrt(144)." } }, ["expression"]),
  def("current_time", "Get the current date and time, optionally in an IANA time zone such as Asia/Dhaka or Europe/London.",
    { timezone: { type: "string" } }),
  def("web_search", "Search the live web and read the best matching pages, Google-style: freshest dated headlines first (Google News) for time-sensitive questions, plus full readable articles. Use it for any current fact, news, price, statistic, person, place, or question you cannot answer reliably yourself. Summarize from the page texts and dated headlines, never from memory.",
    { query: { type: "string", description: "A focused search query, like a person would type." }, freshness: { type: "string", enum: ["auto", "any", "day", "week", "month", "year"], description: "How up-to-date results must be: day for today/latest/breaking, week for news, any for timeless facts. auto detects from the query." }, pages: { type: "integer", description: "How many top pages to read in full: 1 to 4. Default 3." } }, ["query"]),
  def("web_fetch", "Read one exact public web page (http or https) by its URL. Returns the title and several thousand characters of readable text. Use this to go deeper into a specific result from web_search.",
    { url: { type: "string", description: "A full http(s) address." }, maxChars: { type: "integer", description: "How much text to return, 800 to 30000. Default 12000." } }, ["url"]),
  def("terminal", "Run one command in Aura's private, sandboxed terminal. Its files live only in this workspace. Commands: help, pwd, ls, cd, mkdir, cat, head, wc, write, append, touch, grep, rm, echo, date, calc. Save files ONLY with the write command and always quote the text, which may contain < > | &. Never use >, >>, cat >, echo >, or heredocs — they do not exist here. Never use rm unless the user explicitly asked to delete.",
    { command: { type: "string" } }, ["command"]),
  def("weather", "Get the current weather plus a 3-day forecast for any city or place in the world.",
    { place: { type: "string", description: "City or place name, e.g. Dhaka, London, Tokyo." } }, ["place"]),
  def("currency", "Convert money between currencies at today's real exchange rate.",
    { amount: { type: "number" }, from: { type: "string", description: "3-letter code, e.g. USD." }, to: { type: "string", description: "3-letter code, e.g. BDT." } }, ["amount", "from", "to"]),
  def("crypto", "Get live cryptocurrency prices in USD (or another currency).",
    { coins: { type: "string", description: "Comma-separated coin names, e.g. bitcoin, ethereum, solana." }, vs: { type: "string", description: "Currency code, default usd." } }, ["coins"]),
  def("translate", "Translate text into another language.",
    { text: { type: "string" }, target: { type: "string", description: "Target language name or code, e.g. Bengali, bn, Spanish." }, source: { type: "string", description: "Optional source language; auto-detected when omitted." } }, ["text", "target"]),
  def("define", "Look up an English word: pronunciation and real dictionary definitions with examples.",
    { word: { type: "string" } }, ["word"]),
  def("wiki", "Read the Wikipedia summary of any topic, person, or place.",
    { topic: { type: "string" } }, ["topic"]),
  def("news", "Search recent tech and startup news by keyword.",
    { query: { type: "string", description: "A keyword such as AI, space, or startups." } }, ["query"]),
  def("holidays", "List a country's public holidays for a year.",
    { country: { type: "string", description: "Country name or 2-letter code, e.g. Bangladesh or BD." }, year: { type: "integer", description: "Defaults to the current year." } }, ["country"]),
  def("unit_convert", "Convert between units: length, mass, temperature, volume, area, speed, time, data.",
    { value: { type: "number" }, from: { type: "string", description: "e.g. km, kg, C, mph, GB." }, to: { type: "string", description: "e.g. mi, lb, F, km/h, MB." } }, ["value", "from", "to"]),
  def("text_tools", "Transform or analyze text: count, upper, lower, title, slug, reverse, base64encode, base64decode, urlencode, urldecode, json, uuid, password, sha256, reading.",
    { operation: { type: "string" }, text: { type: "string", description: "Required for most operations; not needed for uuid." }, length: { type: "integer", description: "Password length, 8-64." } }, ["operation"]),
  def("js_run", "Run a small JavaScript snippet in a locked sandbox (no network, files, or imports) and see its result. Perfect for data munging, date math, or quick algorithms.",
    { code: { type: "string", description: "JavaScript ending in an expression or using console.log." } }, ["code"]),
  def("qr_code", "Create a QR code image from any text or link. It is saved into the workspace files and shown in the chat.",
    { text: { type: "string" } }, ["text"]),
  def("image_generate", "Generate an AI image from a description. It is shown in the chat and a reference is saved to the workspace files.",
    { prompt: { type: "string", description: "A vivid visual description." } }, ["prompt"]),
  def("memory_remember", "Permanently remember a fact about the user (name, preferences, people, pets, goals). It is shown back in future chats.",
    { fact: { type: "string", description: "One clear fact, e.g. My dog's name is Riku." } }, ["fact"]),
  def("memory_recall", "Search everything remembered about the user, optionally filtered by a keyword.",
    { query: { type: "string", description: "Optional keyword." } }),
  def("memory_forget", "Permanently forget a remembered fact. Only when the user explicitly asks to forget it.",
    { fact: { type: "string", description: "Words from the fact to forget." } }, ["fact"]),
  def("event_add", "Save a dated event: a meeting, birthday, trip, or deadline.",
    { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD or YYYY-MM-DDTHH:mm in the user's time zone." }, notes: { type: "string" } }, ["title", "date"]),
  def("event_list", "List upcoming saved events.", {}),
  def("event_delete", "Delete a saved event by its title. Only when the user explicitly asks to delete it.",
    { event: { type: "string", description: "Words from the event title." } }, ["event"]),
  def("bookmark_save", "Save a web bookmark with an optional note.",
    { url: { type: "string" }, title: { type: "string", description: "Optional; the site name is used when omitted." }, notes: { type: "string" } }, ["url"]),
  def("bookmark_list", "List saved bookmarks.", {}),
  def("bookmark_delete", "Delete a saved bookmark. Only when the user explicitly asks to delete it.",
    { bookmark: { type: "string", description: "Words from the bookmark title or URL." } }, ["bookmark"]),
] as const;

export const skillNames = new Set(skillDefinitions.map((skill) => skill.function.name));

const clean = (value: unknown, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export async function runSkill(name: string, args: Record<string, unknown>, ctx?: SkillContext): Promise<SkillOutcome> {
  switch (name) {
    case "calculate": {
      const expression = clean(args.expression);
      try {
        const { evaluate } = await import("@/lib/calc");
        const value = evaluate(expression);
        return {
          result: { expression, value },
          receipt: { type: "calc", title: expression || "Calculation", detail: `= ${value}`, output: `${expression} = ${value}`, ok: true },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not calculate that expression.";
        return { result: { error: message }, receipt: { type: "calc", title: expression || "Calculation", detail: "Failed", output: message, ok: false } };
      }
    }
    case "current_time": {
      const requested = clean(args.timezone, 60);
      const now = new Date();
      let zone = "UTC";
      if (requested) {
        try { new Intl.DateTimeFormat("en-US", { timeZone: requested }); zone = requested; }
        catch {
          const message = `Unknown time zone “${requested}”. Use an IANA name such as Asia/Dhaka.`;
          return { result: { error: message }, receipt: { type: "time", title: `Time (${requested})`, detail: "Invalid time zone", output: message, ok: false } };
        }
      }
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "full", timeStyle: "medium" }).format(now);
      return {
        result: { timezone: zone, local, isoUtc: now.toISOString() },
        receipt: { type: "time", title: `Current time · ${zone}`, detail: local, ok: true },
      };
    }
    case "web_search": {
      const query = clean(args.query, 300);
      if (!query) return { result: { error: "Give a search query." } };
      const pages = Number(args.pages) || 3;
      const freshness = ["any", "day", "week", "month", "year"].includes(String(args.freshness)) ? (args.freshness as import("@/lib/search").Freshness) : ("auto" as const);
      try {
        const found = await research(query, { limit: 8, pages: Math.min(4, Math.max(1, pages)), maxChars: 4500, freshness });
        return {
          result: {
            query: found.query,
            source: found.source,
            freshness: found.freshness,
            results: found.results.map(({ title, url, snippet, site, date, kind }) => ({ title, url, site, snippet, ...(date ? { date } : {}), ...(kind ? { kind } : {}) })),
            pages: found.pages,
            unreadable: found.failed,
            instruction: "News results are dated — treat the newest dated items as the current state, and say which date your answer reflects. Answer from the page texts and dated headlines above, cite their URLs, and say clearly when sources disagree or do not cover the question.",
          },
          receipt: {
            type: "search",
            title: query,
            detail: `${found.results.length} results${found.news ? ` · ${found.news} fresh headlines` : ""} · read ${found.pages.length} pages · ${found.source}`,
            results: found.results.slice(0, 6),
            ok: found.pages.length > 0 || found.news > 0,
            output: found.pages.length ? `Read ${found.pages.map((page) => page.site).join(", ")}` : found.news ? "Latest headlines captured; full articles were not readable." : `No page could be read. ${found.failed.slice(0, 2).map((item) => item.error).join(" ")}`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "The search failed.";
        return { result: { error: message }, receipt: { type: "search", title: query, detail: "Search failed", output: message, ok: false, results: [] } };
      }
    }
    case "web_fetch": {
      const url = clean(args.url, 2000);
      if (!url) return { result: { error: "Give a page address." } };
      const maxChars = Math.min(30_000, Math.max(800, Number(args.maxChars) || 12_000));
      try {
        const page = await readPage(url, { maxChars });
        return {
          result: { url: page.url, title: page.title, status: page.status, chars: page.chars, truncated: page.truncated, text: page.text },
          receipt: { type: "web", title: page.title || "Web page read", detail: `${page.url} · ${page.chars.toLocaleString()} characters`, output: page.text.slice(0, 1400), ok: true },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "The page could not be read.";
        return { result: { error: message }, receipt: { type: "web", title: url || "Web page", detail: "Could not be read", output: message, ok: false } };
      }
    }
    case "weather": return weatherSkill(clean(args.place, 120));
    case "currency": return currencySkill(Number(args.amount), String(args.from ?? ""), String(args.to ?? ""));
    case "crypto": return cryptoSkill(String(args.coins ?? ""), String(args.vs ?? "usd"));
    case "translate": return translateSkill(String(args.text ?? ""), String(args.target ?? ""), typeof args.source === "string" ? args.source : undefined);
    case "define": return defineSkill(clean(args.word, 60));
    case "wiki": return wikiSkill(clean(args.topic, 120));
    case "news": return newsSkill(clean(args.query, 150) || "technology");
    case "holidays": return holidaysSkill(clean(args.country, 80), Number(args.year) || undefined);
    case "unit_convert": {
      try {
        const { value, from, to } = convertUnit(Number(args.value), String(args.from ?? ""), String(args.to ?? ""));
        const detail = `${args.value} ${from} = ${value} ${to}`;
        return { result: { value, from, to }, receipt: { type: "skill", skill: "unit", title: `Convert · ${from} → ${to}`, detail, output: detail, ok: true } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not convert that.";
        return { result: { error: message }, receipt: { type: "skill", skill: "unit", title: "Convert units", detail: "Failed", output: message, ok: false } };
      }
    }
    case "text_tools": {
      try {
        const { operation, output, extra } = textTool(String(args.operation ?? ""), String(args.text ?? ""), Number(args.length) || undefined);
        return {
          result: { operation, output: output.slice(0, 4000), ...extra },
          receipt: { type: "skill", skill: "text", title: `Text · ${operation}`, detail: output.slice(0, 120), output: output.slice(0, 1200), ok: true },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "That text operation failed.";
        return { result: { error: message }, receipt: { type: "skill", skill: "text", title: "Text tools", detail: "Failed", output: message, ok: false } };
      }
    }
    case "js_run": {
      try {
        const { result, logs } = runJavascript(String(args.code ?? ""));
        const output = [logs.length ? `console:\n${logs.join("\n")}` : "", `result: ${result}`].filter(Boolean).join("\n");
        return { result: { result, logs }, receipt: { type: "skill", skill: "code", title: "JavaScript ran", detail: result.slice(0, 120), output: output.slice(0, 1200), ok: true } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "That code failed.";
        return { result: { error: message }, receipt: { type: "skill", skill: "code", title: "JavaScript", detail: "Failed", output: message, ok: false } };
      }
    }
    case "qr_code": {
      if (!ctx) return { result: { error: "QR codes need a workspace." } };
      try {
        const { file, dataUrl } = await makeQrCode(String(args.text ?? ""), ctx.workspaceId);
        return {
          result: { file, text: clean(args.text, 1000) },
          receipt: { type: "skill", skill: "qr", title: "QR code created", detail: file, image: dataUrl, output: clean(args.text, 1000), ok: true },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "The QR code failed.";
        return { result: { error: message }, receipt: { type: "skill", skill: "qr", title: "QR code", detail: "Failed", output: message, ok: false } };
      }
    }
    case "image_generate": {
      if (!ctx) return { result: { error: "Images need a workspace." } };
      const prompt = clean(args.prompt);
      try {
        const { file, url, dataUrl } = await generateImage(prompt, ctx.workspaceId);
        return {
          result: { prompt, file, url },
          receipt: { type: "skill", skill: "image", title: "Image created", detail: prompt.slice(0, 120), image: dataUrl, output: `Saved reference: ${file}`, ok: true },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "The image failed.";
        return { result: { error: message }, receipt: { type: "skill", skill: "image", title: "Image", detail: "Failed", output: message, ok: false } };
      }
    }
    case "memory_remember": {
      if (!ctx) return { result: { error: "Memory needs a workspace." } };
      const fact = clean(args.fact, 500);
      if (!fact) return { result: { error: "Say the fact to remember." } };
      const existing = await db.select().from(memories).where(and(eq(memories.workspaceId, ctx.workspaceId), ilike(memories.fact, `%${fact.slice(0, 60).replace(/[%_]/g, "")}%`))).limit(5);
      if (existing.some((row) => row.fact.toLowerCase() === fact.toLowerCase())) {
        return { result: { remembered: fact, duplicate: true }, receipt: { type: "memory", title: "Already remembered", detail: fact, ok: true } };
      }
      await db.insert(memories).values({ workspaceId: ctx.workspaceId, fact });
      return { result: { remembered: fact }, receipt: { type: "memory", title: "Remembered", detail: fact, ok: true } };
    }
    case "memory_recall": {
      if (!ctx) return { result: { error: "Memory needs a workspace." } };
      const query = clean(args.query, 200);
      const rows = query
        ? await db.select().from(memories).where(and(eq(memories.workspaceId, ctx.workspaceId), ilike(memories.fact, `%${query.replace(/[%_]/g, "")}%`))).orderBy(desc(memories.createdAt)).limit(20)
        : await db.select().from(memories).where(eq(memories.workspaceId, ctx.workspaceId)).orderBy(desc(memories.createdAt)).limit(20);
      const facts = rows.map((row) => row.fact);
      return {
        result: { facts },
        receipt: { type: "memory", title: query ? `Memories matching “${query}”` : "Everything remembered", detail: facts.length ? `${facts.length} remembered` : "Nothing remembered yet", output: facts.slice(0, 10).join("\n") || undefined, ok: true },
      };
    }
    case "memory_forget": {
      if (!ctx) return { result: { error: "Memory needs a workspace." } };
      const target = clean(args.fact, 200);
      if (!target) return { result: { error: "Say which memory to forget." } };
      const rows = await db.select().from(memories).where(and(eq(memories.workspaceId, ctx.workspaceId), ilike(memories.fact, `%${target.replace(/[%_]/g, "")}%`))).limit(10);
      if (!rows.length) return { result: { error: `Nothing remembered matches “${target}”.` }, receipt: { type: "memory", title: "Nothing to forget", detail: `No match for “${target}”`, ok: false } };
      if (rows.length > 3) return { result: { error: `Several memories match. Be more specific: ${rows.map((row) => `“${row.fact}”`).join("; ")}` }, receipt: { type: "memory", title: "Too many matches", detail: "Be more specific", ok: false } };
      await db.delete(memories).where(and(eq(memories.workspaceId, ctx.workspaceId), or(...rows.map((row) => eq(memories.id, row.id)))));
      return { result: { forgotten: rows.map((row) => row.fact) }, receipt: { type: "memory", title: "Forgotten", detail: rows.map((row) => row.fact).join(" · "), ok: true } };
    }
    case "event_add": {
      if (!ctx) return { result: { error: "Events need a workspace." } };
      const title = clean(args.title, 300);
      const date = parseDue(args.date, ctx.timezone);
      if (!title) return { result: { error: "Give the event a title." } };
      if (!date) return { result: { error: "Give a real date as YYYY-MM-DD or YYYY-MM-DDTHH:mm." }, receipt: { type: "event", title: "Event not saved", detail: "Invalid date", ok: false } };
      const itemNotes = clean(args.notes, 2000);
      const [item] = await db.insert(events).values({ workspaceId: ctx.workspaceId, title, date, notes: itemNotes }).returning();
      return { result: { title: item.title, date: item.date }, receipt: { type: "event", title: "Event saved", detail: `${title} · ${date}`, ok: true } };
    }
    case "event_list": {
      if (!ctx) return { result: { error: "Events need a workspace." } };
      const rows = await db.select().from(events).where(eq(events.workspaceId, ctx.workspaceId)).orderBy(events.date).limit(30);
      const list = rows.map((row) => ({ title: row.title, date: row.date, notes: row.notes }));
      return { result: { events: list }, receipt: { type: "event", title: "Saved events", detail: list.length ? `${list.length} upcoming` : "No events saved", output: list.map((e) => `${e.date} — ${e.title}`).join("\n") || undefined, ok: true } };
    }
    case "event_delete": {
      if (!ctx) return { result: { error: "Events need a workspace." } };
      const target = clean(args.event, 200);
      if (!target) return { result: { error: "Say which event to delete." } };
      const rows = await db.select().from(events).where(and(eq(events.workspaceId, ctx.workspaceId), ilike(events.title, `%${target.replace(/[%_]/g, "")}%`))).limit(10);
      if (!rows.length) return { result: { error: `No event matches “${target}”.` }, receipt: { type: "event", title: "Nothing deleted", detail: `No match for “${target}”`, ok: false } };
      if (rows.length > 3) return { result: { error: "Several events match. Be more specific." }, receipt: { type: "event", title: "Too many matches", detail: "Be more specific", ok: false } };
      await db.delete(events).where(and(eq(events.workspaceId, ctx.workspaceId), or(...rows.map((row) => eq(events.id, row.id)))));
      return { result: { deleted: rows.map((row) => row.title) }, receipt: { type: "event", title: "Event deleted", detail: rows.map((row) => row.title).join(" · "), ok: true } };
    }
    case "bookmark_save": {
      if (!ctx) return { result: { error: "Bookmarks need a workspace." } };
      let url = clean(args.url, 2000);
      if (!url) return { result: { error: "Give a page address to save." } };
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      try { const parsed = new URL(url); if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(); url = parsed.toString(); }
      catch { return { result: { error: "That is not a valid web address." } }; }
      const title = clean(args.title, 300) || new URL(url).hostname.replace(/^www\./, "");
      const itemNotes = clean(args.notes, 2000);
      const [item] = await db.insert(bookmarks).values({ workspaceId: ctx.workspaceId, url, title, notes: itemNotes }).returning();
      return { result: { title: item.title, url: item.url }, receipt: { type: "bookmark", title: "Bookmark saved", detail: `${title} · ${new URL(url).hostname}`, ok: true } };
    }
    case "bookmark_list": {
      if (!ctx) return { result: { error: "Bookmarks need a workspace." } };
      const rows = await db.select().from(bookmarks).where(eq(bookmarks.workspaceId, ctx.workspaceId)).orderBy(desc(bookmarks.createdAt)).limit(30);
      const list = rows.map((row) => ({ title: row.title, url: row.url, notes: row.notes }));
      return { result: { bookmarks: list }, receipt: { type: "bookmark", title: "Saved bookmarks", detail: list.length ? `${list.length} saved` : "No bookmarks saved", output: list.map((b) => `${b.title} — ${b.url}`).join("\n") || undefined, ok: true } };
    }
    case "bookmark_delete": {
      if (!ctx) return { result: { error: "Bookmarks need a workspace." } };
      const target = clean(args.bookmark, 200).replace(/[%_]/g, "");
      if (!target) return { result: { error: "Say which bookmark to delete." } };
      const rows = await db.select().from(bookmarks).where(and(eq(bookmarks.workspaceId, ctx.workspaceId), or(ilike(bookmarks.title, `%${target}%`), ilike(bookmarks.url, `%${target}%`)))).limit(10);
      if (!rows.length) return { result: { error: `No bookmark matches “${target}”.` }, receipt: { type: "bookmark", title: "Nothing deleted", detail: `No match for “${target}”`, ok: false } };
      if (rows.length > 3) return { result: { error: "Several bookmarks match. Be more specific." }, receipt: { type: "bookmark", title: "Too many matches", detail: "Be more specific", ok: false } };
      await db.delete(bookmarks).where(and(eq(bookmarks.workspaceId, ctx.workspaceId), or(...rows.map((row) => eq(bookmarks.id, row.id)))));
      return { result: { deleted: rows.map((row) => row.title) }, receipt: { type: "bookmark", title: "Bookmark deleted", detail: rows.map((row) => row.title).join(" · "), ok: true } };
    }
    default:
      return { result: { error: "That skill is not available." } };
  }
}
