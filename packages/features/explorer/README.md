# @opentrace/explorer

The first feature: given a chain + address, returns its balance, recent transactions, and any
label/tags/entity on record. Every later feature (Visualizer, Tracer, Risk Scoring) builds on this
same data layer.

## Running it

```sh
npm run dev --workspace packages/features/explorer
# or, from the repo root:
npm run dev:explorer
```

Reads `.env` from the repo root (`ETH_RPC_URL`, `ETHERSCAN_API_KEY`, `SOLANA_RPC_URL`, `PORT`) —
see the root `.env.example`. Listens on `PORT` (default 5300, this project's assigned port block).

## API

`GET /address/:chain/:address` — `chain` is `ethereum` or `solana`.

```
curl http://localhost:5300/address/ethereum/0x252a8bd2319d8a555b872990601221b3a2053bce
```

Returns an `AddressReport`:

```json
{
  "address": { "chain": "ethereum", "value": "0x..." },
  "balance": { "chain": "ethereum", "address": "0x...", "native": { "symbol": "ETH", "amount": "1.5", "decimals": 18 }, "asOf": "..." },
  "transactions": { "available": true, "transactions": [ { "hash": "...", "...": "..." } ] },
  "label": null,
  "tags": [],
  "entity": null
}
```

`transactions` is `{ "available": false, "reason": "..." }` instead of an empty list when the
underlying chain adapter couldn't fetch history (e.g. no `ETHERSCAN_API_KEY`) — see
`packages/chains/README.md`.

`GET /health` — `{ "ok": true }`.

## What's not built here yet

- No pagination beyond a `?limit=` query param on transactions.
- No caching — every request hits the chain adapter live. Fine for a lookup tool at this scale;
  would need a cache layer before any real production traffic.
- CORS is wide open (`*`) — correct for a local dev tool talking to a local web UI, wrong for any
  public deployment. Flagging this explicitly so it isn't carried forward by accident.

## Testing

`npm test` runs `lookup.test.ts` against a real temp-file-backed `JsonFileLabelStore` and a small
concrete `ChainAdapter` stand-in (not a mocking framework) — verifies the orchestration logic
itself, independent of any real network call (the chain adapters' own real-network tests live in
their own packages).
