# @opentrace/chain-ethereum

Implements `ChainAdapter` for Ethereum mainnet.

## Data sources

- **Balance** — raw JSON-RPC `eth_getBalance` against any standard endpoint. No API key needed.
  Defaults to a public endpoint if `ETH_RPC_URL` isn't set (see root `.env.example`).
- **Transaction history** — the Etherscan v2 API (`txlist`). Ethereum JSON-RPC has no
  "transactions by address" call — that needs an indexer, and Etherscan's is the free, public one.
  Needs `ETHERSCAN_API_KEY` (free, from [etherscan.io/apis](https://etherscan.io/apis)). Without
  it, `getRecentTransactions` returns `{ available: false, reason: "..." }` — it does not fall
  back to a partial or fake answer.

## Known limitations (real, disclosed — not hidden)

- Only native ETH transfers are reported by `getRecentTransactions` right now — ERC-20 token
  transfers aren't decoded yet (Etherscan's `tokentx` action would be the next endpoint to add;
  same package, new method on the adapter or a parallel call).
- `txlist` only covers "normal" transactions; internal transactions (contract-to-contract calls)
  aren't included yet.
- No contract-interaction detail (ABI decoding) — a transaction to a contract shows as a plain
  value transfer with the contract's address as `to`.

## Testing

`npm test` runs real tests: a live `eth_getBalance` call against a public RPC (skips cleanly if
unreachable, doesn't fail the suite) plus a unit test confirming `getRecentTransactions` correctly
reports itself unavailable with no API key, rather than silently returning nothing.
