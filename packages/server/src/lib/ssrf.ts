import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Outbound webhook guard: http/https only, no credentials in the URL, the host must not resolve to a
 * loopback / private / link-local / CGNAT / metadata / multicast / reserved address. Checked when the URL
 * is saved and again at connect time (the socket's own DNS lookup is filtered, and the connected peer is
 * re-checked), so DNS rebinding between check and use is blocked. Redirects are never followed.
 */

const v4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local incl. 169.254.169.254 metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const)
  v4.addSubnet(net, prefix, "ipv4");

const v6 = new BlockList();
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4 (can embed private v4)
  ["fc00::", 7], // unique local (incl. fd00:ec2::254 metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const)
  v6.addSubnet(net, prefix, "ipv6");

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  // trailing dotted quad (::ffff:1.2.3.4)
  const dq = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dq) {
    const p = dq[1]!.split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    s = s.slice(0, -dq[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ":" + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  const parts = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (parts.length !== 8) return null;
  return parts.map((x) => parseInt(x || "0", 16));
}

export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return v4.check(ip, "ipv4");
  if (fam !== 6) return true; // not an IP: refuse
  const w = expandV6(ip);
  if (!w) return true;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the embedded v4.
  const embedded = `${w[6]! >> 8}.${w[6]! & 255}.${w[7]! >> 8}.${w[7]! & 255}`;
  const zero5 = w.slice(0, 5).every((x) => x === 0);
  if (zero5 && (w[5] === 0xffff || w[5] === 0) && !(w[5] === 0 && w[6] === 0)) return v4.check(embedded, "ipv4");
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return v4.check(embedded, "ipv4");
  return v6.check(ip, "ipv6");
}

export class SsrfError extends Error {}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

export function parseWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfError("only http and https URLs are allowed");
  if (u.username || u.password) throw new SsrfError("credentials in the URL are not allowed");
  if (!u.hostname) throw new SsrfError("missing host");
  return u;
}

const bareHost = (u: URL) => u.hostname.replace(/^\[|\]$/g, "");

/** Resolves the host and refuses if ANY resolved address is non-public. */
export async function assertPublicUrl(raw: string, resolve: Resolver = systemResolver, blocked: (ip: string) => boolean = isBlockedIp): Promise<URL> {
  const u = parseWebhookUrl(raw);
  const host = bareHost(u);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new SsrfError("host is not public");
  if (isIP(host)) {
    if (blocked(host)) throw new SsrfError("address is not public");
    return u;
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new SsrfError("host does not resolve");
  }
  if (addrs.length === 0) throw new SsrfError("host does not resolve");
  if (addrs.some((a) => blocked(a.address))) throw new SsrfError("host resolves to a non-public address");
  return u;
}

export type PostResult = { ok: boolean; status: number | null; detail: string };

/** POST JSON to a public webhook URL with a hard timeout, no redirects, and connect-time address checks. */
export async function safePost(
  raw: string,
  body: string,
  headers: Record<string, string>,
  /** `isBlocked` is injectable for tests only; production always uses isBlockedIp. */
  opts: { resolve?: Resolver; timeoutMs?: number; isBlocked?: (ip: string) => boolean } = {},
): Promise<PostResult> {
  const resolve = opts.resolve ?? systemResolver;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const blocked = opts.isBlocked ?? isBlockedIp;
  let u: URL;
  try {
    u = await assertPublicUrl(raw, resolve, blocked);
  } catch (e) {
    return { ok: false, status: null, detail: `blocked: ${(e as Error).message}` };
  }
  // Second resolution happens inside the socket's own lookup, and is checked again.
  const guardedLookup: LookupFunction = (hostname, options, cb) => {
    resolve(hostname)
      .then((addrs) => {
        const bad = addrs.find((a) => blocked(a.address));
        if (bad || addrs.length === 0) {
          cb(new SsrfError("host resolves to a non-public address") as NodeJS.ErrnoException, "", 0);
          return;
        }
        if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs);
        else cb(null, addrs[0]!.address, addrs[0]!.family);
      })
      .catch((e: Error) => cb(e as NodeJS.ErrnoException, "", 0));
  };
  const mod = u.protocol === "https:" ? https : http;
  return new Promise<PostResult>((done) => {
    let settled = false;
    const finish = (r: PostResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        done(r);
      }
    };
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body).toString(), "user-agent": "osstrace-webhook/0.1", ...headers },
        lookup: guardedLookup,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) finish({ ok: false, status, detail: "redirect not followed" });
        else finish({ ok: status >= 200 && status < 300, status, detail: `HTTP ${status}` });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, status: null, detail: "timeout" });
    }, timeoutMs);
    req.on("socket", (s) => {
      s.once("connect", () => {
        const peer = s.remoteAddress;
        if (!peer || blocked(peer)) {
          req.destroy(new SsrfError("connected to a non-public address"));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      finish({ ok: false, status: null, detail: "timeout" });
    });
    req.on("error", (e) => finish({ ok: false, status: null, detail: e instanceof SsrfError ? `blocked: ${e.message}` : `error: ${(e as NodeJS.ErrnoException).code ?? "request failed"}` }));
    req.end(body);
  });
}
