import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CHAIN_NAMES, CHAINS, detectChain, EVM_CHAINS, isEvmChain, normalizeAddress, type BalancesResponse, type Chain, type ChainStatus, type HealthResponse, type SearchHit, type TokenBalance } from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { budgetMs } from "../lib/http.ts";
import { formatUnits } from "../chain/amount.ts";
import type { RawBalance } from "../chain/types.ts";
import { chain as chainSchema, parse } from "../schemas.ts";
import { LabelIndex } from "../services/labelIndex.ts";
import { counterpartiesFor, parseAddress, queryTransfers, syncAll, windowOf } from "../services/transfers.ts";

/** Max balance rows returned (busy wallets hold thousands of spam tokens); `truncated` says when it bites. */
export const BALANCES_CAP = 1000;
const numQ = z.coerce.number().finite();
const listQ = z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean));

const transfersQuery = z.object({
  base: listQ,
  counterparties: listQ,
  flow: z.enum(["in", "out", "all", "self"]).default("all"),
  usdGte: numQ.optional(),
  usdLte: numQ.optional(),
  valueGte: numQ.optional(),
  valueLte: numQ.optional(),
  tokens: listQ,
  chain: chainSchema.optional(),
  timeLast: z.string().max(10).optional(),
  timeGte: z.string().max(40).optional(),
  timeLte: z.string().max(40).optional(),
  sortKey: z.enum(["time", "value", "usd"]).default("time"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
  cursor: z.string().max(500).optional(),
});

const cpQuery = z.object({
  flow: z.enum(["in", "out", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  timeLast: z.string().max(10).optional(),
  timeGte: z.string().max(40).optional(),
  timeLte: z.string().max(40).optional(),
  usdGte: numQ.optional(),
});

const searchQuery = z.object({ q: z.string().max(200).default(""), limit: z.coerce.number().int().min(1).max(50).default(10) });

export function registerChainRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  let statusCache: { at: number; value: ChainStatus[] } | null = null;

  const chainStatuses = async (): Promise<ChainStatus[]> => {
    if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
    const value = await Promise.all(
      CHAINS.map(async (c): Promise<ChainStatus> => {
        const p = ctx.providers[c];
        const r = await p.ping();
        return { id: c, name: CHAIN_NAMES[c], provider: p.name, ok: r.ok, ...(r.note ? { note: r.note } : {}) };
      }),
    );
    statusCache = { at: Date.now(), value };
    return value;
  };

  app.get("/api/health", async (): Promise<HealthResponse> => ({ ok: true, version: ctx.version, allowSignup: ctx.config.allowSignup, chains: await chainStatuses() }));

  app.get("/api/chains", async (req) => {
    requireUser(req);
    return chainStatuses();
  });

  // Anon (signed-out) access, same as /api/address/... below (ADR 0024): an anonymous caller can
  // still search by pasting an address, it just never matches private labels/entities (there's no
  // account for those to belong to) -- u is null rather than requireUser() throwing.
  app.get("/api/search", async (req) => {
    const u = req.user ?? null;
    const { q, limit } = parse(searchQuery, req.query);
    const s = q.trim();
    const hits: SearchHit[] = [];
    if (!s) return { hits };
    const detected = detectChain(s);
    if (detected) {
      // A 0x address is the same account on every EVM chain, and a paste doesn't say which one the
      // user means -- offer each (Ethereum first, the shape's default), never silently just one.
      const chains: readonly Chain[] = isEvmChain(detected) ? EVM_CHAINS : [detected];
      const keys = chains.map((chain) => ({ chain, address: normalizeAddress(chain, s) }));
      const ix = LabelIndex.load(db, u?.id ?? null, keys);
      for (const k of keys) hits.push({ type: "address", ...k, info: ix.info(k.chain, k.address) });
    }
    const like = `%${s.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    let labels: { id: string; chain: Chain; address: string; name: string }[] = [];
    if (u) {
      const ents = db.all<{ id: string; name: string; n: number }>(
        `SELECT e.id, e.name, (SELECT COUNT(*) FROM labels l WHERE l.entity_id = e.id) AS n FROM entities e
         WHERE e.user_id = ? AND e.name LIKE ? ESCAPE '\\' ORDER BY e.name LIMIT ?`,
        u.id,
        like,
        limit,
      );
      for (const e of ents) hits.push({ type: "entity", id: e.id, name: e.name, addressCount: Number(e.n) });
      labels = db.all<{ id: string; chain: Chain; address: string; name: string }>(
        `SELECT id, chain, address, name FROM labels WHERE user_id = ? AND (name LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\') ORDER BY name LIMIT ?`,
        u.id,
        like,
        like,
        limit,
      );
      for (const l of labels) hits.push({ type: "label", id: l.id, chain: l.chain, address: l.address, name: l.name });
    }
    // A label hit carries the name, so it replaces an address hit for the same (chain, address).
    const labelled = new Set(labels.map((l) => `${l.chain}:${l.address}`));
    const deduped = hits.filter((h) => !(h.type === "address" && labelled.has(`${h.chain}:${h.address}`)));
    return { hits: deduped.slice(0, limit) };
  });

  // Anon (signed-out) access: real data, no account needed (ADR 0024). Depth is capped for anon callers
  // (see syncAll's `anon` option / ANON_TX_CAP) -- connecting a wallet removes the cap, not the gate.
  app.get<{ Params: { chain: string; address: string } }>("/api/address/:chain/:address", async (req) => {
    const a = parseAddress(req.params.chain, req.params.address);
    return LabelIndex.load(db, req.user?.id ?? null, [a]).info(a.chain, a.address);
  });

  app.get<{ Params: { chain: string; address: string } }>("/api/address/:chain/:address/balances", async (req) => {
    const a = parseAddress(req.params.chain, req.params.address);
    const budget = budgetMs(20_000);
    const raw = await ctx.providers[a.chain].fetchBalances(a.address, budget);
    // Price the native asset plus at most 150 tokens (DefiLlama has no price for most spam tokens anyway).
    const coins = raw.filter((b) => b.priceCoin).slice(0, 151).map((b) => b.priceCoin!);
    let prices = new Map<string, { usd: number | null; symbol: string | null; decimals: number | null }>();
    let priceNote = false;
    try {
      prices = await ctx.prices.current(coins, budget);
    } catch {
      priceNote = true; // balances are still real; USD is unknown
    }
    // Solana's RPC balances carry no logos: look up the priced tokens first (the ones shown by default),
    // at most 200. A failure only loses the logos.
    let logos = new Map<string, string | null>();
    if (a.chain === "solana") {
      const tokens = raw.filter((b) => b.tokenId !== "native");
      const priced = (b: RawBalance) => (b.priceCoin && prices.get(b.priceCoin)?.usd != null ? 0 : 1);
      const mints = [...tokens].sort((x, y) => priced(x) - priced(y)).slice(0, 200).map((b) => b.tokenId);
      logos = await ctx.tokenLogos.solana(mints, budget).catch(() => logos);
    }
    const balances: TokenBalance[] = raw.map((b) => {
      const p = b.priceCoin ? prices.get(b.priceCoin) : undefined;
      const decimals = b.decimals ?? p?.decimals ?? null;
      const amount = formatUnits(b.amountRaw, decimals);
      const usd = p?.usd != null && decimals !== null ? Number(amount) * p.usd : null;
      return {
        tokenId: b.tokenId,
        symbol: b.symbol ?? p?.symbol ?? null,
        name: b.name,
        decimals,
        amountRaw: b.amountRaw,
        amount,
        usd: usd !== null && Number.isFinite(usd) ? usd : null,
        price: p?.usd ?? null,
        priceSource: p?.usd != null ? "defillama" : null,
        logoUrl: b.logoUrl ?? logos.get(b.tokenId) ?? null,
      };
    });
    balances.sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1) || (x.tokenId === "native" ? -1 : y.tokenId === "native" ? 1 : 0));
    const priced = balances.filter((b) => b.usd !== null);
    const res: BalancesResponse = {
      address: LabelIndex.load(db, req.user?.id ?? null, [a]).info(a.chain, a.address),
      balances: balances.slice(0, BALANCES_CAP),
      truncated: balances.length > BALANCES_CAP,
      totalTokenCount: balances.length,
      totalUsd: priceNote || priced.length === 0 ? (balances.length === 0 ? 0 : null) : priced.reduce((s, b) => s + b.usd!, 0),
      fetchedAt: new Date().toISOString(),
    };
    return res;
  });

  app.get<{ Params: { chain: string; address: string } }>("/api/address/:chain/:address/counterparties", async (req) => {
    const userId = req.user?.id ?? null;
    const a = parseAddress(req.params.chain, req.params.address);
    const q = parse(cpQuery, req.query);
    const w = windowOf(q);
    const sync = await syncAll(ctx, [a], w.from, { maxRounds: w.from === null ? 1 : undefined, anon: !userId });
    const counterparties = counterpartiesFor(ctx, userId, a, { flow: q.flow, limit: q.limit, from: w.from, to: w.to, usdGte: q.usdGte });
    return { counterparties, sync };
  });

  app.get("/api/transfers", async (req) => {
    const q = parse(transfersQuery, req.query);
    return queryTransfers(ctx, req.user?.id ?? null, q);
  });
}
