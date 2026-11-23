import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Shared network guard for anything that fetches a URL the user or a model chose. */

const hostCache = new Map<string, { public: boolean; until: number }>();
const CACHE_MS = 5 * 60_000;
// A failed lookup is often transient. It is remembered only very briefly so a real site is not locked out.
const FAILURE_CACHE_MS = 10_000;

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return value === "::" || value === "::1" || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith("ff");
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    // Only the reserved 192.0.0.0/24 and test 192.0.2.0/24 blocks, not the whole 192.0.x space:
    // iana.org itself lives on 192.0.43.8.
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/** True only for a public http(s) hostname. Private, loopback, link-local and metadata hosts are refused. */
export async function isPublicHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") return false;
  const cached = hostCache.get(host);
  if (cached && cached.until > Date.now()) return cached.public;
  let addresses: { address: string }[] = [];
  for (let attempt = 0; attempt < 2 && !addresses.length; attempt++) {
    try { addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }); }
    catch { if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!addresses.length) {
    hostCache.set(host, { public: false, until: Date.now() + FAILURE_CACHE_MS });
    throw new Error(`The address for ${host} could not be looked up.`);
  }
  const allowed = addresses.every((entry) => !isPrivateAddress(entry.address));
  hostCache.set(host, { public: allowed, until: Date.now() + CACHE_MS });
  return allowed;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("That is not a valid web address."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses can be opened.");
  if (url.username || url.password) throw new Error("Addresses with login details are not allowed.");
  if (!await isPublicHost(url.hostname)) throw new Error(`Private and local addresses cannot be opened, and “${url.hostname}” did not resolve to a public address.`);
  return url;
}
