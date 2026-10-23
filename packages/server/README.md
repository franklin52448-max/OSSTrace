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

**BNB Chain needs an Alchemy RPC URL.** There's no free hosted indexer for BNB Smart Chain the way
Blockscout is for Ethereum (Etherscan's V2 API refuses chain 56 on its free plan), so its history,
native balance and token balances come from Alchemy's enhanced JSON-RPC methods
(`alchemy_getAssetTransfers`, `alchemy_getTokenBalances`, `alchemy_getTokenMetadata`;
`src/chain/alchemy.ts`) on `BNB_RPC_URL` -- the same URL BNB deposit checks use for plain `eth_*`
calls. The default (`https://bsc-dataseed.bnbchain.org`, no key) is enough for deposit checks; with
it, BNB address lookups report that `BNB_RPC_URL` needs to be an Alchemy URL, as a provider error --
never as an empty wallet. The provider checks `eth_chainId` is 56 before reading anything.

**Robinhood Chain** (EVM chain id 4663) and **Base** (8453) are read the same way as BNB: through
`src/chain/alchemy.ts` on their own RPC URLs (`ROBINHOOD_RPC_URL`, `BASE_RPC_URL`), which need to be
Alchemy URLs for address lookups. Their own Blockscout instances (robinhoodchain.blockscout.com,
base.blockscout.com) answered every scripted request with a Cloudflare challenge (HTTP 403,
`cf-mitigated: challenge`, checked 2026-10-23), and Etherscan's free plan refuses Base. The keyless
defaults (`https://rpc.mainnet.chain.robinhood.com`, `https://mainnet.base.org`) are enough for
deposit checks, which use plain `eth_*` calls and are pinned to each chain's id. Gas on both is ETH,
so their rows are stored under chains `robinhood` / `base` and their tokens priced under DefiLlama's
`robinhood:` / `base:` keys -- never as Ethereum mainnet's. Alchemy serves internal (trace)
transfers on Base only, so Robinhood Chain's (and BNB's) history covers top-level native transfers
and token transfers, not native value moved by internal calls.

**Arbitrum One** (42161), **OP Mainnet** (10), **Zora** (7777777), **Lens Chain** (232) and the
**Data Network** (1514; formerly Story, so its chain id here is `story` and its env vars `STORY_*`)
are read the same way again, on `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL`, `ZORA_RPC_URL`,
`LENS_RPC_URL` and `STORY_RPC_URL` (each also `*_RPC_URL_FILE`). Each defaults to the chain's own
public RPC (`https://arb1.arbitrum.io/rpc`, `https://mainnet.optimism.io`, `https://rpc.zora.energy`,
`https://rpc.lens.xyz`, `https://mainnet.datarpc.io`): enough for deposit checks; address lookups need
Alchemy URLs. Native currency is ETH on the first three, GHO on Lens Chain and DATA (formerly IP) on
the Data Network; DefiLlama prices their tokens under `arbitrum:`, `optimism:`, `zora:`, `lens:` and
`sty:`. Alchemy serves no internal transfers on any of the five. Two differences the provider handles
(checked against live Alchemy answers, 2026-10-23): on Zora, Lens Chain and the Data Network Alchemy
sends no block timestamps, so the provider reads each row's block time with batched
`eth_getBlockByNumber` calls (extra compute units per page on those three chains only); and Lens
Chain's L2BaseToken system contract (`0x...800a`) mirrors every native GHO movement as an ERC-20
Transfer log, which is dropped so native transfers aren't counted twice.

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
