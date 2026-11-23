import vm from "node:vm";

/**
 * Runs a small JavaScript snippet in a locked sandbox: no require, process,
 * fetch, or timers, with a hard 2-second timeout. The last expression value
 * and anything printed with console.log are returned.
 */
export function runJavascript(code: string): { result: string; logs: string[] } {
  const source = code.trim().slice(0, 5000);
  if (!source) throw new Error("Give me some JavaScript to run.");
  if (/\brequire\s*\(|\bprocess\b|\bglobalThis\b|\bimport\s*\(|\bfetch\b|\bXMLHttpRequest\b/.test(source)) {
    throw new Error("That code uses something outside the sandbox (no require, process, fetch, or imports).");
  }
  const logs: string[] = [];
  const format = (value: unknown): string => {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  };
  const sandbox = {
    console: { log: (...args: unknown[]) => { logs.push(args.map(format).join(" ")); } },
    Math, JSON, Number, String, Boolean, Array, Object, Date, RegExp, Intl,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  };
  const context = vm.createContext(sandbox, { name: "aura-sandbox" });
  let result: unknown;
  try {
    result = vm.runInContext(`"use strict";\n${source}`, context, { timeout: 2000, displayErrors: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution failed.";
    throw new Error(/timed out/i.test(message) ? "That code ran too long (over 2 seconds) and was stopped." : message.slice(0, 400));
  }
  const rendered = result === undefined ? "" : format(result);
  if (!rendered && !logs.length) throw new Error("The code ran but produced no output. End with an expression or use console.log.");
  return { result: (rendered || logs.join("\n")).slice(0, 4000), logs: logs.slice(0, 20) };
}
