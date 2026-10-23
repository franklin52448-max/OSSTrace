import { ProviderError } from "./errors.ts";

/** Simple FIFO concurrency limiter. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export type Budget = {
  deadline: number;
  /** Set by a signed-in caller's sync request (ADR 0024's `anon` flag, inverted) -- lets a provider
   * prefer a paid indexed API (e.g. Solscan) over its own free-but-expensive-at-depth path when one
   * is configured. Anonymous callers never set this, so a paid key's budget is spent only on the
   * users it was bought to serve. */
  preferIndexed?: boolean;
};
export const budgetMs = (ms: number): Budget => ({ deadline: Date.now() + ms });

export type HttpOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  budget?: Budget | undefined;
  maxRetries?: number;
  /** Key used for cooldowns in addition to the host (e.g. an RPC method name). */
  cooldownKey?: string;
  /** Extra headers (e.g. an indexer's API-key header) merged in on top of the defaults. */
  headers?: Record<string, string>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, (t - Date.now()) / 1000);
}

/**
 * JSON-over-HTTP client for one upstream provider: per-host concurrency limit, Retry-After aware
 * backoff on 429/503, timeouts, budget (deadline) awareness. Errors never include the URL (it may
 * carry an API key); they carry the provider id only.
 */
export class HttpClient {
  private limiter: Limiter;
  private cooldownUntil = new Map<string, number>();
  readonly providerId: string;
  private readonly fetchImpl: typeof fetch;
  constructor(providerId: string, concurrency: number, fetchImpl: typeof fetch = fetch) {
    this.providerId = providerId;
    this.fetchImpl = fetchImpl;
    this.limiter = new Limiter(concurrency);
  }

  /** Seconds until this client may call again (0 when not cooling down). */
  cooldownSec(key = "*"): number {
    const until = Math.max(this.cooldownUntil.get("*") ?? 0, this.cooldownUntil.get(key) ?? 0);
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  async json<T = unknown>(url: string, opts: HttpOptions = {}): Promise<{ data: T; headers: Headers }> {
    const maxRetries = opts.maxRetries ?? 3;
    const key = opts.cooldownKey ?? "*";
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(this.cooldownUntil.get("*") ?? 0, this.cooldownUntil.get(key) ?? 0) - Date.now();
      if (wait > 0) {
        if (opts.budget && Date.now() + wait > opts.budget.deadline) {
          throw new ProviderError(this.providerId, `${this.providerId} is rate limited`, Math.ceil(wait / 1000));
        }
        await sleep(wait);
      }
      const remaining = opts.budget ? opts.budget.deadline - Date.now() : Infinity;
      if (remaining <= 0) throw new ProviderError(this.providerId, `${this.providerId}: request budget exhausted`, 1);
      const timeoutMs = Math.min(opts.timeoutMs ?? 20_000, Math.max(1000, remaining));
      let res: Response;
      try {
        res = await this.limiter.run(() =>
          this.fetchImpl(url, {
            method: opts.method ?? "GET",
            headers: {
              accept: "application/json",
              ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
              "user-agent": "osstrace/0.1 (+self-hosted)",
              ...opts.headers,
            },
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "error",
          }),
        );
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        if (attempt < 1 && !timedOut && (!opts.budget || opts.budget.deadline - Date.now() > 2000)) {
          await sleep(500);
          continue;
        }
        throw new ProviderError(this.providerId, timedOut ? `${this.providerId} timed out` : `${this.providerId} is unreachable`, 5);
      }
      if (res.status === 429 || res.status === 503) {
        await res.body?.cancel().catch(() => {});
        const ra = parseRetryAfter(res.headers.get("retry-after")) ?? Math.min(30, 2 ** attempt);
        this.cooldownUntil.set(key, Date.now() + ra * 1000);
        if (attempt < maxRetries && (!opts.budget || Date.now() + ra * 1000 < opts.budget.deadline)) continue;
        throw new ProviderError(this.providerId, `${this.providerId} is rate limited`, Math.max(1, Math.ceil(ra)));
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        if (res.status >= 500 && attempt < 1 && (!opts.budget || opts.budget.deadline - Date.now() > 3000)) {
          await sleep(750);
          continue;
        }
        throw new ProviderError(this.providerId, `${this.providerId} returned HTTP ${res.status}`, res.status >= 500 ? 10 : undefined);
      }
      try {
        return { data: (await res.json()) as T, headers: res.headers };
      } catch {
        throw new ProviderError(this.providerId, `${this.providerId} returned malformed JSON`, 5);
      }
    }
  }

  /** Lets callers apply provider-specific rate-limit headers (e.g. Solana's x-ratelimit-method-remaining). */
  coolDown(key: string, seconds: number) {
    this.cooldownUntil.set(key, Math.max(this.cooldownUntil.get(key) ?? 0, Date.now() + seconds * 1000));
  }
}
