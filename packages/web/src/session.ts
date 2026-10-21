import { useSyncExternalStore } from "react";

/**
 * The browser side of `@opentrace/accounts`: one shared login session for every component.
 *
 * The session token is kept in localStorage (so a reload stays logged in) and sent as
 * `Authorization: Bearer …` — never a cookie, so there's no CSRF surface (ADR 0006). The user's
 * role is never trusted from storage: on load we ask the accounts API who the token belongs to,
 * and every API call re-checks it server-side anyway.
 */

export const ACCOUNTS_URL: string = import.meta.env["VITE_ACCOUNTS_URL"] ?? "http://localhost:5310";
export const COMMUNITY_LABELS_URL: string = import.meta.env["VITE_COMMUNITY_LABELS_URL"] ?? "http://localhost:5311";
export const PRIVATE_LABELS_URL: string = import.meta.env["VITE_PRIVATE_LABELS_URL"] ?? "http://localhost:5312";

const STORAGE_KEY = "opentrace.session";

export type Role = "user" | "moderator" | "admin";

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
}

export type SessionState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "signed-in"; token: string; user: SessionUser }
  /** A token is stored but the accounts API couldn't be reached to check it. */
  | { status: "unreachable"; token: string; message: string };

interface StoredSession {
  token: string;
  expiresAt: string;
}

function readStored(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (typeof parsed.token !== "string" || Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(session: StoredSession | null): void {
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode etc.): the session just won't survive a reload.
  }
}

let state: SessionState = { status: "checking" };
const listeners = new Set<() => void>();

function setState(next: SessionState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Asks the accounts API who the stored token belongs to. Called once on page load. */
async function restore(): Promise<void> {
  const stored = readStored();
  if (!stored) {
    writeStored(null);
    setState({ status: "anonymous" });
    return;
  }
  try {
    const res = await fetch(`${ACCOUNTS_URL}/accounts/me`, { headers: { authorization: `Bearer ${stored.token}` } });
    if (res.status === 401) {
      writeStored(null);
      setState({ status: "anonymous" });
      return;
    }
    const body = (await res.json()) as { user?: SessionUser; message?: string };
    if (!res.ok || !body.user) {
      setState({ status: "unreachable", token: stored.token, message: body.message ?? `HTTP ${res.status}` });
      return;
    }
    setState({ status: "signed-in", token: stored.token, user: body.user });
  } catch {
    setState({ status: "unreachable", token: stored.token, message: `can't reach the accounts API at ${ACCOUNTS_URL}` });
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

export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, () => state);
}

export function isModerator(session: SessionState): boolean {
  return session.status === "signed-in" && (session.user.role === "moderator" || session.user.role === "admin");
}

export type ApiResult<T> = { ok: true; body: T } | { ok: false; status: number; error: string; message: string };

/** JSON request; any network failure becomes an `{ ok: false }` result with a readable message. */
export async function apiCall<T>(url: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers["authorization"] = `Bearer ${init.token}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { ok: false, status: 0, error: "network", message: `can't reach ${new URL(url).origin}` };
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // fall through with body = null
  }
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string; message?: string };
    // The server says this session is gone (expired / logged out elsewhere): drop it locally too.
    if (res.status === 401 && init.token && state.status === "signed-in" && state.token === init.token) {
      writeStored(null);
      setState({ status: "anonymous" });
    }
    return { ok: false, status: res.status, error: err.error ?? "http_error", message: err.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, body: body as T };
}

type AuthBody = { user: SessionUser; session: { token: string; expiresAt: string } };

/** Real login/signup against the accounts API. Returns an error message, or null on success. */
export async function signIn(mode: "login" | "signup", email: string, password: string): Promise<string | null> {
  const result = await apiCall<AuthBody>(`${ACCOUNTS_URL}/accounts/${mode}`, { method: "POST", body: { email, password } });
  if (!result.ok) return result.message;
  writeStored(result.body.session);
  setState({ status: "signed-in", token: result.body.session.token, user: result.body.user });
  return null;
}

/** Revokes the session server-side, then forgets it locally (even if the server is unreachable). */
export async function signOut(): Promise<void> {
  const token = state.status === "signed-in" || state.status === "unreachable" ? state.token : null;
  if (token) await apiCall(`${ACCOUNTS_URL}/accounts/logout`, { method: "POST", token });
  writeStored(null);
  setState({ status: "anonymous" });
}

// --- Private labels (ADR 0004) -------------------------------------------------------------
// Per-user, owner-only labels (packages/features/private-labels) are a separate concept from
// the public Label/community-submission system above: no source, never shared, visible only to
// the signed-in owner. This pub-sub pair just lets any future "my private labels" list refetch
// when one changes elsewhere on the page -- PrivateLabelPanel.tsx is the only current caller.

export interface PrivateLabel {
  chain: "ethereum" | "solana";
  address: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

let labelsVersion = 0;
const labelListeners = new Set<() => void>();

export function notifyPrivateLabelsChanged(): void {
  labelsVersion++;
  for (const l of labelListeners) l();
}

export function usePrivateLabelsVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      labelListeners.add(listener);
      return () => labelListeners.delete(listener);
    },
    () => labelsVersion,
  );
}
