import type { ApiError } from "@osstrace/contract";
import { SERVER_URL } from "../serverSession.ts";

export class ApiRequestError extends Error {
  status: number;
  body: ApiError["error"] | null;
  /** Seconds from a Retry-After response header, when the server sent one. */
  retryAfterSec?: number;
  constructor(status: number, body: ApiError["error"] | null, retryAfterSec?: number) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Typed fetch wrapper for the new unified server. Cross-origin cookie session (see
 * serverSession.ts and the server's own CORS handling in app.ts) -- "include", not "same-origin".
 * JSON in/out; throws ApiRequestError.
 */
export async function api<T>(path: string, init: Omit<RequestInit, "body"> & { json?: unknown; query?: Record<string, string | number | boolean | string[] | undefined | null> } = {}): Promise<T> {
  const { json, query, headers, ...rest } = init;
  let url = path.startsWith("/api") ? `${SERVER_URL}${path}` : `${SERVER_URL}/api${path}`;
  if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
      else sp.append(k, String(v));
    }
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    credentials: "include",
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let body: ApiError["error"] | null = null;
    try {
      body = text ? errorBody(JSON.parse(text)) : null;
    } catch {
      body = null; // non-JSON error page (e.g. proxy 502): fall back to the status code
    }
    const ra = Number(res.headers.get("retry-after"));
    throw new ApiRequestError(res.status, body, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  const data = text ? (JSON.parse(text) as unknown) : null;
  return data as T;
}

/** True when `err` is an ApiRequestError with the given code (or status when a number is passed). */
export function isApiError(err: unknown, code?: ApiError["error"]["code"] | number): err is ApiRequestError {
  if (!(err instanceof ApiRequestError)) return false;
  if (code === undefined) return true;
  return typeof code === "number" ? err.status === code : err.body?.code === code;
}

/** Fetches a file from the API (e.g. label export) and hands it to the browser as a download. */
export async function downloadFile(path: string, query: Record<string, string>, fallbackName: string): Promise<void> {
  const url = `${path.startsWith("/api") ? `${SERVER_URL}${path}` : `${SERVER_URL}/api${path}`}?${new URLSearchParams(query).toString()}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const text = await res.text();
    let body: ApiError["error"] | null = null;
    try {
      body = text ? errorBody(JSON.parse(text)) : null;
    } catch {
      body = null;
    }
    throw new ApiRequestError(res.status, body);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? fallbackName;
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Accepts only the ApiError shape; framework errors like {error:"Bad Request"} fall back to the status code. */
function errorBody(data: unknown): ApiError["error"] | null {
  const e = (data as { error?: unknown } | null)?.error;
  return e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as ApiError["error"]) : null;
}
