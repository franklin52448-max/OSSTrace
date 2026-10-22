import type { AddressInfo } from "@osstrace/contract";

export const shortAddress = (a: string, head = 4, tail = 4) => (a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`);

/** Display name for an address: entity name, else label name, else short hash. */
export const addressDisplayName = (info: Pick<AddressInfo, "address" | "entity" | "label">) => info.entity?.name ?? info.label?.name ?? shortAddress(info.address);

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (abs === 0) return "$0";
  return `${sign}$${String(Number(abs.toPrecision(2)))}`;
}

/** Decimal-string aware amount formatting; never converts to float for large values. */
export function formatAmount(amount: string, maxFraction = 4): string {
  const [int = "0", frac = ""] = amount.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let f = frac.slice(0, maxFraction).replace(/0+$/, "");
  // Dust amounts keep two significant digits instead of collapsing to "0".
  if (!f && /^-?0$/.test(int) && /[1-9]/.test(frac)) {
    const firstSig = frac.search(/[1-9]/);
    f = frac.slice(0, firstSig + 2).replace(/0+$/, "");
  }
  return f ? `${grouped}.${f}` : grouped;
}

/** Absolute time in the user's timezone (falls back to the browser's when the zone is invalid). */
export function formatTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  try {
    return d.toLocaleString("en-GB", { ...opts, timeZone });
  } catch {
    return d.toLocaleString("en-GB", opts);
  }
}

export function formatDate(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "2-digit" };
  try {
    return d.toLocaleDateString("en-GB", { ...opts, timeZone });
  } catch {
    return d.toLocaleDateString("en-GB", opts);
  }
}

/** "3m ago", "5h ago", "2d ago"; older than 30 days returns the date. `now` is injectable for tests. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.round((now - t) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days <= 30) return `${days}d ago`;
  return formatDate(iso);
}

/** Plain integer with thousands separators. */
export const formatCount = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));
