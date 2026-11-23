import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Fully local tools: unit conversion and text utilities. No network, always instant. */

const UNITS: Record<string, { group: string; toBase: number }> = {};
const addGroup = (group: string, base: string, table: Record<string, number>) => {
  for (const [unit, factor] of Object.entries(table)) UNITS[unit] = { group, toBase: factor };
};
addGroup("length", "m", { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 });
addGroup("mass", "g", { mg: 0.001, g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237, t: 1_000_000 });
addGroup("volume", "ml", { ml: 1, l: 1000, "fl-oz": 29.5735, cup: 236.588, pint: 473.176, quart: 946.353, gal: 3785.41 });
addGroup("area", "m2", { mm2: 1e-6, cm2: 1e-4, m2: 1, ha: 10_000, km2: 1e6, in2: 0.00064516, ft2: 0.092903, acre: 4046.86, mi2: 2_589_988 });
addGroup("speed", "m/s", { "m/s": 1, "km/h": 1 / 3.6, mph: 0.44704, knot: 0.514444 });
addGroup("time", "s", { ms: 0.001, s: 1, min: 60, h: 3600, day: 86_400, week: 604_800 });
addGroup("data", "byte", { b: 1, kb: 1000, mb: 1e6, gb: 1e9, tb: 1e12 });

const ALIASES: Record<string, string> = {
  millimeter: "mm", millimeters: "mm", centimeter: "cm", centimeters: "cm", centimetre: "cm", meter: "m", meters: "m", metre: "m", kilometre: "km", kilometer: "km", kilometers: "km", kilometres: "km",
  inch: "in", inches: "in", foot: "ft", feet: "ft", yard: "yd", yards: "yd", mile: "mi", miles: "mi",
  milligram: "mg", gram: "g", grams: "g", kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg", ounce: "oz", ounces: "oz", pound: "lb", pounds: "lb", lbs: "lb", ton: "t", tons: "t",
  milliliter: "ml", liter: "l", liters: "l", litre: "l", gallon: "gal", gallons: "gal", cups: "cup", pints: "pint", quarts: "quart",
  second: "s", seconds: "s", sec: "s", minute: "min", minutes: "min", hour: "h", hours: "h", hr: "h", day: "day", days: "day", weeks: "week",
  celsius: "c", centigrade: "c", fahrenheit: "f", kelvin: "k", "°c": "c", "°f": "f", c: "c", f: "f", k: "k",
  kmh: "km/h", kph: "km/h", knots: "knot", byte: "b", bytes: "b", kilobyte: "kb", megabyte: "mb", gigabyte: "gb",
};

const normalizeUnit = (value: string) => {
  const clean = value.trim().toLowerCase().replace(/°/g, "°");
  return ALIASES[clean] ?? clean;
};

export function convertUnit(value: number, fromRaw: string, toRaw: string): { value: number; from: string; to: string } {
  if (!Number.isFinite(value)) throw new Error("Give a number to convert.");
  const from = normalizeUnit(fromRaw), to = normalizeUnit(toRaw);
  if (["c", "f", "k"].includes(from) || ["c", "f", "k"].includes(to)) {
    if (!["c", "f", "k"].includes(from) || !["c", "f", "k"].includes(to)) throw new Error(`Cannot convert ${fromRaw} to ${toRaw}: temperature only converts between °C, °F, and K.`);
    const celsius = from === "c" ? value : from === "f" ? ((value - 32) * 5) / 9 : value - 273.15;
    const result = to === "c" ? celsius : to === "f" ? (celsius * 9) / 5 + 32 : celsius + 273.15;
    return { value: Math.round(result * 10000) / 10000, from, to };
  }
  const a = UNITS[from], b = UNITS[to];
  if (!a || !b) throw new Error(`Unknown units. Try m, km, ft, mi, kg, lb, l, gal, m/s, km/h, mph, °C, °F, min, h, day, kb, mb.`);
  if (a.group !== b.group) throw new Error(`Cannot convert ${fromRaw} (${a.group}) to ${toRaw} (${b.group}).`);
  return { value: Math.round(((value * a.toBase) / b.toBase) * 10000) / 10000, from, to };
}

export type TextOperation = "count" | "upper" | "lower" | "title" | "slug" | "reverse" | "base64encode" | "base64decode" | "urlencode" | "urldecode" | "json" | "uuid" | "password" | "sha256" | "reading";

export function textTool(operation: string, text: string, length?: number): { operation: string; output: string; extra?: Record<string, unknown> } {
  const op = operation.trim().toLowerCase().replace(/[\s_-]+/g, "") as TextOperation;
  const input = text ?? "";
  switch (op) {
    case "count": {
      const words = input.trim() ? input.trim().split(/\s+/).length : 0;
      return { operation: op, output: `${words} words · ${input.length} characters · ${input.split("\n").length} lines`, extra: { words, characters: input.length, lines: input.split("\n").length } };
    }
    case "upper": return { operation: op, output: input.toUpperCase() };
    case "lower": return { operation: op, output: input.toLowerCase() };
    case "title": return { operation: op, output: input.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) };
    case "slug": return { operation: op, output: input.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled" };
    case "reverse": return { operation: op, output: [...input].reverse().join("") };
    case "base64encode": return { operation: op, output: Buffer.from(input, "utf8").toString("base64") };
    case "base64decode": {
      if (!/^[A-Za-z0-9+/=\s]+$/.test(input) || input.replace(/\s/g, "").length % 4 !== 0) throw new Error("That is not valid base64.");
      return { operation: op, output: Buffer.from(input.replace(/\s/g, ""), "base64").toString("utf8") };
    }
    case "urlencode": return { operation: op, output: encodeURIComponent(input) };
    case "urldecode": return { operation: op, output: decodeURIComponent(input) };
    case "json": {
      try {
        const parsed: unknown = JSON.parse(input);
        return { operation: op, output: JSON.stringify(parsed, null, 2) };
      } catch { throw new Error("That is not valid JSON."); }
    }
    case "uuid": return { operation: op, output: randomUUID() };
    case "password": {
      const size = Math.min(64, Math.max(8, Math.floor(length ?? 16)));
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*";
      const bytes = randomBytes(size);
      return { operation: op, output: [...bytes].map((b) => alphabet[b % alphabet.length]).join("") };
    }
    case "sha256": return { operation: op, output: createHash("sha256").update(input, "utf8").digest("hex") };
    case "reading": {
      const words = input.trim() ? input.trim().split(/\s+/).length : 0;
      const minutes = Math.max(1, Math.round(words / 200));
      return { operation: op, output: `About ${minutes} minute${minutes === 1 ? "" : "s"} to read (${words} words at 200 wpm).`, extra: { words, minutes } };
    }
    default:
      throw new Error("Unknown text operation. Use count, upper, lower, title, slug, reverse, base64encode, base64decode, urlencode, urldecode, json, uuid, password, sha256, or reading.");
  }
}
