# @osstrace/server

OSSTrace's unified backend: one Fastify server with its own SQLite store, replacing the original
nine per-feature services. See [ADR 0022](../../docs/adr/0022-unified-server-replaces-the-per-feature-services.md)
for why, what's landed, and what's still outstanding. As of this chunk, `packages/web`'s
**Workbench** tab is wired to it for real (sign up/log in, look up an address, real balances and
transfers) — Explorer/Visualizer/Tracer themselves still run on the old services, not this one yet.

## Running it

```sh
npm run dev --workspace packages/server
# or: npm run dev:server
```

Listens on `127.0.0.1:5320` by default (`PORT`/`HOST`). A SQLite file at `./data/server.db`
(`SERVER_DB`) is created on first run. No API keys required: Ethereum via Blockscout
(`ETH_BLOCKSCOUT_URL`), Solana via the public JSON-RPC (`SOLANA_RPC_URL`/`SOLANA_RPC_URL_FILE`),
prices via DefiLlama (`DEFILLAMA_URL`). See `src/config.ts` for every variable.

```sh
curl http://127.0.0.1:5320/api/health
```

## What's here

- **`src/auth/`** — username + password (scrypt), sessions (httpOnly cookie, sliding 30-day
  expiry, sha256-at-rest token), per-(ip, username) login throttling.
- **`src/chain/`** — `ChainProvider` per chain, normalizing to `Transfer` rows; `sync.ts`'s
  `ensureSynced` is request-driven (fetch until the window is covered or a budget runs out,
  report `sync.state` honestly — `partial`/`error` never silently become `ready`).
- **`src/services/`** — traces (the investigation canvas), labels/entities/tags, transfers/
  counterparties, alerts (rule matching + a background worker + webhook/in-app delivery).
- **`src/routes/`** — the real REST contract from `@osstrace/contract`'s `api.ts`.
- **`src/lib/ssrf.ts`** — guards every outbound webhook URL (loopback/private/link-local/CGNAT/
  metadata addresses blocked, DNS-rebinding checked at connect time too, no redirects followed).
- **CORS** (`app.ts`'s `onRequest` hook) — the session is a cookie, not a bearer token, so a
  cross-origin browser client only gets to send or read it with real
  `Access-Control-Allow-Origin`/`-Credentials` headers and a handled preflight `OPTIONS`, which
  this server didn't have at first (its own original frontend used a same-origin dev proxy and
  never needed this). Reuses the same `ALLOWED_ORIGINS` allowlist the CSRF check already used;
  never reflects an origin that isn't on it, never `*`. See `tests/cors.test.ts`.

## Tests

```sh
npm run test:server        # from the repo root: this package + packages/contract, via vitest
npm run test --workspace packages/server
npm run test:live -w @osstrace/server   # opt-in: hits the real Blockscout / Solana RPC / DefiLlama
```

This package tests with vitest, not the rest of the repo's plain `node --test` — see ADR 0022 §4
for why. The root `npm run check` runs both.
