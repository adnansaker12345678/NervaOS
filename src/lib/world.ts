import "server-only";
import type { SkillOutcome } from "@/lib/skills";

/** Live world data from free, keyless public APIs. Every function is genuinely executed. */

const get = async (url: string, ms = 15_000) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { "User-Agent": "AuraAgent/1.1 (+private workspace assistant)", Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
};

const ok = (title: string, detail: string, output: string, result: unknown, skill: string): SkillOutcome => ({
  result,
  receipt: { type: "skill", title, detail: detail.slice(0, 160), output: output.slice(0, 1500), ok: true, skill },
});
const fail = (title: string, message: string, skill: string): SkillOutcome => ({
  result: { error: message },
  receipt: { type: "skill", title, detail: "Failed", output: message, ok: false, skill },
});

const WMO: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Icy fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
  77: "Snow grains", 80: "Light showers", 81: "Showers", 82: "Violent showers",
  85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};

type GeoResult = { results?: { name: string; country?: string; admin1?: string; latitude: number; longitude: number; timezone?: string }[] };
type Forecast = {
  timezone?: string;
  current?: { temperature_2m?: number; apparent_temperature?: number; relative_humidity_2m?: number; weather_code?: number; wind_speed_10m?: number; time?: string };
  daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[]; weather_code?: number[] };
};

type Wttr = {
  current_condition?: { temp_C?: string; FeelsLikeC?: string; humidity?: string; windspeedKmph?: string; weatherDesc?: { value?: string }[] }[];
  weather?: { date?: string; maxtempC?: string; mintempC?: string; hourly?: { chanceofrain?: string; weatherDesc?: { value?: string }[] }[] }[];
  nearest_area?: { areaName?: { value?: string }[]; country?: { value?: string }[] }[];
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** One quick retry: a single dropped request should not fail the whole step. */
const getTwice = async (url: string) => { try { return await get(url, 8_000); } catch { await pause(350); return get(url, 10_000); } };

/** Backup source, used only when the main weather service does not answer. */
async function weatherFromWttr(query: string): Promise<SkillOutcome> {
  const data = (await get(`https://wttr.in/${encodeURIComponent(query)}?format=j1`, 12_000)) as Wttr;
  const now = data.current_condition?.[0];
  if (!now?.temp_C) throw new Error("no data");
  const area = data.nearest_area?.[0];
  const label = [area?.areaName?.[0]?.value, area?.country?.[0]?.value].filter(Boolean).join(", ") || query;
  const condition = now.weatherDesc?.[0]?.value ?? "—";
  const days = (data.weather ?? []).slice(0, 4).map((day) => {
    const midday = day.hourly?.[Math.floor((day.hourly?.length ?? 1) / 2)];
    return { date: day.date ?? "", max: Number(day.maxtempC), min: Number(day.mintempC), rain: Number(midday?.chanceofrain ?? NaN), condition: midday?.weatherDesc?.[0]?.value?.trim() ?? "—" };
  });
  const detail = `${Math.round(Number(now.temp_C))}°C · ${condition} · ${label}`;
  const output = [label, `Now: ${now.temp_C}°C (feels ${now.FeelsLikeC ?? "?"}°C), ${condition}, humidity ${now.humidity ?? "?"}%, wind ${now.windspeedKmph ?? "?"} km/h`, ...days.slice(1).map((d) => `${d.date}: ${d.min}–${d.max}°C, ${d.condition}, rain ${Number.isFinite(d.rain) ? d.rain : "?"}%`)].join("\n");
  return ok(`Weather · ${area?.areaName?.[0]?.value ?? query}`, detail, output, { place: label, current: { temperature_2m: Number(now.temp_C), apparent_temperature: Number(now.FeelsLikeC), relative_humidity_2m: Number(now.humidity), wind_speed_10m: Number(now.windspeedKmph), condition }, forecast: days, source: "wttr.in" }, "weather");
}

export async function weatherSkill(place: string): Promise<SkillOutcome> {
  const query = place.trim().replace(/\s+/g, " ").replace(/\b(?:today|tomorrow|now|right now|this week|weather|forecast)\b/gi, "").replace(/[?.!]+$/, "").trim().slice(0, 120);
  if (!query) return fail("Weather", "Say which city or place you mean.", "weather");
  // "Dhaka, Bangladesh" and "New York USA" are valid ways to say a place; the geocoder wants just the name.
  const words = query.split(" ");
  const names = [...new Set([query, query.split(",")[0].trim(), words.slice(0, 2).join(" "), words[0]].filter((name) => name.length > 1))];
  try {
    let found: NonNullable<GeoResult["results"]>[number] | undefined;
    for (const name of names) {
      const geo = (await getTwice(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en`)) as GeoResult;
      found = geo.results?.[0];
      if (found) break;
    }
    if (!found) return fail("Weather", `I couldn't find a place called “${query}”.`, "weather");
    const forecast = (await getTwice(
      `https://api.open-meteo.com/v1/forecast?latitude=${found.latitude}&longitude=${found.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=4`
    )) as Forecast;
    const current = forecast.current ?? {};
    const days = (forecast.daily?.time ?? []).slice(0, 4).map((date, i) => ({
      date,
      max: forecast.daily?.temperature_2m_max?.[i] ?? null,
      min: forecast.daily?.temperature_2m_min?.[i] ?? null,
      rain: forecast.daily?.precipitation_probability_max?.[i] ?? null,
      condition: WMO[forecast.daily?.weather_code?.[i] ?? -1] ?? "—",
    }));
    const label = [found.name, found.admin1, found.country].filter(Boolean).join(", ");
    const condition = WMO[current.weather_code ?? -1] ?? "—";
    const detail = `${Math.round(current.temperature_2m ?? NaN)}°C · ${condition} · ${label}`;
    const output = [
      `${label}`,
      `Now: ${current.temperature_2m ?? "?"}°C (feels ${current.apparent_temperature ?? "?"}°C), ${condition}, humidity ${current.relative_humidity_2m ?? "?"}%, wind ${current.wind_speed_10m ?? "?"} km/h`,
      ...days.slice(1).map((d) => `${d.date}: ${d.min}–${d.max}°C, ${d.condition}, rain ${d.rain ?? "?"}%`),
    ].join("\n");
    return ok(`Weather · ${found.name}`, detail, output, { place: label, timezone: forecast.timezone, current: { ...current, condition }, forecast: days, source: "Open-Meteo" }, "weather");
  } catch {
    try { return await weatherFromWttr(names[1] ?? query); }
    catch { return fail("Weather", "Both weather services are not answering right now. Try again in a minute.", "weather"); }
  }
}

type ErApi = { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
type Frankfurter = { rates?: Record<string, number>; date?: string };

export async function currencySkill(amount: number, from: string, to: string): Promise<SkillOutcome> {
  const source = from.toUpperCase(), target = to.toUpperCase();
  if (!/^[A-Z]{3}$/.test(source) || !/^[A-Z]{3}$/.test(target)) {
    return fail("Currency", "Use 3-letter codes such as USD, EUR, BDT.", "currency");
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) return fail("Currency", "Give a positive amount.", "currency");
  const convert = async () => {
    try {
      const data = (await get(`https://open.er-api.com/v6/latest/${source}`)) as ErApi;
      const rate = data.rates?.[target];
      if (data.result === "success" && rate) return { rate, updated: data.time_last_update_utc ?? "", provider: "ExchangeRate-API" };
    } catch { /* fall through */ }
    const data = (await get(`https://api.frankfurter.dev/v1/latest?from=${source}&to=${target}`)) as Frankfurter;
    const rate = data.rates?.[target];
    if (!rate) throw new Error("no rate");
    return { rate, updated: data.date ?? "", provider: "Frankfurter (ECB)" };
  };
  try {
    const { rate, updated, provider } = await convert();
    const value = Math.round(amount * rate * 100) / 100;
    const detail = `${amount.toLocaleString()} ${source} = ${value.toLocaleString()} ${target}`;
    return ok(`Currency · ${source} → ${target}`, detail, `${detail}\nRate: 1 ${source} = ${rate} ${target} (${provider}, ${updated || "recent"})`, { amount, from: source, to: target, rate, value, updated, provider }, "currency");
  } catch {
    return fail("Currency", `No rate for ${source} → ${target} right now.`, "currency");
  }
}

const COINS: Record<string, string> = {
  btc: "bitcoin", bitcoin: "bitcoin", eth: "ethereum", ethereum: "ethereum", sol: "solana", solana: "solana",
  doge: "dogecoin", dogecoin: "dogecoin", xrp: "ripple", ripple: "ripple", ada: "cardano", cardano: "cardano",
  bnb: "binancecoin", bnbchain: "binancecoin", trx: "tron", tron: "tron", ltc: "litecoin", litecoin: "litecoin",
  link: "chainlink", chainlink: "chainlink", avax: "avalanche-2", avalanche: "avalanche-2", dot: "polkadot", polkadot: "polkadot",
};

export async function cryptoSkill(coins: string, vs: string): Promise<SkillOutcome> {
  const ids = [...new Set(coins.toLowerCase().split(/[,\s]+/).map((c) => COINS[c] ?? c).filter(Boolean))].slice(0, 5);
  if (!ids.length) return fail("Crypto", "Name a coin such as bitcoin or ethereum.", "crypto");
  const currency = /^[a-z]{3}$/.test(vs.toLowerCase()) ? vs.toLowerCase() : "usd";
  try {
    const data = (await get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=${currency}`)) as Record<string, Record<string, number>>;
    const prices = ids.map((id) => ({ coin: id, price: data[id]?.[currency] ?? null })).filter((p) => p.price !== null);
    if (!prices.length) return fail("Crypto", "Those coins weren't recognized. Try bitcoin, ethereum, or solana.", "crypto");
    const detail = prices.map((p) => `${p.coin} ${p.price?.toLocaleString()} ${currency.toUpperCase()}`).join(" · ");
    return ok("Crypto prices", detail, detail, { vs: currency, prices, source: "CoinGecko" }, "crypto");
  } catch {
    return fail("Crypto", "The price service is busy. Try again in a moment.", "crypto");
  }
}

const LANGS: Record<string, string> = {
  english: "en", en: "en", bengali: "bn", bangla: "bn", bn: "bn", spanish: "es", es: "es", french: "fr", fr: "fr",
  german: "de", de: "de", arabic: "ar", ar: "ar", hindi: "hi", hi: "hi", urdu: "ur", ur: "ur",
  japanese: "ja", ja: "ja", chinese: "zh-CN", mandarin: "zh-CN", korean: "ko", ko: "ko", italian: "it", it: "it",
  portuguese: "pt", pt: "pt", russian: "ru", ru: "ru", turkish: "tr", tr: "tr", dutch: "nl", nl: "nl",
  swedish: "sv", sv: "sv", vietnamese: "vi", vi: "vi", thai: "th", th: "th", nepali: "ne", ne: "ne",
};

export async function translateSkill(text: string, target: string, source?: string): Promise<SkillOutcome> {
  const input = text.trim().slice(0, 2000);
  if (!input) return fail("Translate", "Give me some text to translate.", "translate");
  const to = LANGS[target.trim().toLowerCase()];
  if (!to) return fail("Translate", `I don't know “${target}”. Try English, Bengali, Spanish, French, German, Arabic, Hindi, Urdu, Japanese, Korean…`, "translate");
  const from = source ? LANGS[source.trim().toLowerCase()] ?? "auto" : "auto";
  try {
    const data = (await get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(input)}`)) as unknown[];
    const translated = Array.isArray(data?.[0]) ? (data[0] as unknown[][]).map((part) => (Array.isArray(part) ? String(part[0] ?? "") : "")).join("") : "";
    if (!translated) throw new Error("empty");
    return ok(`Translate → ${to}`, translated.slice(0, 120), `${input}\n→ ${translated}`, { from, to, original: input, translated }, "translate");
  } catch {
    try {
      const data = (await get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(input)}&langpair=${from}|${to}`)) as { responseData?: { translatedText?: string } };
      const translated = data.responseData?.translatedText ?? "";
      if (!translated) throw new Error("empty");
      return ok(`Translate → ${to}`, translated.slice(0, 120), `${input}\n→ ${translated}`, { from, to, original: input, translated, via: "MyMemory" }, "translate");
    } catch {
      return fail("Translate", "The translation service didn't answer. Try again shortly.", "translate");
    }
  }
}

type DictionaryEntry = { word?: string; phonetic?: string; phonetics?: { text?: string }[]; meanings?: { partOfSpeech?: string; definitions?: { definition?: string; example?: string }[] }[] };

export async function defineSkill(word: string): Promise<SkillOutcome> {
  const clean = word.trim().toLowerCase().slice(0, 60);
  if (!/^[a-z][a-z\-' ]{0,59}$/.test(clean)) return fail("Define", "Give one English word to define.", "define");
  try {
    const entries = (await get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(clean)}`)) as DictionaryEntry[];
    const entry = entries?.[0];
    const senses = (entry?.meanings ?? []).slice(0, 3).flatMap((meaning) => (meaning.definitions ?? []).slice(0, 2).map((def) => ({ part: meaning.partOfSpeech ?? "", definition: def.definition ?? "", example: def.example ?? "" })));
    if (!senses.length) throw new Error("empty");
    const phonetic = entry?.phonetic || entry?.phonetics?.find((p) => p.text)?.text || "";
    const output = [`${entry?.word ?? clean}${phonetic ? ` ${phonetic}` : ""}`, ...senses.map((s, i) => `${i + 1}. (${s.part}) ${s.definition}${s.example ? ` — “${s.example}”` : ""}`)].join("\n");
    return ok(`Define · ${clean}`, senses[0].definition.slice(0, 120), output, { word: clean, phonetic, senses }, "define");
  } catch {
    return fail("Define", `I couldn't find “${clean}” in the dictionary. Check the spelling.`, "define");
  }
}

type WikiSummary = { title?: string; extract?: string; content_urls?: { desktop?: { page?: string } }; description?: string };

export async function wikiSkill(topic: string): Promise<SkillOutcome> {
  const clean = topic.trim().slice(0, 120);
  if (!clean) return fail("Wikipedia", "Say what to look up.", "wiki");
  try {
    const data = (await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(clean.replace(/ /g, "_"))}`)) as WikiSummary;
    if (!data.extract) throw new Error("empty");
    const url = data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(clean.replace(/ /g, "_"))}`;
    return ok(`Wikipedia · ${data.title ?? clean}`, (data.description || data.extract).slice(0, 140), `${data.title}\n${url}\n\n${data.extract.slice(0, 1200)}`, { title: data.title, url, extract: data.extract.slice(0, 3000) }, "wiki");
  } catch {
    return fail("Wikipedia", `No Wikipedia article found for “${clean}”. Try web search instead.`, "wiki");
  }
}

type HnResponse = { hits?: { title?: string; url?: string; points?: number; author?: string; num_comments?: number; created_at?: string }[] };

export async function newsSkill(query: string): Promise<SkillOutcome> {
  const clean = query.trim().slice(0, 150);
  try {
    // Real live news for any topic: Google News + Bing News headlines with exact dates.
    const { searchWeb } = await import("@/lib/search");
    const found = await searchWeb(clean ? `${clean} news` : "top news", 10, "day");
    const stories = found.results.filter((item) => item.kind === "news").slice(0, 8).map((item) => ({ title: item.title, url: item.url, source: item.site, date: item.date ?? "", points: 0, comments: 0, author: "" }));
    if (stories.length) {
      const output = stories.map((s, i) => `${i + 1}. ${s.title}  (${s.date || "recent"} · ${s.source})`).join("\n");
      return ok(`News · ${clean || "top stories"}`, `${stories.length} headlines · latest ${stories[0]?.date ?? ""}`, output, { query: clean, stories, source: found.source, note: "Answer from the dated headlines; say which date your summary reflects." }, "news");
    }
  } catch { /* fall through to Hacker News for tech topics */ }
  try {
    const data = (await get(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(clean)}&tags=story&hitsPerPage=6`)) as HnResponse;
    const stories = (data.hits ?? []).filter((hit) => hit.title).slice(0, 5).map((hit) => ({
      title: hit.title ?? "", url: hit.url ?? "", points: hit.points ?? 0, comments: hit.num_comments ?? 0, author: hit.author ?? "", date: (hit.created_at ?? "").slice(0, 10),
    }));
    if (!stories.length) return fail("News", `Nothing found for “${clean}”.`, "news");
    const output = stories.map((s, i) => `${i + 1}. ${s.title} (▲${s.points} · ${s.comments} comments)\n   ${s.url}`).join("\n");
    return ok(`News · ${clean || "technology"}`, `${stories.length} stories`, output, { query: clean, stories, source: "Hacker News" }, "news");
  } catch {
    return fail("News", "The news service didn't answer. Try again shortly.", "news");
  }
}

const COUNTRIES: Record<string, string> = {
  "united states": "US", usa: "US", us: "US", america: "US", bangladesh: "BD", bd: "BD",
  "united kingdom": "GB", uk: "GB", britain: "GB", england: "GB", india: "IN", pakistan: "PK", canada: "CA",
  australia: "AU", germany: "DE", france: "FR", japan: "JP", china: "CN", uae: "AE", emirates: "AE",
  "saudi arabia": "SA", singapore: "SG", malaysia: "MY", indonesia: "ID", nepal: "NP", "sri lanka": "LK",
  italy: "IT", spain: "ES", netherlands: "NL", sweden: "SE", brazil: "BR", mexico: "MX", egypt: "EG", turkey: "TR", "south korea": "KR", korea: "KR",
};

type Holiday = { date?: string; name?: string; localName?: string };

export async function holidaysSkill(country: string, year?: number): Promise<SkillOutcome> {
  const key = country.trim().toLowerCase();
  const code = /^[a-z]{2}$/.test(key) ? key.toUpperCase() : COUNTRIES[key];
  if (!code) return fail("Holidays", `I don't know “${country}”. Try a country name or 2-letter code.`, "holidays");
  const nowYear = new Date().getUTCFullYear();
  const targetYear = year && year >= 2000 && year <= 2100 ? year : nowYear;
  try {
    const data = (await get(`https://date.nager.at/api/v3/publicholidays/${targetYear}/${code}`)) as Holiday[];
    if (!Array.isArray(data) || !data.length) return fail("Holidays", `No holidays found for ${code} ${targetYear}.`, "holidays");
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = data.filter((h) => (h.date ?? "") >= today).slice(0, 8);
    const show = upcoming.length ? upcoming : data.slice(0, 8);
    const output = show.map((h) => `${h.date}: ${h.name}${h.localName && h.localName !== h.name ? ` (${h.localName})` : ""}`).join("\n");
    return ok(`Holidays · ${code} ${targetYear}`, `${data.length} public holidays`, output, { country: code, year: targetYear, holidays: data.map((h) => ({ date: h.date, name: h.name, localName: h.localName })) }, "holidays");
  } catch {
    return fail("Holidays", "The holiday service didn't answer. Try again shortly.", "holidays");
  }
}
