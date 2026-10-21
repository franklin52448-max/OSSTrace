import { useSyncExternalStore } from "react";

/**
 * The signed-in session, shared by the account bar and the private-label panel without a context
 * provider (so App.tsx only has to render the components, not wire state between them).
 *
 * The bearer token is kept in localStorage so a reload doesn't log you out. That means any script
 * running on this origin could read it — acceptable for a local tool with no third-party scripts,
 * and noted in the web README as something to revisit before a public deployment.
 */

export const ACCOUNTS_URL = import.meta.env["VITE_ACCOUNTS_URL"] ?? "http://localhost:5310";
export const PRIVATE_LABELS_URL = import.meta.env["VITE_PRIVATE_LABELS_URL"] ?? "http://localhost:5311";

export interface Session {
  token: string;
  email: string;
  expiresAt: string;
}

const STORAGE_KEY = "opentrace.session";

function readStored(): Session | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.token !== "string" || typeof parsed.email !== "string" || typeof parsed.expiresAt !== "string") return null;
    if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

let current: Session | null = readStored();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setSession(session: Session | null): void {
  current = session;
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode): the session still works for this page load.
  }
  emit();
}

export function useSession(): Session | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** Bumped whenever the user's private labels change, so the "my labels" list can refetch. */
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

export interface ApiError {
  error: string;
  message: string;
}

export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: ApiError };

/**
 * fetch + JSON with the session's bearer token. A 401 means the session is gone (expired, logged
 * out elsewhere), so it signs the user out here too rather than leaving a dead session on screen.
 */
export async function apiCall<T>(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
    });
  } catch {
    return { ok: false, status: 0, error: { error: "unreachable", message: `couldn't reach ${base} — is that API running?` } };
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.status === 401 && options.token && current?.token === options.token) setSession(null);
  if (!res.ok) {
    const err = (body ?? {}) as Partial<ApiError>;
    return { ok: false, status: res.status, error: { error: err.error ?? `http_${res.status}`, message: err.message ?? `HTTP ${res.status}` } };
  }
  return { ok: true, status: res.status, body: body as T };
}

export interface PrivateLabel {
  chain: "ethereum" | "solana";
  address: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}
