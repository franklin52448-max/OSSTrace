import { HttpClient, type Budget } from "../lib/http.ts";

type JupToken = { id?: string; icon?: string | null };

export const SOURCE = "jupiter";
const TTL_MS = 24 * 3600_000;
const CHUNK = 100;

/**
 * A provider-supplied logo URL, kept only when it is plain https (no data:, javascript:, http: or
 * relative URLs reach the browser). Anything else is null.
 */
export function httpsUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 2048) return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Solana token logos from Jupiter's token search (the RPC balance calls carry none). Cached in memory
 * for a day, including misses. Throws ProviderError if Jupiter fails; callers treat logos as optional.
 */
export class TokenLogoService {
  readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly cache = new Map<string, { url: string | null; at: number }>();
  constructor(baseUrl: string, fetchImpl?: typeof fetch) {
    this.baseUrl = baseUrl;
    this.http = new HttpClient(SOURCE, 2, fetchImpl);
  }

  async solana(mints: string[], budget?: Budget): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const stale: string[] = [];
    for (const m of new Set(mints)) {
      const hit = this.cache.get(m);
      if (hit && Date.now() - hit.at < TTL_MS) out.set(m, hit.url);
      else stale.push(m);
    }
    for (let i = 0; i < stale.length; i += CHUNK) {
      const group = stale.slice(i, i + CHUNK);
      const { data } = await this.http.json<JupToken[]>(`${this.baseUrl}/search?query=${group.join(",")}`, { budget, timeoutMs: 8000, maxRetries: 1 });
      const icons = new Map((Array.isArray(data) ? data : []).filter((t) => t.id).map((t) => [t.id!, httpsUrl(t.icon)]));
      const at = Date.now();
      for (const m of group) {
        const url = icons.get(m) ?? null;
        this.cache.set(m, { url, at });
        out.set(m, url);
      }
    }
    return out;
  }
}
