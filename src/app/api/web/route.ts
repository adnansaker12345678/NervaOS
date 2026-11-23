import { research } from "@/lib/search";
import type { Freshness } from "@/lib/search";
import { errorResponse, getWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/** A small read-only search endpoint, used by the app and handy for checking results. */
export async function GET(request: Request) {
  try {
    await getWorkspace(request);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
    if (!q) return Response.json({ error: "Give a query with ?q=" }, { status: 400 });
    const freshnessParam = url.searchParams.get("freshness");
    const freshness = freshnessParam === "day" || freshnessParam === "week" || freshnessParam === "month" || freshnessParam === "year" || freshnessParam === "any" ? (freshnessParam as Freshness) : ("auto" as const);
    const found = await research(q, { limit: 8, pages: Math.min(3, Math.max(1, Number(url.searchParams.get("pages")) || 2)), maxChars: 2500, freshness });
    return Response.json({
      query: found.query, source: found.source, freshness: found.freshness, news: found.news,
      results: found.results.map(({ title, url: resultUrl, snippet, site, date, kind }) => ({ title, url: resultUrl, snippet, site, ...(date ? { date } : {}), ...(kind ? { kind } : {}) })),
      pages: found.pages.map(({ title, url: pageUrl, site, text, truncated }) => ({ title, url: pageUrl, site, chars: text.length, truncated, preview: text.slice(0, 600) })),
      failed: found.failed,
    });
  } catch (error) {
    if (error instanceof Error && /No search results/.test(error.message)) return Response.json({ error: error.message }, { status: 502 });
    return errorResponse(error);
  }
}
