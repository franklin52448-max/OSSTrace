import cookie from "@fastify/cookie";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Chain } from "@osstrace/contract";
import { BlockscoutProvider } from "./chain/ethereum.ts";
import { PriceService } from "./chain/prices.ts";
import { TokenLogoService } from "./chain/tokenLogos.ts";
import { SolanaRpcProvider } from "./chain/solana.ts";
import { TransferStore } from "./chain/store.ts";
import { SyncService } from "./chain/sync.ts";
import type { ChainProvider } from "./chain/types.ts";
import type { Config } from "./config.ts";
import type { Ctx, WebhookSender } from "./context.ts";
import { openDb, type Db } from "./db/index.ts";
import { cookieOpts, devUser, ensureDevUser, resolveSession, SESSION_COOKIE } from "./auth/sessions.ts";
import { ApiErr, ProviderError } from "./lib/errors.ts";
import { safePost, systemResolver, type Resolver } from "./lib/ssrf.ts";
import { AlertWorker } from "./services/alerts.ts";
import { registerAuth } from "./routes/auth.ts";
import { registerSettings } from "./routes/settings.ts";
import { registerChainRoutes } from "./routes/chain.ts";
import { registerTraces } from "./routes/traces.ts";
import { registerViews } from "./routes/views.ts";
import { registerLabels } from "./routes/labels.ts";
import { registerAlerts } from "./routes/alerts.ts";
import { registerBounties } from "./routes/bounties.ts";

export const VERSION = "0.1.0";

export type AppOverrides = {
  db?: Db;
  providers?: Partial<Record<Chain, ChainProvider>>;
  prices?: PriceService;
  fetchImpl?: typeof fetch;
  resolver?: Resolver;
  sendWebhook?: WebhookSender;
  logger?: boolean;
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Minimal fixed-window limiter per key (in memory). */
class WindowLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  hit(key: string): number | null {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset <= now) {
      h = { n: 0, reset: now + this.windowMs };
      this.hits.set(key, h);
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }
    h.n++;
    return h.n > this.max ? Math.ceil((h.reset - now) / 1000) : null;
  }
}

export async function buildApp(config: Config, o: AppOverrides = {}): Promise<{ app: FastifyInstance; ctx: Ctx; worker: AlertWorker }> {
  const db = o.db ?? openDb(config.dbPath);
  if (config.devSkipAuth) ensureDevUser(db); // local dev only -- config.ts refuses this when production is true
  const providers: Record<Chain, ChainProvider> = {
    ethereum: o.providers?.ethereum ?? new BlockscoutProvider(config.ethBlockscoutUrl, o.fetchImpl),
    solana:
      o.providers?.solana ??
      new SolanaRpcProvider(config.solanaRpcUrl, config.solanaRpcCustom, o.fetchImpl, {
        // Token accounts this wallet's tokens recently moved through (from the local cache), newest first.
        recentTokenAccounts: (wallet) =>
          db
            .all<{ a: string }>(
              `SELECT a FROM (
                 SELECT to_addr AS a, MAX(block_time) AS bt FROM transfers WHERE chain = 'solana' AND to_owner = ? AND to_addr <> ? GROUP BY to_addr
                 UNION ALL
                 SELECT from_addr AS a, MAX(block_time) AS bt FROM transfers WHERE chain = 'solana' AND from_owner = ? AND from_addr <> ? GROUP BY from_addr
               ) x GROUP BY a ORDER BY MAX(bt) DESC LIMIT 50`,
              wallet, wallet, wallet, wallet,
            )
            .map((r) => r.a),
        // Prices already in the local cache (no network): newest known USD price per mint.
        cachedUsdPrices: (mints) => {
          const out = new Map<string, number>();
          for (let i = 0; i < mints.length; i += 400) {
            const part = mints.slice(i, i + 400).map((m) => `solana:${m}`);
            for (const r of db.all<{ coin: string; usd: number }>(
              `SELECT coin, usd FROM prices WHERE usd IS NOT NULL AND coin IN (${part.map(() => "?").join(",")}) ORDER BY CASE WHEN bucket = -1 THEN 9e18 ELSE bucket END`,
              ...part,
            ))
              out.set(r.coin.slice(7), Number(r.usd));
          }
          return out;
        },
        ...(config.solscanApiKey ? { solscanApiKey: config.solscanApiKey } : {}),
      }),
  };
  const prices = o.prices ?? new PriceService(db, config.defillamaUrl, o.fetchImpl);
  const tokenLogos = new TokenLogoService(config.jupiterTokensUrl, o.fetchImpl);
  const store = new TransferStore(db);
  const resolver = o.resolver ?? systemResolver;

  const app = Fastify({
    logger:
      o.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                "req.headers.cookie",
                "req.headers.authorization",
                'res.headers["set-cookie"]',
                "signature",
                "*.secret",
                "secret",
              ],
              censor: "[redacted]",
            },
          },
    trustProxy: config.trustProxy,
    bodyLimit: 6 * 1024 * 1024,
  });

  const sync = new SyncService(db, providers, store, prices, app.log);
  const ctx: Ctx = {
    config,
    db,
    providers,
    prices,
    tokenLogos,
    store,
    sync,
    resolver,
    sendWebhook: o.sendWebhook ?? ((url, body, headers) => safePost(url, body, headers, { resolve: resolver, timeoutMs: 5000 })),
    version: VERSION,
    fetchImpl: o.fetchImpl ?? fetch,
  };

  await app.register(cookie);
  app.decorateRequest("user", null);

  // JSON only. Empty bodies are allowed on mutating requests; text/plain (a CSRF vector) is not parsed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const s = typeof body === "string" ? body : body.toString("utf8");
    if (s.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(s));
    } catch {
      done(new ApiErr("bad_request", "Malformed JSON body") as unknown as Error, undefined);
    }
  });

  const globalLimiter = new WindowLimiter(600, 60_000);
  const allowed = new Set(config.allowedOrigins);

  // CORS: the session is a cookie, not a bearer token, so a cross-origin browser client (this
  // server and the web UI are different origins/ports, unlike the design this server's own
  // frontend used, which proxied /api through its own dev server and so never needed this) needs
  // real Access-Control-Allow-Origin/-Credentials headers, or the browser refuses to send or read
  // the cookie at all -- the Origin allowlist below is the same one the CSRF check already uses.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const origin = req.headers.origin;
    if (typeof origin === "string" && allowed.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
      // Not CORS-safelisted response headers, so the web UI can't read them unless exposed.
      reply.header("access-control-expose-headers", "retry-after");
    }
    if (req.method === "OPTIONS") {
      reply.header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
      reply.header("access-control-allow-headers", "content-type");
      reply.header("access-control-max-age", "600");
      return reply.status(204).send();
    }
    const wait = globalLimiter.hit(req.ip);
    if (wait !== null) {
      reply.header("retry-after", String(wait));
      throw new ApiErr("rate_limited", "Too many requests", { retryAfterSec: wait });
    }
    if (MUTATING.has(req.method)) {
      // CSRF: Origin (or Referer) must be an allowed origin or this server's own origin.
      const host = req.headers.host;
      const self = host ? [`http://${host}`, `https://${host}`] : [];
      let origin = req.headers.origin;
      if (!origin && req.headers.referer) {
        try {
          origin = new URL(req.headers.referer).origin;
        } catch {
          origin = undefined;
        }
      }
      if (!origin || origin === "null" || !(allowed.has(origin) || self.includes(origin))) {
        throw new ApiErr("forbidden", "Cross-origin request refused (Origin check)");
      }
      const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
      const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (hasBody && ct !== "application/json") {
        throw new ApiErr("bad_request", "Content-Type must be application/json", {}, 415);
      }
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const s = resolveSession(db, token);
      if (s) {
        req.user = s.user;
        if (s.slid) reply.setCookie(SESSION_COOKIE, token, cookieOpts(config));
      } else {
        reply.clearCookie(SESSION_COOKIE, { path: "/" });
      }
    }
    // Local dev only (config.ts refuses this in production): fills the gap when there's no real
    // session, so the whole site behaves as signed in without touching the real wallet-auth routes.
    if (config.devSkipAuth && !req.user) req.user = devUser();
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (req.url.startsWith("/api/")) {
      reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    }
    if (config.cookieSecure) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  app.setErrorHandler((err: FastifyError | ApiErr | ProviderError | Error, req, reply) => {
    if (err instanceof ProviderError) err = err.toApi();
    if (err instanceof ApiErr) {
      if (err.extra.retryAfterSec) reply.header("retry-after", String(err.extra.retryAfterSec));
      if (err.extra.provider?.retryAfterSec) reply.header("retry-after", String(err.extra.provider.retryAfterSec));
      return reply.status(err.status).send(err.body());
    }
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      const status = fe.statusCode;
      const message = status === 413 ? "Request body too large" : status === 415 ? "Content-Type must be application/json" : "Bad request";
      return reply.status(status).send({ error: { code: status === 429 ? "rate_limited" : "bad_request", message } });
    }
    req.log.error({ err: { message: err.message, stack: err.stack } }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Internal error" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "Not found" } }));

  registerAuth(app, ctx);
  registerSettings(app, ctx);
  registerChainRoutes(app, ctx);
  registerTraces(app, ctx);
  registerViews(app, ctx);
  registerLabels(app, ctx);
  registerAlerts(app, ctx);
  registerBounties(app, ctx);

  const worker = new AlertWorker(ctx, app.log);
  if (config.testHooks) {
    // Deterministic hook for local verification and tests only (SERVER_TEST_HOOKS=1). Not part of the public API.
    app.post("/api/_test/alerts/tick", async () => worker.tick());
  }

  app.addHook("onClose", async () => {
    await worker.stop();
    if (!o.db) db.close();
  });
  return { app, ctx, worker };
}
