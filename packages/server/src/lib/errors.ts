import type { ApiError } from "@osstrace/contract";

export type ErrorCode = ApiError["error"]["code"];

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  provider_error: 502,
  internal: 500,
};

export class ApiErr extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: { provider?: { id: string; retryAfterSec?: number }; retryAfterSec?: number };
  constructor(
    code: ErrorCode,
    message: string,
    extra: { provider?: { id: string; retryAfterSec?: number }; retryAfterSec?: number } = {},
    status?: number,
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.status = status ?? STATUS[code];
  }
  body(): ApiError {
    const error: ApiError["error"] = { code: this.code, message: this.message };
    if (this.extra.provider) error.provider = this.extra.provider;
    return { error };
  }
}

export const badRequest = (m: string) => new ApiErr("bad_request", m);
export const notFound = (what = "Not found") => new ApiErr("not_found", what);
export const unauthorized = () => new ApiErr("unauthorized", "Sign in required");
export const conflict = (m: string) => new ApiErr("conflict", m);

/** A chain/price provider failed. Never replaced by fake data. */
export class ProviderError extends Error {
  readonly providerId: string;
  readonly retryAfterSec?: number | undefined;
  constructor(providerId: string, message: string, retryAfterSec?: number) {
    super(message);
    this.providerId = providerId;
    this.retryAfterSec = retryAfterSec;
  }
  toApi(): ApiErr {
    return new ApiErr("provider_error", this.message, {
      provider: { id: this.providerId, ...(this.retryAfterSec !== undefined ? { retryAfterSec: this.retryAfterSec } : {}) },
    });
  }
}
