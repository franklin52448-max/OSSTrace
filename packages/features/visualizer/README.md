# @osstrace/visualizer

Given a chain and an address, returns its recent transactions as a graph. The queried address is
the center node, each distinct counterparty is its own node, and each real transfer is an edge
with its real direction, amount and tx hash. Nodes carry any label, tags or entity the label store
has for them. The web UI (`packages/web`, the **Graph** tab) draws this as an interactive graph.

**v1 is one hop only.** You get the queried address and its direct counterparties, and nothing
beyond them. The API never invents deeper hops. In the UI you can click a counterparty and press
"Graph this address". That runs a new one-hop query centered on the counterparty; it does not
merge the two graphs. Multi-hop expansion is listed under "What's not built yet" below.

## Running it

```sh
npm run dev --workspace packages/features/visualizer
# or, from the repo root:
npm run dev:visualizer
```

It reads the root `.env` the same way Explorer does (`ETH_RPC_URL`, `ETHERSCAN_API_KEY`,
`SOLANA_RPC_URL`). It listens on `VISUALIZER_PORT`, default **5302**. That is a separate variable
from `PORT`, because `PORT` belongs to the Explorer API and the two run side by side.

The web UI calls it at `VITE_VISUALIZER_URL` (default `http://localhost:5302`).

## How it plugs in

- **Chain data:** `ChainAdapter.getRecentTransactions` from `@osstrace/core`. This is exactly one
  call per request. No new chain-level work was needed.
- **Chain wiring and labels:** reused from Explorer's `bootstrap.ts`
  (`buildRegistryFromEnv`, `buildLabelStore`, `loadRootEnv`) instead of a second copy. This
  breaks the "don't reach into another feature's internals" suggestion in
  `FEATURE_GUIDELINES.md`, and it does so on purpose. A copy would mean a new chain or label file
  has to be registered in two places, and they would drift. The right long-term fix is to move
  `registry.ts` and `bootstrap.ts` into a shared package. That wasn't done here because it
  rewrites Explorer while other branches are changing it, so it's left as a follow-up.
- **The only chain-aware code here** is the address-shape check, which now lives in
  `@osstrace/core` (`packages/core/src/addressFormat.ts`, re-exported by this package's
  `src/addressFormat.ts`) because community label submissions need the same check. Ethereum
  addresses are lowercased so a checksummed and a lowercase form become one node. There is also an
  "is this a real address for this chain" check (see below). A third chain needs one line there.

## API

`GET /graph/:chain/:address?limit=N`. `chain` is `ethereum` or `solana`. `limit` is the number of
recent transactions to graph: default 25, capped at 100.

```
curl "http://localhost:5302/graph/solana/9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?limit=5"
```

Real response, captured 2026-10-21 against the public Solana mainnet RPC:

```json
{
  "center": { "chain": "solana", "value": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
  "hops": 1,
  "transactions": { "available": true, "fetched": 5 },
  "nodes": [
    {
      "id": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "address": { "chain": "solana", "value": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
      "role": "center",
      "label": null,
      "tags": [],
      "entity": null,
      "stats": { "txCount": 1, "inCount": 1, "outCount": 0, "totalIn": "0.000001", "totalOut": "0" }
    },
    {
      "id": "FKtPu64vAyaHNvLDTh1j8TdAm4za4UJGPZTMZNAJB5Um",
      "address": { "chain": "solana", "value": "FKtPu64vAyaHNvLDTh1j8TdAm4za4UJGPZTMZNAJB5Um" },
      "role": "counterparty",
      "label": null,
      "tags": [],
      "entity": null,
      "stats": { "txCount": 1, "inCount": 0, "outCount": 1, "totalIn": "0", "totalOut": "0.000001" }
    }
  ],
  "edges": [
    {
      "id": "59hMmCAnujZRavmgAhrNEy5zCV1eNzs8S6sDUrZc9DCM8gtFMuLmWteFG8KbuPBTnS9rpbAhJgJ4wuXo5or6qJy6",
      "hash": "59hMmCAnujZRavmgAhrNEy5zCV1eNzs8S6sDUrZc9DCM8gtFMuLmWteFG8KbuPBTnS9rpbAhJgJ4wuXo5or6qJy6",
      "source": "FKtPu64vAyaHNvLDTh1j8TdAm4za4UJGPZTMZNAJB5Um",
      "target": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "direction": "in",
      "valueNative": "0.000001",
      "timestamp": "2026-10-20T23:01:36.000Z"
    }
  ],
  "omitted": [
    { "hash": "5kCU1Kd1msHK…", "timestamp": "2026-10-21T18:07:37.000Z", "direction": "self", "valueNative": "0", "reason": "counterparty-unresolved" },
    { "hash": "29QfKryFew8V…", "timestamp": "2026-10-21T17:19:53.000Z", "direction": "self", "valueNative": "0", "reason": "counterparty-unresolved" },
    { "hash": "3FRg4eFaPWZn…", "timestamp": "2026-10-21T11:50:40.000Z", "direction": "self", "valueNative": "0", "reason": "counterparty-unresolved" },
    { "hash": "4gEpoDVqmxdW…", "timestamp": "2026-10-20T23:41:37.000Z", "direction": "out", "valueNative": "0.000005334", "reason": "no-counterparty" }
  ]
}
```

(The `omitted` hashes are shortened here for width. The API returns them in full.) The one edge
was checked by hand against a separate, non-batched `getParsedTransaction` call for that
signature: a system transfer of 1000 lamports from `FKtPu64v…` to the queried address, at
2026-10-20T23:01:36Z.

### Fields

- `nodes`: the center is always first, then counterparties by edge count (highest first). The
  center is present even when history is unavailable, so its label and tags still show.
  - `id`: the canonical address. `edges[].source` and `edges[].target` refer to it.
  - `label`, `tags`, `entity`: straight from the `LabelStore`, with their `source` citations.
    `null` or `[]` means nothing is on record.
  - `stats`: counts and exact decimal-string totals (summed with BigInt, not floats). They cover
    **only the edges in this response**, not the address's full history.
- `edges`: one per drawable transfer. `source → target` is the real on-chain direction.
  `direction` is relative to the center (`in` means counterparty → center). `id` is the tx hash.
  It gets a `#n` suffix only if a hash repeats.
- `omitted`: real fetched transactions that can't be drawn as an edge between two distinct real
  addresses. They're listed here so they don't vanish silently, and they never become a made-up
  node.
  - `self-transfer`: from and to are both the queried address.
  - `no-counterparty`: the adapter reported `to: null`. Examples are an Ethereum contract creation,
    or a Solana net outflow that couldn't be tied to a recipient.
  - `counterparty-unresolved`: the adapter couldn't name the counterparty. Examples are the
    Solana adapter's `"unresolved (non-transfer instruction)"` / `"unknown"` fallbacks for
    token transfers, program calls and similar.
  - `failed`: the chain adapter reports `status: "failed"` — the transaction reverted on-chain.
    Checked first, before either resolution attempt, so a failed transaction is never drawn as an
    edge even if its instructions would otherwise decode as a transfer: a real example is a failed
    Jupiter-aggregator swap on Solana, where the instruction data describes a transfer that never
    actually happened. `valueNative`/`tokenTransfers` on the underlying tx describe the attempt,
    not a real movement.
- `transactions`: `{ "available": false, "reason": "..." }` when the chain adapter couldn't fetch
  history, for example when no `ETHERSCAN_API_KEY` is set. In that case `nodes` is just the
  center, and `edges` and `omitted` are empty.

Errors: `400` for an unsupported chain or a value that isn't a valid address for that chain.
`502` (`{ "error": "..." }`) when the adapter throws, for example when the public RPC
rate-limits the request.

`GET /health` returns `{ "ok": true }`.

## Cost per request

There is one `getRecentTransactions` call. On Ethereum that is one Etherscan request. On Solana it
is one `getSignaturesForAddress` call plus one JSON-RPC batch of `limit` `getTransaction` calls.
Label lookups for every node read the local label file and make no network calls. Building the
graph never makes a chain call per counterparty. That's what keeps v1 at one hop and cheap.

**The public Solana RPC rate-limits that batch hard.** In testing,
`api.mainnet-beta.solana.com` often returned `429` at `limit=10` or `25` and usually let `limit=5`
through. `solana-rpc.publicnode.com` refuses batches larger than 1 outright. For real use, set
`SOLANA_RPC_URL` to a private RPC. The web UI defaults to the last 10 transactions and has a
selector (5 / 10 / 25 / 50) for this reason.

## What's not built yet

- **No multi-hop expansion.** "Graph this address" re-centers on a counterparty. It does not
  merge that graph into the current one. A real expanding graph, where you click a node and its
  counterparties are added in place, needs a merge model, a hop limit, and a per-click call budget.
  It's the natural next step and the base of the Tracer.
- **Decoded ERC-20 and SPL token transfers are drawn as their own edges** (`kind: "token"`),
  alongside a transaction's native-currency edge when both exist. A transaction only lands in
  `omitted` when the chain adapter couldn't decode a native transfer *or* any token transfer from
  it — e.g. a DeFi/program interaction neither decoder recognizes yet. Not every "unresolved"
  address is doing something suspicious; a lot of real on-chain activity (swaps, staking, PDAs)
  just isn't a plain transfer of anything. A transaction that reverted on-chain is its own
  `omitted` reason (`"failed"`, see above) — it's never lumped in with "unresolved", since a
  failed transaction didn't fail to *decode*, it failed to *happen*.
- **No caching.** Explorer caches lookups and Visualizer doesn't yet. Each request reaches the
  chain adapter.
- **No pagination or time window.** You get only "the most recent `limit` transactions".
- **CORS is wide open (`*`)**. That's fine for a local tool and wrong for a public deployment.
  The Explorer now uses an origin allowlist (`EXPLORER_ALLOWED_ORIGINS`, see its README), and
  the same treatment would fit here.
- **Label/tag lookups are one store call per node.** That's fine for the local JSON file. A real
  database-backed store would want a batch lookup.

## Testing

`npm test` runs `tests/graph.test.ts`. It uses a small concrete `ChainAdapter` stand-in
(`FixedChainAdapter`, not a mocking framework) and a real temp-file `JsonFileLabelStore`. Known
transactions go in and a known graph comes out. The tests cover: correct direction and per-node
totals; Ethereum case-merging; Solana staying case-sensitive; self-transfers, contract creations
and the Solana adapter's unresolved fallbacks being omitted (never turned into nodes); labels and
tags appearing on both center and counterparty nodes; exactly one adapter call per graph; and
unavailable history returning only the labeled center node.
