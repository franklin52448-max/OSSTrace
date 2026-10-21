# @opentrace/chain-ethereum

Implements `ChainAdapter` for Ethereum mainnet.

## Data sources

- **Balance** — raw JSON-RPC `eth_getBalance` against any standard endpoint. No API key needed.
  Defaults to a public endpoint if `ETH_RPC_URL` isn't set (see root `.env.example`).
- **Transaction history** — the Etherscan v2 API: `txlist` (native ETH transactions) and
  `tokentx` (ERC-20 token transfers), called in parallel. Ethereum JSON-RPC has no "transactions
  by address" call — that needs an indexer, and Etherscan's is the free, public one. Needs
  `ETHERSCAN_API_KEY` (free, from [etherscan.io/apis](https://etherscan.io/apis)). Without it,
  `getRecentTransactions` returns `{ available: false, reason: "..." }` — it does not fall back to
  a partial or fake answer. If either of the two calls fails, the whole result is unavailable
  (with Etherscan's own error text, e.g. `Etherscan tokentx: Missing/Invalid API Key`) rather than
  native history with the token side silently missing.

**Call volume:** 2 Etherscan calls per uncached lookup (was 1 before ERC-20 decoding). The free
tier's per-second rate limit is shared across both.

## How ERC-20 transfers are reported

`TransactionSummary` (in `@opentrace/core`) has an optional `tokenTransfers: TokenTransfer[]`.
Decoding and merging live in `src/etherscan.ts` (pure, no network) and work like this:

- **One entry per transaction hash.** `txlist` and `tokentx` are each fetched newest-first with
  `offset = limit`, merged by hash, sorted by block then transaction index, and cut to `limit`.
- **Hash in both lists** → the native summary exactly as before (`from`/`to` = the transaction's
  sender/recipient, `valueNative` = ETH sent), plus `tokenTransfers` for every ERC-20 transfer in
  it involving the address.
- **Hash only in `txlist`** → exactly the old shape; the `tokenTransfers` key is absent, so
  native-only consumers see nothing new.
- **Hash only in `tokentx`** (e.g. someone sent this address USDC: the address neither sent the
  transaction nor was its `to`) → `valueNative: "0"`, and the top-level `from`/`to`/`direction`
  mirror the **first** token transfer involving the address, because `tokentx` doesn't carry the
  transaction's own sender. Read `tokenTransfers` for the full picture.
- **Each `TokenTransfer`** carries the token contract, Etherscan's `tokenSymbol`/`tokenName`, the
  token's real `decimals` (Etherscan's `tokenDecimal`, read from the contract), the exact integer
  `rawAmount`, the scaled decimal `amount`, the transfer's own `from`/`to`, and a `direction`
  relative to the queried address. If `tokenDecimal` is missing or not an integer, `decimals` and
  `amount` are `null` and only `rawAmount` is reported — never a guessed 18.

Note: `tokentx`'s `from`/`to` are the **Transfer event's** from/to, not the transaction's sender —
Etherscan's own field description says otherwise, so this was checked against a real receipt
(the docs' own example transaction: the tx was sent by `0x4e83…`, the MKR Transfer was from
`0x642a…` to `0x4e83…`, matching the row's `from`/`to`). `tests/tokentx.live.test.ts` re-checks it.

**Completeness at page boundaries:** if either page came back full (`limit` rows), anything older
than that page's oldest block might be on page 2, so merged entries older than the newer of the two
cut-off blocks are dropped instead of being shown next to a hidden gap. A result can therefore hold
fewer than `limit` transactions even when more history exists.

## Known limitations (real, disclosed — not hidden)

- Only ERC-20 (`tokentx`) is decoded — ERC-721 (`tokennfttx`) and ERC-1155 (`token1155tx`)
  transfers aren't fetched yet.
- A transaction sitting exactly in the cut-off block of a full `tokentx` page can still have a
  further transfer on the next page, which won't appear in its `tokenTransfers`.
- `txlist` only covers "normal" transactions; internal transactions (contract-to-contract calls,
  `txlistinternal`) aren't included yet — so a token-only entry's `valueNative: "0"` doesn't account
  for ETH that moved via an internal call in the same transaction.
- `isError` isn't consulted: a failed transaction's `valueNative` is still the value it *tried* to
  send (Etherscan lists failed txs; a failed tx moves no ETH and emits no Transfer events).
- No contract-interaction detail (ABI decoding) — a transaction to a contract shows as a plain
  value transfer with the contract's address as `to`.
- Token symbols/names are whatever Etherscan reports (taken from the token contract) — they aren't
  a trust signal; anyone can deploy a token called "USDC".

## Testing

`npm test` runs real tests, no mocked network layer:

- `tests/adapter.test.ts` — a live `eth_getBalance` call against a public RPC, plus a check that
  `getRecentTransactions` reports itself unavailable with no API key.
- `tests/etherscan.test.ts` — offline unit tests of decoding/merging against recorded real
  mainnet rows in `tests/fixtures/` (Etherscan's own documented `tokentx` example, and two real
  blocks of Uniswap Universal Router activity read from a public RPC; each fixture's `_provenance`
  says exactly where it came from).
- `tests/tokentx.live.test.ts` — re-checks every recorded token row against the live chain (the
  receipt must contain a matching ERC-20 Transfer log; `decimals()` must match), checks that an
  invalid Etherscan key surfaces Etherscan's real error reason, and — only when
  `ETHERSCAN_API_KEY` is set — runs a real merged `txlist` + `tokentx` lookup. Each skips (not
  fails) when its endpoint is unreachable or the key isn't set.
