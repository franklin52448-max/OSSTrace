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
prices via DefiLlama (`DEFILLAMA_URL`), Bitcoin bounty-deposit checks via a public Esplora
explorer (`ESPLORA_URL`, Blockstream.info by default). See `src/config.ts` for every variable.

**BNB Chain is the one chain that needs a key.** There's no free hosted indexer for BNB Smart Chain
the way Blockscout is for Ethereum, so its history and token discovery come from Etherscan's
multichain V2 API (`ETHERSCAN_API_KEY`, `chainid=56`, `src/chain/bnb.ts`); native balances,
`balanceOf` reads and BNB deposit checks use BNB Chain's free public RPC (`BNB_RPC_URL`, default
`https://bsc-dataseed.bnbchain.org`). Etherscan's **free** plan refuses chain 56 ("Free API access is
not supported for this chain"), so with a free key BNB lookups report exactly that, as a provider
error -- never as an empty wallet. A plan that covers BNB makes them work with no code change.

**Robinhood Chain** (EVM chain id 4663) needs no key: it's read through the same Blockscout provider
as Ethereum, pointed at the chain's own official instance (`ROBINHOOD_BLOCKSCOUT_URL`, default
`https://robinhoodchain.blockscout.com`), and its deposits are checked over its own public RPC
(`ROBINHOOD_RPC_URL`, default `https://rpc.mainnet.chain.robinhood.com`). Its gas token is ETH, so
its rows are stored under chain `robinhood` and its tokens priced under DefiLlama's `robinhood:`
key -- never as Ethereum mainnet's. Caveat, checked 2026-10-23: that instance's `/api/v2` answered
every scripted (non-browser) request with a Cloudflare challenge (HTTP 403, `cf-mitigated:
challenge`), while eth.blockscout.com didn't. Lookups then report "blockscout-robinhood returned HTTP
403" as the provider error -- never an empty wallet -- until it lifts or the URL points elsewhere.
Deposit checks don't depend on it (they use the RPC).

**`DEV_SKIP_AUTH=1`**: local dev only, treats every request as signed in as a fixed fake user
(no wallet, no cookie needed) so every feature can be driven without going through the real
Phantom/MetaMask flow. Refused outright when `NODE_ENV=production`, so it can never activate on a
deployed instance regardless of what env var is set there. Unset it (or set to `0`) to go back to
testing the real wallet-connect flow.

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
