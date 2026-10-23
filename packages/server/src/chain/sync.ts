import type { Chain, SyncStatus } from "@osstrace/contract";
import type { Db } from "../db/index.ts";
import { ProviderError } from "../lib/errors.ts";
import { budgetMs, type Budget } from "../lib/http.ts";
import { nowIso, secToIso } from "../lib/time.ts";
import { bucketOf, SOURCE, type PriceService } from "./prices.ts";
import { FROM_IS, TO_IS, TransferStore, type TransferRow } from "./store.ts";
import type { ChainProvider } from "./types.ts";

type StreamState = {
  started: boolean;
  cursor: string | null;
  oldest: number | null;
  newest: number | null;
  done: boolean;
  /** After a provider failure the stream is skipped until this time (epoch ms) so one slow endpoint doesn't stall every request. */
  failUntil?: number;
  failMsg?: string;
};
const STREAM_FAIL_BACKOFF_MS = 5 * 60_000;
type SyncRow = { streams_json: string; covered_from: number | null; complete: number; head_at: string | null; last_error: string | null; warning: string | null };

export type EnsureOpts = {
  /** Oldest time (epoch s) the caller needs covered; null = "as much as the budget allows". */
  windowFrom: number | null;
  budget?: Budget | undefined;
  /** Fetch the newest page even if it was fetched recently. */
  forceHead?: boolean;
  /** Only refresh the newest page (alert worker). */
  headOnly?: boolean;
  /** Max backfill rounds for this call. */
  maxRounds?: number | undefined;
};

const HEAD_TTL_MS = 30_000;
const DEFAULT_BUDGET_MS = 12_000;

const rank = { ready: 0, syncing: 1, partial: 2, error: 3 } as const;
export function mergeSync(list: SyncStatus[], fallbackProvider = "none"): SyncStatus {
  if (list.length === 0) return { state: "ready", coveredFrom: null, provider: fallbackProvider };
  let state: SyncStatus["state"] = "ready";
  let covered: string | null = null;
  const providers = new Set<string>();
  const messages: string[] = [];
  for (const s of list) {
    if (rank[s.state] > rank[state]) state = s.state;
    // The merged coverage is the most restrictive (latest) start.
    if (s.coveredFrom && (!covered || s.coveredFrom > covered)) covered = s.coveredFrom;
    providers.add(s.provider);
    if (s.message && !messages.includes(s.message)) messages.push(s.message);
  }
  return { state, coveredFrom: covered, provider: [...providers].join(", "), ...(messages.length ? { message: messages.join("; ") } : {}) };
}

/**
 * Request-driven sync of an address's transfer history into the local cache. Each provider stream is
 * paged newest-first; the head is refreshed (at most every 30 s), then older pages are fetched until the
 * requested window is covered or the per-request budget runs out (then state = "partial").
 * Calls for the same address are serialized.
 */
export class SyncService {
  private locks = new Map<string, Promise<unknown>>();
  private readonly db: Db;
  readonly providers: Record<Chain, ChainProvider>;
  readonly store: TransferStore;
  private readonly prices: PriceService;
  private readonly log?: { warn: (o: object, m: string) => void } | undefined;
  constructor(
    db: Db,
    providers: Record<Chain, ChainProvider>,
    store: TransferStore,
    prices: PriceService,
    log?: { warn: (o: object, m: string) => void },
  ) {
    this.db = db;
    this.providers = providers;
    this.store = store;
    this.prices = prices;
    this.log = log;
  }

  ensureSynced(chain: Chain, address: string, opts: EnsureOpts): Promise<SyncStatus> {
    const key = `${chain}:${address}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.doSync(chain, address, opts));
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  private load(chain: Chain, address: string, provider: ChainProvider) {
    const row = this.db.get<SyncRow>("SELECT streams_json, covered_from, complete, head_at, last_error, warning FROM address_sync WHERE chain = ? AND address = ?", chain, address);
    const saved: Record<string, StreamState> = row ? JSON.parse(row.streams_json) : {};
    // Only the current provider's streams: a row saved by a chain's previous provider (BNB once read
    // Etherscan's five streams, Base and Robinhood Chain Blockscout's three) would otherwise keep
    // names nothing fetches any more, which never start -- "not loaded yet" and "partial" forever.
    const streams: Record<string, StreamState> = {};
    for (const s of provider.streams()) streams[s] = saved[s] ?? { started: false, cursor: null, oldest: null, newest: null, done: false };
    return { row, streams };
  }

  /**
   * Coverage over the streams that have started. A stream that never loaded (provider failing) does not
   * block the others; it keeps the state "partial" with a message instead. `complete` needs every stream done.
   */
  private coverage(streams: Record<string, StreamState>): { coveredFrom: number | null; complete: boolean; started: boolean; missing: string[] } {
    const entries = Object.entries(streams);
    const started = entries.filter(([, s]) => s.started).map(([, s]) => s);
    const missing = entries.filter(([, s]) => !s.started).map(([n]) => n);
    if (started.length === 0) return { coveredFrom: null, complete: false, started: false, missing };
    const open = started.filter((s) => !s.done);
    if (open.length === 0) {
      const oldest = started.map((s) => s.oldest).filter((x): x is number => x !== null);
      return { coveredFrom: oldest.length ? Math.min(...oldest) : null, complete: missing.length === 0, started: true, missing };
    }
    // Every open stream is covered back to its own `oldest`; the address is covered back to the latest of those.
    const c = Math.max(...open.map((s) => s.oldest ?? Number.POSITIVE_INFINITY));
    return { coveredFrom: Number.isFinite(c) ? c : null, complete: false, started: true, missing };
  }

  private async doSync(chain: Chain, address: string, opts: EnsureOpts): Promise<SyncStatus> {
    const provider = this.providers[chain];
    const budget = opts.budget ?? budgetMs(DEFAULT_BUDGET_MS);
    const { row, streams } = this.load(chain, address, provider);
    const warnings: string[] = [];
    const errors: ProviderError[] = [];
    let headAt = row?.head_at ?? null;
    let succeeded = false;
    const notes = new Set<string>();

    const fetchPage = async (stream: string, cursor: string | null) => {
      const page = await provider.fetchStreamPage(address, stream, cursor, budget);
      this.store.upsert(page.transfers);
      succeeded = true;
      if (page.note) notes.add(page.note);
      return page;
    };
    const onErr = (stream: string, e: unknown) => {
      if (e instanceof ProviderError) {
        errors.push(e);
        warnings.push(provider.streams().length > 1 ? `${stream}: ${e.message}` : e.message);
      } else {
        this.log?.warn({ err: e instanceof Error ? e.message : String(e), chain, stream }, "sync stream failed");
        warnings.push(`${stream}: unexpected provider response`);
        errors.push(new ProviderError(provider.id, `${provider.id}: unexpected response`));
      }
    };

    // 1. Head refresh.
    const inBackoff = (st: StreamState) => st.failUntil !== undefined && st.failUntil > Date.now();
    const headStale =
      !headAt || Date.now() - Date.parse(headAt) > HEAD_TTL_MS || Object.values(streams).some((s) => !s.started && !inBackoff(s));
    if (opts.forceHead || headStale) {
      await Promise.all(
        provider.streams().map(async (name) => {
          const st = streams[name]!;
          if (inBackoff(st)) {
            warnings.push(provider.streams().length > 1 ? `${name}: ${st.failMsg ?? "unavailable"}` : st.failMsg ?? "provider unavailable");
            return;
          }
          try {
            let page = await fetchPage(name, null);
            if (!st.started) {
              Object.assign(st, { started: true, cursor: page.nextCursor, oldest: page.oldestTime, newest: page.newestTime, done: page.nextCursor === null });
              return;
            }
            const prevNewest = st.newest;
            let headCursor = page.nextCursor;
            let headOldest = page.oldestTime;
            let pages = 1;
            st.newest = Math.max(st.newest ?? 0, page.newestTime ?? 0) || st.newest;
            // Keep paging until this refresh overlaps what we already had.
            while (prevNewest !== null && headCursor && headOldest !== null && headOldest > prevNewest && pages < 3 && Date.now() < budget.deadline - 1000) {
              page = await fetchPage(name, headCursor);
              headCursor = page.nextCursor;
              headOldest = page.oldestTime ?? headOldest;
              pages++;
            }
            if (prevNewest !== null && headCursor && headOldest !== null && headOldest > prevNewest) {
              // Gap between this refresh and the older cache: restart coverage from the refresh.
              Object.assign(st, { cursor: headCursor, oldest: headOldest, done: false });
            }
            delete st.failUntil;
            delete st.failMsg;
          } catch (e) {
            onErr(name, e);
            // Single-stream providers (Solana) retry on the next request; multi-stream ones back off the failing stream.
            if (provider.streams().length > 1) {
              st.failUntil = Date.now() + STREAM_FAIL_BACKOFF_MS;
              st.failMsg = e instanceof Error ? e.message : "unavailable";
            }
          }
        }),
      );
      if (succeeded) headAt = nowIso();
    }

    // 2. Backfill toward the requested window.
    if (!opts.headOnly) {
      const maxRounds = opts.maxRounds ?? (opts.windowFrom === null ? 0 : 6);
      for (let round = 0; round < maxRounds && Date.now() < budget.deadline - 1500; round++) {
        const cov = this.coverage(streams);
        if (!cov.started || cov.complete) break;
        if (opts.windowFrom !== null && cov.coveredFrom !== null && cov.coveredFrom <= opts.windowFrom) break;
        const failedStreams = new Set(warnings.map((w) => w.split(":")[0]));
        const open = provider
          .streams()
          .filter((n) => !streams[n]!.done && streams[n]!.started && !inBackoff(streams[n]!) && !failedStreams.has(n) && !(provider.streams().length === 1 && errors.length));
        if (open.length === 0) break;
        // Fetch the streams that limit coverage: all open streams above the window, or the latest one.
        const target =
          opts.windowFrom !== null
            ? open.filter((n) => (streams[n]!.oldest ?? Infinity) > opts.windowFrom!)
            : open.filter((n) => (streams[n]!.oldest ?? Infinity) === Math.max(...open.map((m) => streams[m]!.oldest ?? Infinity)));
        if (target.length === 0) break;
        let progressed = false;
        await Promise.all(
          target.map(async (name) => {
            const st = streams[name]!;
            try {
              const page = await fetchPage(name, st.cursor);
              if (page.nextCursor !== st.cursor || page.oldestTime !== null) progressed = true;
              st.cursor = page.nextCursor;
              if (page.oldestTime !== null) st.oldest = Math.min(st.oldest ?? page.oldestTime, page.oldestTime);
              st.done = page.nextCursor === null;
            } catch (e) {
              onErr(name, e);
            }
          }),
        );
        if (!progressed) break;
      }
    }

    // 3. Prices for anything new (failures leave usd NULL and are retried on the next sync).
    try {
      await this.priceAddress(chain, address, budget);
    } catch (e) {
      if (!(e instanceof ProviderError)) this.log?.warn({ err: String(e) }, "pricing failed");
    }

    const cov = this.coverage(streams);
    for (const m of cov.missing)
      if (!warnings.some((w) => w.startsWith(`${m}:`))) warnings.push(streams[m]!.failMsg ? `${m}: ${streams[m]!.failMsg} (retrying later)` : `${m}: not loaded yet`);
    const warning = warnings.length || notes.size ? [...new Set([...warnings, ...notes])].join("; ") : null;
    const lastError = errors.length > 0 && !succeeded ? errors[0]!.message : null;
    this.db.run(
      `INSERT INTO address_sync (chain, address, streams_json, covered_from, complete, head_at, last_error, warning, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chain, address) DO UPDATE SET streams_json = excluded.streams_json, covered_from = excluded.covered_from,
         complete = excluded.complete, head_at = excluded.head_at, last_error = excluded.last_error, warning = excluded.warning, updated_at = excluded.updated_at`,
      chain,
      address,
      JSON.stringify(streams),
      cov.coveredFrom,
      cov.complete ? 1 : 0,
      headAt,
      lastError,
      warning,
      nowIso(),
    );

    // Nothing cached and every stream failed: this is a provider error, not an empty result.
    if (!cov.started && (errors.length > 0 || warning)) {
      const e = errors.find((x) => x.retryAfterSec !== undefined) ?? errors[0] ?? new ProviderError(provider.id, `${provider.name}: ${warning}`, 60);
      throw e;
    }

    let state: SyncStatus["state"];
    const windowCovered = cov.complete || (opts.windowFrom !== null && cov.coveredFrom !== null && cov.coveredFrom <= opts.windowFrom);
    if (lastError) state = "error";
    else if (warning || !windowCovered) state = "partial";
    else state = "ready";
    const messages: string[] = [];
    if (lastError) messages.push(`${lastError}; showing cached data`);
    else if (warning) messages.push(warning);
    if (!windowCovered && !lastError) messages.push(cov.coveredFrom ? `history loaded back to ${secToIso(cov.coveredFrom).slice(0, 10)}; more loads on later requests` : "history partially loaded");
    return {
      state,
      coveredFrom: cov.coveredFrom !== null ? secToIso(cov.coveredFrom) : null,
      provider: provider.name,
      ...(messages.length ? { message: messages.join("; ") } : {}),
    };
  }

  /** Current sync status without touching the network. */
  status(chain: Chain, address: string, windowFrom: number | null): SyncStatus {
    const provider = this.providers[chain];
    const row = this.db.get<SyncRow>("SELECT streams_json, covered_from, complete, head_at, last_error, warning FROM address_sync WHERE chain = ? AND address = ?", chain, address);
    if (!row) return { state: "partial", coveredFrom: null, provider: provider.name, message: "not loaded yet" };
    const complete = row.complete === 1;
    const covered = complete || (windowFrom !== null && row.covered_from !== null && row.covered_from <= windowFrom);
    return {
      state: row.last_error ? "error" : row.warning || !covered ? "partial" : "ready",
      coveredFrom: row.covered_from !== null ? secToIso(Number(row.covered_from)) : null,
      provider: provider.name,
      ...(row.last_error ? { message: row.last_error } : row.warning ? { message: row.warning } : {}),
    };
  }

  /** Fill USD for this address's unpriced transfers from historical prices. */
  async priceAddress(chain: Chain, address: string, budget?: Budget) {
    const rows = this.db.all<TransferRow>(
      `SELECT t.chain, t.id, t.block_time, t.token_id, t.token_standard, t.token_decimals, t.amount, t.token_symbol FROM transfers t
       WHERE t.chain = ? AND t.price_checked_at IS NULL AND (${FROM_IS("?")} OR ${TO_IS("?")})
       ORDER BY t.block_time DESC LIMIT 400`,
      chain,
      address,
      address,
      address,
      address,
    );
    if (rows.length === 0) return;
    // Unknown decimals means `amount` is the unscaled base-unit integer: a price times it would be off
    // by 10^decimals. Such a row is marked checked and left unpriced, same as the balances route does.
    const pts = rows.map((r) => ({ r, coin: r.token_decimals === null ? null : TransferStore.coinFor(r) }));
    const prices = await this.prices.historical(
      pts.filter((p) => p.coin).map((p) => ({ coin: p.coin!, time: Number(p.r.block_time) })),
      budget,
    );
    const at = nowIso();
    this.db.tx(() => {
      for (const { r, coin } of pts) {
        if (!coin) {
          this.db.run("UPDATE transfers SET price_checked_at = ? WHERE chain = ? AND id = ?", at, r.chain, r.id);
          continue;
        }
        const p = prices.get(`${coin}|${bucketOf(Number(r.block_time))}`);
        if (!p) continue;
        const usd = p.usd === null ? null : Number(r.amount) * p.usd;
        this.db.run(
          `UPDATE transfers SET usd = ?, price_source = ?, price_checked_at = ?, token_symbol = COALESCE(token_symbol, ?) WHERE chain = ? AND id = ?`,
          usd !== null && Number.isFinite(usd) ? usd : null,
          usd !== null ? SOURCE : null,
          at,
          p.symbol,
          r.chain,
          r.id,
        );
      }
    });
  }
}
