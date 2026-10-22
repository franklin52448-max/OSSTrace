/**
 * Boots a real `@osstrace/server` instance (ADR 0022) — real Fastify app, real in-memory SQLite,
 * a real listening port — for tests that exercise `serverSession.ts` against the genuine auth
 * routes and the CORS headers `app.ts` sends. Auth never touches a chain provider, so this uses
 * the server's own real default providers unconfigured rather than a fake one: no chain route is
 * ever called by these tests, so no real network request happens.
 */
import { loadConfig, type Config } from "@osstrace/server/src/config.ts";
import { buildApp } from "@osstrace/server/src/app.ts";

export interface RunningNewServer {
  url: string;
  close(): Promise<void>;
}

/**
 * `configOverrides`/`fetchImpl` are for tests that DO need a chain provider or an outbound fetch
 * stub (e.g. bounty deposit verification, which calls Solana RPC / Blockscout directly) --
 * everything else can leave them unset, same as before.
 */
export async function startNewServer(allowedOrigins: string[], opts: { configOverrides?: Partial<Config>; fetchImpl?: typeof fetch } = {}): Promise<RunningNewServer> {
  const config = {
    ...loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    dbPath: ":memory:",
    allowedOrigins,
    ...opts.configOverrides,
  };
  const { app } = await buildApp(config, { logger: false, fetchImpl: opts.fetchImpl });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    url,
    close: () => app.close(),
  };
}
