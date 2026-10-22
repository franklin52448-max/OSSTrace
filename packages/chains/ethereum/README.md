# @osstrace/chain-ethereum

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

`TransactionSummary` (in `@osstrace/core`) has an optional `tokenTransfers: TokenTransfer[]`.
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
  relative to the queried address. If `tokenDecimal` is missing, not an integer, or above 255
  (ERC-20's `decimals()` is a uint8), `decimals` and `amount` are `null` and only `rawAmount` is
  reported — never a guessed 18. The upper bound matters: a spam token can report any value, and
  scaling by 10^(millions) used to block the process for minutes.

Note: `tokentx`'s `from`/`to` are the **Transfer event's** from/to, not the transaction's sender —
Etherscan's own field description says otherwise, so this was checked against a real receipt
(the docs' own example transaction: the tx was sent by `0x4e83…`, the MKR Transfer was from
`0x642a…` to `0x4e83…`, matching the row's `from`/`to`). `tests/tokentx.live.test.ts` re-checks it.

**Completeness at page boundaries:** if either page came back full (`limit` rows), anything older
than that page's oldest block might be on page 2, so merged entries older than the newer of the two
cut-off blocks are dropped instead of being shown next to a hidden gap. A result can therefore hold
fewer than `limit` transactions even when more history exists. Those dropped entries aren't lost:
the result's `nextCursor` sits above them, so the next page starts with them.

## Paging (`nextCursor` / `before`, ADR 0018)

When there may be older history, the result carries `nextCursor`. Pass it back as
`getRecentTransactions(address, limit, { before })` for the next-older page. The cursor is
`block:txIndex:nativeSeen:tokenSeen` (opaque to callers), built on Etherscan's own block range,
not `page=2`. The next page is fetched with `endblock` = the cursor's block (inclusive, so the
rest of that block isn't skipped), and entries at or after the cursor's position are filtered back
out. `nativeSeen`/`tokenSeen` count the rows of that block the caller has already been shown. The
next fetch asks for `limit + seen` rows of each list, so those re-fetched rows can't use up the
page. Without that, an address with `limit` or more entries in one block would page into the same
block forever.

`page=2` would be wrong here because the two lists are merged and trimmed to `limit`. Page 2 of
`txlist` and page 2 of `tokentx` don't line up with each other, or with what the caller was
shown, so entries would be skipped or repeated.

A full page can only say "there may be more" (Etherscan doesn't say whether a full window was the
last one), so the page after the true end can come back empty with no `nextCursor`. A cursor this
adapter didn't produce is `available: false`. So is a block holding more of one address's rows
than Etherscan returns in one query (10,000).

## Known limitations (real, disclosed — not hidden)

- Only ERC-20 (`tokentx`) is decoded — ERC-721 (`tokennfttx`) and ERC-1155 (`token1155tx`)
  transfers aren't fetched yet.
- A transaction sitting exactly in the cut-off block of a full `tokentx` page can still have a
  further transfer on the next page, which won't appear in its `tokenTransfers`. Paging treats
  that transaction as already shown, so the next page doesn't add the missing transfer either.
- `txlist` only covers "normal" transactions; internal transactions (contract-to-contract calls,
  `txlistinternal`) aren't included yet — so a token-only entry's `valueNative: "0"` doesn't account
  for ETH that moved via an internal call in the same transaction.
- A failed (reverted) transaction is still listed, with `status: "failed"` (from Etherscan's
  `isError: "1"`) and a `valueNative` that is the value it *tried* to send. A failed tx moves no
  ETH and emits no Transfer events, so consumers must check `status` before treating
  `valueNative` as moved. Token-only entries are always `status: "success"`, because Transfer
  events only exist on successful transactions.
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
- `tests/paging.test.ts` — cursor paging over the recorded Universal Router rows at every page
  size from 1 to 10, so page boundaries land inside a busy block: the concatenated pages must
  equal the full history in order, with no overlap and no gap. Also runs the real adapter against
  a local server answering `txlist`/`tokentx` from those rows the way Etherscan documents
  `endblock`/`offset`/`sort`. With `ETHERSCAN_API_KEY` set, it also checks page 2 of a real
  address against real Etherscan.
- `tests/tokentx.live.test.ts` — re-checks every recorded token row against the live chain (the
  receipt must contain a matching ERC-20 Transfer log; `decimals()` must match), checks that an
  invalid Etherscan key surfaces Etherscan's real error reason, and — only when
  `ETHERSCAN_API_KEY` is set — runs a real merged `txlist` + `tokentx` lookup. Each skips (not
  fails) when its endpoint is unreachable or the key isn't set.
