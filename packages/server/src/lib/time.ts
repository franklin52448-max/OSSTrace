// Timestamps are ISO-8601 UTC with exactly 6 fractional digits, so lexical order == time order
// (the web client compares `updatedAt` strings to decide what to rebase).

let lastMicros = 0n;

const pad = (n: number | bigint, w: number) => String(n).padStart(w, "0");

export function microsToIso(micros: bigint): string {
  const ms = Number(micros / 1000n);
  const frac = micros % 1_000_000n;
  const d = new Date(ms);
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(frac, 6)}Z`
  );
}

/** Strictly monotonic within this process. */
export function nowIso(): string {
  let m = BigInt(Date.now()) * 1000n;
  if (m <= lastMicros) m = lastMicros + 1n;
  lastMicros = m;
  return microsToIso(m);
}

/** Returns an ISO string strictly greater than `prev` and >= now. */
export function nextAfter(prev: string | null | undefined): string {
  const n = nowIso();
  if (!prev || n > prev) return n;
  const pm = isoToMicros(prev);
  const m = pm + 1n;
  if (m > lastMicros) lastMicros = m;
  return microsToIso(m);
}

export function isoToMicros(iso: string): bigint {
  const match = /\.(\d+)Z$/.exec(iso);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error("bad timestamp");
  const fracDigits = match?.[1] ?? "";
  const micros = BigInt(Math.floor(ms / 1000)) * 1_000_000n + BigInt((fracDigits + "000000").slice(0, 6));
  return micros;
}

export const secToIso = (s: number) => microsToIso(BigInt(s) * 1_000_000n);
export const msToIso = (ms: number) => microsToIso(BigInt(Math.floor(ms)) * 1000n);
export const isoToSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Parses "1h", "12h", "24h", "1d", "7d", "30d", "90d", "1y". Returns seconds or null for "all"/unknown. */
export function parseTimeLast(s: string | undefined | null): number | null {
  if (!s || s === "all") return null;
  const m = /^(\d{1,4})([hdwmy])$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { h: 3600, d: 86400, w: 7 * 86400, m: 30 * 86400, y: 365 * 86400 }[m[2] as "h" | "d" | "w" | "m" | "y"];
  return n * unit;
}

/** Accepts ISO strings or epoch milliseconds (as string/number). Returns epoch seconds or null. */
export function parseTimePoint(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" || /^\d{10,14}$/.test(String(v))) {
    const n = Number(v);
    return Math.floor(n > 1e11 ? n / 1000 : n);
  }
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
