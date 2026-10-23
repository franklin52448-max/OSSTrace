import { useSyncExternalStore } from "react";
import type { ChallengeResponse, VerifyRequest } from "@osstrace/contract";

/**
 * The browser side of the new unified server (`@osstrace/server`, ADR 0022) — a separate session
 * from `session.ts`'s (the old accounts API's) because the two backends use fundamentally
 * different auth: the old one is a bearer token the client stores and sends itself; this one is an
 * httpOnly cookie the browser sends and reads automatically (`credentials: "include"` on every
 * call) — the token is never visible to JS at all, so there's nothing to keep in localStorage.
 * During the migration (ADR 0022) a visitor may need to be signed in to both at once: this is
 * expected, temporary, and not a bug — pages still backed by the old services keep using
 * `session.ts`; pages backed by the new server use this one.
 */

/**
 * The session cookie is httpOnly + SameSite=Lax (see packages/server/src/auth/sessions.ts), which
 * browsers never attach to a cross-SITE fetch -- "site" meaning registrable domain (eTLD+1), not
 * origin, so a fixed VITE_SERVER_URL pointing at a raw *.fly.dev host would never work from either
 * real frontend domain no matter what SameSite/CORS config the server used. Each production domain
 * has its own same-site API subdomain (api.osstrace.com, api.opensourcetrace.org -- both already
 * have Fly certs issued) specifically so the cookie's "site" matches the page's. Vercel serves both
 * domains from the same build, so this has to be resolved at runtime from the page's own hostname,
 * not baked in once at build time via VITE_SERVER_URL (which remains the right override for local
 * dev and any other host, e.g. a tailscale address, where there's no same-site subdomain to use).
 */
function resolveServerUrl(): string {
  if (typeof window !== "undefined") {
    const host = window.location.hostname.replace(/^www\./, "");
    if (host === "osstrace.com") return "https://api.osstrace.com";
    if (host === "opensourcetrace.org") return "https://api.opensourcetrace.org";
  }
  return import.meta.env["VITE_SERVER_URL"] ?? "http://localhost:5320";
}

export const SERVER_URL: string = resolveServerUrl();

export interface ServerUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  chain: "solana" | "ethereum" | null;
  walletAddress: string | null;
}

export type ServerSessionState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "signed-in"; user: ServerUser }
  /** The server couldn't be reached to check for a cookie-carried session. */
  | { status: "unreachable"; message: string };

export type ServerApiResult<T> = { ok: true; body: T } | { ok: false; status: number; code: string; message: string };

/** JSON request against the new server, cookie session included. Network failure becomes `{ ok: false, status: 0 }`. */
export async function serverApiCall<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ServerApiResult<T>> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      credentials: "include",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { ok: false, status: 0, code: "network", message: `can't reach ${SERVER_URL}` };
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // fall through with body = null
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error ?? {};
    return { ok: false, status: res.status, code: err.code ?? "http_error", message: err.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, body: body as T };
}

let state: ServerSessionState = { status: "checking" };
const listeners = new Set<() => void>();

function setState(next: ServerSessionState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Asks the server who the browser's cookie (if any) belongs to. Called once, on the first subscriber. */
async function restore(): Promise<void> {
  const result = await serverApiCall<{ user: ServerUser }>("/api/auth/me");
  if (result.ok) {
    setState({ status: "signed-in", user: result.body.user });
  } else if (result.status === 401) {
    setState({ status: "anonymous" });
  } else {
    setState({ status: "unreachable", message: result.status === 0 ? result.message : `HTTP ${result.status}: ${result.message}` });
  }
}

let restoreStarted = false;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!restoreStarted) {
    restoreStarted = true;
    void restore();
  }
  return () => listeners.delete(listener);
}

export function useServerSession(): ServerSessionState {
  return useSyncExternalStore(subscribe, () => state);
}

export type WalletChain = "solana" | "ethereum";

/** Step 1 of wallet sign-in: asks the server for a message to sign, plus the nonce that names it. */
export async function serverChallenge(chain: WalletChain, address: string): Promise<ServerApiResult<ChallengeResponse>> {
  return serverApiCall<ChallengeResponse>("/api/auth/challenge", { method: "POST", body: { chain, address } });
}

/** Step 2: sends the wallet's signature over that message, with the challenge's own nonce (the server
 * keys pending challenges by it, so a second challenge for the same wallet -- another tab, or anyone
 * else -- can't invalidate this one). On success, updates the session. */
export async function serverVerify(chain: WalletChain, address: string, nonce: string, signature: string): Promise<string | null> {
  const result = await serverApiCall<{ user: ServerUser }>("/api/auth/verify", { method: "POST", body: { chain, address, nonce, signature } satisfies VerifyRequest });
  if (!result.ok) return result.message;
  setState({ status: "signed-in", user: result.body.user });
  return null;
}

/** Revokes the cookie session server-side, then forgets it locally (even if the server is unreachable). */
export async function serverSignOut(): Promise<void> {
  await serverApiCall("/api/auth/logout", { method: "POST" });
  setState({ status: "anonymous" });
}

/** Lets a successful `PATCH /api/settings` (settings/api.ts) push its updated User back into this store. */
export function setServerUser(user: ServerUser): void {
  setState({ status: "signed-in", user });
}
