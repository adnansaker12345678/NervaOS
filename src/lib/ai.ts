import "server-only";
import type { EngineInfo } from "@/lib/types";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type TurnResult = { text: string; toolCalls: ToolCall[]; engineId?: string; engine?: string; model?: string };

export type EngineProvider = {
  id: string;
  label: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  keyless: boolean;
  /** Requests allowed per window on the free tier. 0 means no known limit. */
  rpm: number;
  windowMs: number;
  /** How long to wait for the first byte before trying the next engine. */
  firstByteMs: number;
  maxTokens: number;
  /** Slow engine of last resort: never started just to shave time off a faster one. */
  lastResort?: boolean;
  /** Extra request fields, e.g. a low reasoning effort for reasoning models. */
  extraBody?: Record<string, unknown>;
  vision: boolean;
  note: string;
};

const OVH = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions";
const APISFREE = "https://api.apisfreellm.com/v1/chat/completions";
const paid = { rpm: 0, windowMs: 60_000, firstByteMs: 20_000, maxTokens: 1600 };

/**
 * Server-only provider resolution. Any key configured on the server is tried first,
 * but the keyless engines are ALWAYS included as fallbacks, so an exhausted or invalid
 * key never blocks the agent. No key is ever accepted from the browser.
 *
 * The keyless pool is ordered fastest-first. Every entry was measured from this
 * backend (first token and characters per second) and verified for tool calling.
 * OVH limits each model separately (about two requests a minute), so rotating
 * across models avoids waiting for any single cooldown.
 */
export function providers(): EngineProvider[] {
  const configured: EngineProvider[] = [];
  if (process.env.AURA_AI_BASE_URL) {
    const base = process.env.AURA_AI_BASE_URL.replace(/\/+$/, "");
    configured.push({
      ...paid, id: "self-hosted", label: process.env.AURA_AI_LABEL || "Self-hosted engine",
      endpoint: base.endsWith("/chat/completions") ? base : `${base}/chat/completions`,
      model: process.env.AURA_AI_MODEL || "local-model", apiKey: process.env.AURA_AI_KEY,
      keyless: false, vision: process.env.AURA_AI_VISION !== "false",
      note: "Requests stay inside your own AI infrastructure.",
    });
  }
  if (process.env.OPENAI_API_KEY) configured.push({ ...paid, id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", model: process.env.OPENAI_MODEL || "gpt-4.1-mini", apiKey: process.env.OPENAI_API_KEY, keyless: false, vision: true, note: "Server-side connection to OpenAI." });
  if (process.env.GROQ_API_KEY) configured.push({ ...paid, id: "groq", label: "Groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", model: process.env.AURA_AI_MODEL || "openai/gpt-oss-20b", apiKey: process.env.GROQ_API_KEY, keyless: false, vision: false, note: "Server-side connection to Groq." });
  if (process.env.OPENROUTER_API_KEY) configured.push({ ...paid, id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions", model: process.env.AURA_AI_MODEL || "openai/gpt-oss-20b:free", apiKey: process.env.OPENROUTER_API_KEY, keyless: false, vision: false, note: "Server-side connection to OpenRouter." });

  const free = { keyless: true, vision: false, rpm: 2, windowMs: 65_000, firstByteMs: 10_000, maxTokens: 1600 };
  const keyless: EngineProvider[] = [
    // Independent healthy gateways first so shared-IP OVH rate limits never stall chat or spam failures.
    { keyless: true, vision: false, rpm: 5, windowMs: 62_000, firstByteMs: 10_000, maxTokens: 1600, id: "apisfreellm", label: "APIsFreeLLM", endpoint: APISFREE, model: "free-ai", note: "Independent keyless gateway (~5 req/min burst, sub-second start)." },
    { ...free, id: "pollinations", label: "Pollinations GPT-OSS", endpoint: "https://text.pollinations.ai/openai", model: "openai-fast", rpm: 1, windowMs: 35_000, firstByteMs: 25_000, extraBody: { reasoning_effort: "low" }, note: "Independent keyless fallback gateway." },
    { ...free, rpm: 1, id: "ovh-qwen35-397b", label: "Qwen 3.5 397B", endpoint: OVH, model: "Qwen3.5-397B-A17B", extraBody: { reasoning_effort: "none" }, note: "Fast verified OVH MoE engine (~0.4s first token)." },
    { ...free, id: "ovh-gpt-oss-120b", label: "GPT-OSS 120B", endpoint: OVH, model: "gpt-oss-120b", extraBody: { reasoning_effort: "low" }, note: "Fast verified OVH engine: first words in about a second." },
    { ...free, id: "ovh-mistral-small", label: "Mistral Small 3.2", endpoint: OVH, model: "Mistral-Small-3.2-24B-Instruct-2506", note: "Fast verified OVH engine." },
    { ...free, id: "ovh-qwen36", label: "Qwen 3.6 27B", endpoint: OVH, model: "Qwen3.6-27B", extraBody: { reasoning_effort: "none" }, note: "Fast verified OVH engine." },
    { ...free, id: "ovh-llama-70b", label: "Llama 3.3 70B", endpoint: OVH, model: "Meta-Llama-3_3-70B-Instruct", note: "Fast verified OVH engine." },
    { ...free, id: "ovh-gpt-oss-20b", label: "GPT-OSS 20B", endpoint: OVH, model: "gpt-oss-20b", extraBody: { reasoning_effort: "low" }, note: "Fast verified OVH engine." },
    { ...free, id: "ovh-qwen38", label: "Qwen 3.8 27B", endpoint: OVH, model: "Qwen3.8-27B", extraBody: { reasoning_effort: "none" }, note: "Fast verified OVH engine." },
    { ...free, rpm: 1, id: "ovh-qwen35-9b", label: "Qwen 3.5 9B", endpoint: OVH, model: "Qwen3.5-9B", extraBody: { reasoning_effort: "none" }, note: "Fast lightweight OVH engine." },
  ];
  return [...configured, ...keyless];
}

/** Credit, billing, or key problems are not temporary: rotate away for a long while. */
const EXHAUSTED_MS = 60 * 60_000;

export class RateLimitError extends Error {
  seconds: number;
  rawSeconds: number;
  constructor(seconds: number, rawSeconds = seconds) {
    super(`Free engine cooling down for ${seconds}s.`);
    this.name = "RateLimitError";
    this.seconds = Math.max(3, Math.ceil(seconds));
    this.rawSeconds = Math.max(this.seconds, Math.ceil(rawSeconds));
  }
}
export class EngineError extends Error {
  fatal: boolean;
  /** When set, this engine is taken out of rotation for this long and the next engine is tried. */
  cooldownMs: number;
  constructor(message: string, fatal = false, cooldownMs = 0) { super(message); this.name = "EngineError"; this.fatal = fatal; this.cooldownMs = cooldownMs; }
}

type State = { until: Record<string, number>; hostUntil: Record<string, number>; hits: Record<string, number[]> };
const globalForEngine = globalThis as typeof globalThis & { __auraEngineState3?: State };
const engineState = globalForEngine.__auraEngineState3 ?? (globalForEngine.__auraEngineState3 = { until: {}, hostUntil: {}, hits: {} });

function providerHost(provider: EngineProvider): string {
  try { return new URL(provider.endpoint).hostname; } catch { return provider.id; }
}

/** When this engine can next be called: after any cooldown, host backoff, and free-tier window room. */
function availableAt(provider: EngineProvider, now = Date.now()): number {
  let at = Math.max(engineState.until[provider.id] || 0, engineState.hostUntil[providerHost(provider)] || 0);
  if (provider.rpm > 0) {
    const recent = (engineState.hits[provider.id] ?? []).filter((time) => now - time < provider.windowMs);
    engineState.hits[provider.id] = recent;
    if (recent.length >= provider.rpm) at = Math.max(at, recent[recent.length - provider.rpm] + provider.windowMs);
  }
  return at;
}

/**
 * Ready engines first, keeping preferredId at the front when it is available so a
 * multi-step reply stays on one consistent engine instead of switching mid-response.
 */
function rankProviders(list: EngineProvider[], now = Date.now(), preferredId?: string) {
  return list
    .map((provider, index) => ({ provider, index, at: availableAt(provider, now), preferred: preferredId && provider.id === preferredId ? 0 : 1 }))
    .sort((a, b) => {
      const aReady = a.at <= now ? 0 : 1;
      const bReady = b.at <= now ? 0 : 1;
      if (aReady !== bReady) return aReady - bReady;
      if (aReady === 0 && a.preferred !== b.preferred) return a.preferred - b.preferred;
      return (Math.max(a.at, now) - Math.max(b.at, now)) || (a.index - b.index);
    });
}

const MAX_WAIT_MS = 95_000;
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new EngineError("Response stopped.", true)); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
  const stop = () => { done(); reject(new EngineError("Response stopped.", true)); };
  const timer = setTimeout(() => { done(); resolve(); }, ms);
  signal.addEventListener("abort", stop, { once: true });
});

export function engineInfo(): EngineInfo {
  const list = providers();
  const now = Date.now();
  const ranked = rankProviders(list, now);
  const active = ranked[0].provider;
  const ready = ranked.filter((entry) => entry.at <= now).length;
  return {
    id: active.id, label: active.label, model: active.model, keyless: active.keyless, vision: active.vision,
    note: list.length > 1
      ? `Next up: ${active.label}. ${ready} of ${list.length} engines are ready right now; Aura switches between them instantly so replies start fast.`
      : active.note,
    alternates: Math.max(0, list.length - 1),
    cooldownSeconds: Math.max(0, Math.ceil((ranked[0].at - now) / 1000)),
  };
}

function retryInfo(headers: Headers, body: string) {
  const fromBody = body.match(/retry after\s*(\d+)/i)?.[1];
  const fromHeader = headers.get("retry-after")?.match(/\d+/)?.[0];
  const value = Number(fromBody || fromHeader || 45);
  const rawSeconds = Number.isFinite(value) ? Math.max(3, Math.ceil(value)) : 45;
  return { seconds: Math.min(180, rawSeconds), rawSeconds };
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** Engines disagree about tool-call id formats, and a reply may continue on a different engine. Nine letters or digits works everywhere. */
const callId = () => Array.from({ length: 9 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");

const friendly = (status: number) => {
  if (status === 401 || status === 403) return "The backend AI engine rejected its server credentials.";
  if (status === 429 || status === 402) return "The free engine is busy.";
  if (status >= 500) return "The backend AI engine is temporarily unavailable.";
  return "The backend AI engine could not complete this request.";
};

/** Thrown inside an attempt that another engine beat to the first word. */
class LostRace extends Error {}
type Sink = { claim: () => boolean; onDelta: (text: string) => void };
type ToolChoice = { type: "function"; function: { name: string } };

/** One request to one engine. It only speaks through the sink once it has claimed the reply. */
async function attempt(provider: EngineProvider, messages: ChatMessage[], tools: unknown[], outer: AbortSignal, cancel: AbortSignal, sink: Sink, toolChoice?: ToolChoice): Promise<TurnResult> {
  const body: Record<string, unknown> = { model: provider.model, messages, stream: true, temperature: 0.4, max_tokens: provider.maxTokens, ...provider.extraBody };
  if (tools.length) { body.tools = tools; body.tool_choice = toolChoice ?? "auto"; }
  // A stalled engine must not hold the reply hostage.
  const watchdog = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { stalled = true; watchdog.abort(); }, provider.firstByteMs);
  const beat = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; watchdog.abort(); }, ms); };
  const signal = AbortSignal.any([outer, cancel, watchdog.signal]);
  let claimed = false;
  const claim = () => { if (claimed) return; if (!sink.claim()) throw new LostRace(); claimed = true; };

  let response: Response;
  try {
    response = await fetch(provider.endpoint, {
      method: "POST", signal,
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        ...(provider.id === "openrouter" ? { "HTTP-Referer": "https://aura-workspace.app", "X-Title": "Aura" } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    clearTimeout(timer);
    if (outer.aborted) throw new EngineError("Response stopped.", true);
    if (cancel.aborted) throw new LostRace();
    if (stalled) throw new EngineError(`${provider.label} was too slow to start.`, false, 30_000);
    throw new EngineError(`I couldn’t reach the backend AI engine. ${error instanceof Error && /timeout/i.test(error.message) ? "The request timed out." : "Please try again in a moment."}`);
  }
  if (response.status === 402 || response.status === 429) {
    clearTimeout(timer);
    const text = await response.text().catch(() => "");
    if (/insufficient_quota|no credits|credit balance|billing|exhausted/i.test(text)) {
      throw new EngineError(`${provider.label} has no credits left.`, false, EXHAUSTED_MS);
    }
    const { seconds, rawSeconds } = retryInfo(response.headers, text);
    throw new RateLimitError(seconds, rawSeconds);
  }
  if (response.status === 401 || response.status === 403) {
    clearTimeout(timer);
    await response.text().catch(() => "");
    throw new EngineError(`${provider.label} rejected its server credentials.`, false, EXHAUSTED_MS);
  }
  if (!response.ok) { clearTimeout(timer); await response.text().catch(() => ""); throw new EngineError(friendly(response.status)); }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      const data = await response.json();
      clearTimeout(timer);
      const message = data?.choices?.[0]?.message ?? {};
      const text = typeof message.content === "string" ? message.content.trim() : "";
      const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
        ? message.tool_calls.filter((call: { function?: { name?: unknown } }) => typeof call?.function?.name === "string").map((call: { function: { name: string; arguments?: string } }) => ({
          id: callId(), type: "function" as const, function: { name: call.function.name, arguments: call.function.arguments || "{}" },
        }))
        : [];
      if (!text && !toolCalls.length) throw new EngineError("The backend AI engine returned an empty reply.");
      claim();
      if (text) sink.onDelta(text);
      return { text, toolCalls };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof LostRace || error instanceof EngineError) throw error;
      if (outer.aborted) throw new EngineError("Response stopped.", true);
      if (cancel.aborted) throw new LostRace();
      throw new EngineError(stalled ? `${provider.label} stopped responding.` : "The backend AI engine sent an unreadable reply.", false, stalled ? 30_000 : 0);
    }
  }
  if (!response.body) { clearTimeout(timer); throw new EngineError("The backend AI engine returned an empty stream."); }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const pending = new Map<number, { name: string; arguments: string }>();
  const consume = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event: { choices?: { delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] } }[]; error?: unknown };
      try { event = JSON.parse(data); } catch { continue; }
      if (event.error) throw new EngineError("The backend AI engine reported an error.");
      const delta = event.choices?.[0]?.delta;
      const content = typeof delta?.content === "string" ? delta.content : "";
      // The first sign of real work (thinking, text, or a tool call) wins the reply for this engine.
      if (content || delta?.tool_calls?.length || delta?.reasoning || delta?.reasoning_content) claim();
      if (content) { text += content; sink.onDelta(content); }
      for (const update of delta?.tool_calls ?? []) {
        const index = Number.isInteger(update.index) ? (update.index as number) : pending.size;
        const call = pending.get(index) ?? { name: "", arguments: "" };
        if (update.function?.name) call.name += update.function.name;
        if (update.function?.arguments) call.arguments += update.function.arguments;
        pending.set(index, call);
      }
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      beat(25_000);
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) { const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); consume(block); }
    }
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    if (error instanceof LostRace) throw error;
    if (outer.aborted) throw new EngineError("Response stopped.", true);
    if (cancel.aborted) throw new LostRace();
    // Text already shown must not be thrown away; a stall before any text lets another engine take over.
    if (stalled && !text.trim() && !pending.size) throw new EngineError(`${provider.label} stopped responding.`, false, 30_000);
    if (!stalled) throw error instanceof EngineError || error instanceof RateLimitError ? error : new EngineError("The AI stream was interrupted.");
  } finally { clearTimeout(timer); reader.releaseLock(); }

  const toolCalls: ToolCall[] = [...pending.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
    id: callId(), type: "function" as const, function: { name: call.name, arguments: call.arguments || "{}" },
  })).filter((call) => call.function.name);
  if (!text.trim() && !toolCalls.length) throw new EngineError("The backend AI engine returned no visible text.");
  return { text: text.trim(), toolCalls };
}

/** If the first engine has not started within this long, a second one is started alongside it. */
const HEDGE_MS = [1_500, 3_600];

/**
 * Free engines start anywhere between half a second and ten seconds. Instead of
 * waiting on one, a slow starter gets company: whichever engine produces the
 * first word wins the reply and the others are cancelled.
 */
function race(order: EngineProvider[], messages: ChatMessage[], tools: unknown[], signal: AbortSignal, onDelta: (text: string) => void, onStatus: (text: string) => void, toolChoice?: ToolChoice): Promise<TurnResult> {
  return new Promise<TurnResult>((resolve, reject) => {
    let winner: string | null = null;
    let settled = false;
    let inFlight = 0;
    let cursor = 0;
    let lastError: Error | null = null;
    const cancels = new Map<string, AbortController>();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      for (const [id, cancel] of cancels) if (id !== winner) cancel.abort();
      run();
    };
    const next = (hedge: boolean): EngineProvider | null => {
      while (cursor < order.length) {
        const provider = order[cursor];
        if (hedge && provider.lastResort) return null;
        cursor += 1;
        if (availableAt(provider) <= Date.now()) return provider;
      }
      return null;
    };
    const launch = (hedge: boolean) => {
      if (settled || winner) return;
      const provider = next(hedge);
      if (!provider) {
        if (!inFlight && !hedge) finish(() => reject(lastError ?? new EngineError("Every backend engine is busy right now.")));
        return;
      }
      const cancel = new AbortController();
      cancels.set(provider.id, cancel);
      inFlight += 1;
      const started = Date.now();
      (engineState.hits[provider.id] ??= []).push(started);
      const sink: Sink = {
        claim: () => {
          if (winner && winner !== provider.id) return false;
          if (!winner) {
            winner = provider.id;
            timers.forEach(clearTimeout);
            for (const [id, other] of cancels) if (id !== provider.id) other.abort();
            console.info(`[aura-engine] ${provider.id} started in ${Date.now() - started}ms${cancels.size > 1 ? ` (beat ${cancels.size - 1} other)` : ""}`);
          }
          return true;
        },
        onDelta: (text) => { if (winner === provider.id) onDelta(text); },
      };
      attempt(provider, messages, tools, signal, cancel.signal, sink, toolChoice)
        .then((result) => {
          inFlight -= 1;
          console.info(`[aura-engine] ${provider.id} done in ${Date.now() - started}ms (${result.toolCalls.length ? `${result.toolCalls.length} tool call(s)` : `${result.text.length} chars`})`);
          finish(() => resolve({ ...result, engineId: provider.id, engine: provider.label, model: provider.model }));
        })
        .catch((error: unknown) => {
          inFlight -= 1;
          if (error instanceof LostRace) return;
          lastError = error instanceof Error ? error : new EngineError("The backend AI engine failed unexpectedly.");
          if (winner === provider.id || (error instanceof EngineError && error.fatal)) {
            console.info(`[aura-engine] ${provider.id} stopped after ${Date.now() - started}ms: ${lastError.message.slice(0, 90)}`);
            finish(() => reject(lastError));
            return;
          }
          if (error instanceof RateLimitError) {
            engineState.until[provider.id] = Date.now() + error.seconds * 1000;
            if (error.rawSeconds >= 300) {
              // Multi-minute/multi-day Retry-After indicates an IP/host quota block; back off the whole host.
              engineState.hostUntil[providerHost(provider)] = Date.now() + 30 * 60_000;
            }
            console.info(`[aura-engine] ${provider.id} resting (${error.seconds}s) after ${Date.now() - started}ms; rotating`);
          } else {
            engineState.until[provider.id] = Date.now() + (error instanceof EngineError && error.cooldownMs ? error.cooldownMs : 20_000);
            console.info(`[aura-engine] ${provider.id} skipped after ${Date.now() - started}ms: ${lastError.message.slice(0, 90)}`);
          }
          if (settled || winner) return;
          launch(false);
        });
    };
    launch(false);
    for (const delay of HEDGE_MS) timers.push(setTimeout(() => launch(true), delay));
  });
}

/**
 * Picks ready engines fastest-first and races slow starters. A rate-limited engine
 * is skipped at once, so a busy free tier never blocks chat.
 * Returns the model's text and any tool calls it requested for this turn.
 */
export async function streamReply(options: {
  messages: ChatMessage[];
  tools?: unknown[];
  toolChoice?: ToolChoice;
  preferredId?: string;
  maxWaitMs?: number;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onStatus: (text: string) => void;
}): Promise<TurnResult> {
  const { messages, signal, onDelta, onStatus } = options;
  const tools = options.tools ?? [];
  const list = providers();
  const deadline = Date.now() + Math.min(MAX_WAIT_MS, options.maxWaitMs ?? MAX_WAIT_MS);
  let rounds = 0;
  let last: Error | null = null;
  let lastWait = 0;
  let announced = "";

  // Waiting for a cooldown must never consume the attempt budget.
  while (Date.now() < deadline) {
    if (signal.aborted) throw new EngineError("Response stopped.", true);
    const now = Date.now();
    const ranked = rankProviders(list, now, options.preferredId);
    const ready = ranked.filter((entry) => entry.at <= now).map((entry) => entry.provider);

    if (!ready.length) {
      const wait = ranked[0].at - now;
      lastWait = Math.max(lastWait, wait);
      if (now + wait > deadline) break;
      const label = `Every engine is resting · next one in ${Math.ceil(wait / 1000)}s`;
      if (label !== announced) { announced = label; onStatus(label); }
      await sleep(Math.min(1000, wait), signal);
      continue;
    }
    // Only the slow last-resort engine is free. If a fast one is back within seconds, waiting for it is quicker.
    if (ready.every((provider) => provider.lastResort)) {
      const soonest = ranked.find((entry) => !entry.provider.lastResort);
      const wait = soonest ? soonest.at - now : Number.POSITIVE_INFINITY;
      if (wait <= 20_000 && now + wait <= deadline) {
        const label = `Fast engines are catching their breath · ${Math.ceil(wait / 1000)}s`;
        if (label !== announced) { announced = label; onStatus(label); }
        await sleep(Math.min(1000, wait), signal);
        continue;
      }
    }
    if (rounds >= 4) break;
    rounds += 1;

    let shown = false;
    try {
      return await race(ready, messages, tools, signal, (text) => { shown = true; onDelta(text); }, onStatus, options.toolChoice);
    } catch (error) {
      last = error instanceof Error ? error : new EngineError("The backend AI engine failed unexpectedly.");
      if (error instanceof EngineError && error.fatal) throw error;
      // Never start over once words are on screen: that would repeat or contradict them.
      if (shown) throw last;
      if (error instanceof RateLimitError) lastWait = Math.max(lastWait, error.seconds * 1000);
    }
  }

  if (lastWait > 0) throw new RateLimitError(Math.ceil(lastWait / 1000));
  throw last instanceof Error ? last : new EngineError("The backend AI engine is busy right now. Please try again in a moment.");
}
