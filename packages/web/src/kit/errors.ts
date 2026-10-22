import { ApiRequestError } from "./api.ts";

export type ErrorDescription = {
  code: string;
  /** Short sentence safe to show in a toast or inline. */
  message: string;
  /** Provider id for provider_error. */
  provider?: string;
  retryAfterSec?: number;
};

const FALLBACK: Record<string, string> = {
  bad_request: "The request was not accepted.",
  unauthorized: "Your session has ended. Sign in again.",
  forbidden: "You do not have access to this.",
  not_found: "Not found.",
  conflict: "That already exists.",
  rate_limited: "Too many attempts.",
  provider_error: "The chain data provider is unavailable.",
  internal: "The server hit an error.",
};

/** Maps any thrown value to a user-facing description. The API message wins; codes give fallbacks. */
export function describeError(err: unknown): ErrorDescription {
  if (err instanceof ApiRequestError) {
    const b = err.body;
    const code = b?.code ?? (err.status === 0 ? "network" : statusToCode(err.status));
    const base = b?.message?.trim() || FALLBACK[code] || `Request failed (HTTP ${err.status}).`;
    const retry = b?.provider?.retryAfterSec ?? err.retryAfterSec;
    let message = base;
    if (code === "provider_error" && b?.provider) {
      message = `${base} (${b.provider.id}${retry ? `, retry in ${retry}s` : ""})`;
    } else if (code === "rate_limited") {
      message = retry ? `${base} Try again in ${retry}s.` : `${base} Wait a moment and try again.`;
    }
    return { code, message, provider: b?.provider?.id, retryAfterSec: retry };
  }
  if (err instanceof TypeError) {
    return { code: "network", message: "Could not reach the server. Check that it is running and you are online." };
  }
  if (err instanceof SyntaxError) {
    return { code: "internal", message: "The server sent a response that is not valid JSON." };
  }
  if (err instanceof Error && err.message) return { code: "unknown", message: err.message };
  return { code: "unknown", message: "Something went wrong." };
}

function statusToCode(status: number): string {
  if (status === 400 || status === 422) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "provider_error";
  return "internal";
}

/** Auth-form specific mapping: turns API errors into the sentence the login/signup forms show. */
export function describeAuthError(err: unknown, kind: "login" | "signup"): string {
  const d = describeError(err);
  if (d.code === "unauthorized") return kind === "login" ? "Username or password is incorrect." : d.message;
  if (d.code === "conflict" && kind === "signup") return "That username is taken.";
  if (d.code === "forbidden" && kind === "signup") return "Sign-up is turned off on this server. Ask its operator for an account.";
  if (d.code === "rate_limited") {
    return d.retryAfterSec
      ? `Too many attempts. Try again in ${formatWait(d.retryAfterSec)}.`
      : "Too many attempts. Wait a few minutes and try again.";
  }
  return d.message;
}

export function formatWait(sec: number): string {
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const m = Math.ceil(sec / 60);
  return `${m} min`;
}

/** The server answers a wrong confirming password with 401 or with 400 + a message about the password. */
export function isWrongPassword(err: unknown): boolean {
  if (!err) return false;
  const d = describeError(err);
  return d.code === "unauthorized" || (d.code === "bad_request" && /password/i.test(d.message));
}
