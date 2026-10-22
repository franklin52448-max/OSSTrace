/**
 * Shape checks for a user-supplied URL that will be *shown*, never fetched server-side by this
 * project (fetching a user-supplied URL from the server is its own SSRF hole). Shared by every
 * feature that asks a caller for a citable/checkable link — first `@osstrace/community-labels`'
 * source URLs (ADR 0002, ADR 0007), now also `@osstrace/bounties`' PR URLs — so "what counts as a
 * real, independently-checkable host" means the same thing everywhere instead of drifting between
 * two copies.
 */

/**
 * Hosts nobody but whoever controls that specific machine/network can open: `localhost` and
 * friends, and loopback, private, carrier-grade-NAT and link-local IPv4. A link there can't be
 * independently checked by anyone else who opens it — every IPv6 literal is already refused by
 * callers' own "has a dot" check, and `new URL` has already normalised forms like `127.1` or
 * `2130706433` to dotted-quad before this ever sees them.
 */
export function isNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * An absolute http(s) URL with a real, publicly reachable host, no embedded credentials. Checks
 * shape only — see the module comment on why nothing here ever fetches it. `fieldName` is used
 * only in the returned message (e.g. `"prUrl"`, `"source.url"`).
 */
export function parsePublicUrl(value: unknown, fieldName: string, maxLength: number): Parsed<string> {
  if (typeof value !== "string" || !value.trim()) return { ok: false, message: `${fieldName} is required` };
  const raw = value.trim();
  if (raw.length > maxLength) return { ok: false, message: `${fieldName} must be at most ${maxLength} characters` };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `${fieldName} must be an absolute URL (https://…)` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: `${fieldName} must be an http or https URL` };
  }
  if (!url.hostname.includes(".") || isNonPublicHost(url.hostname)) {
    return { ok: false, message: `${fieldName} must point at a real, public host` };
  }
  if (url.username || url.password) return { ok: false, message: `${fieldName} must not contain credentials` };
  return { ok: true, value: url.toString() };
}
