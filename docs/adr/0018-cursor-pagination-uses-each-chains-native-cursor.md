# ADR 0018 — Transaction paging uses each chain's own cursor, behind one opaque `nextCursor`

Status: Decided 2026-10-22 (implemented in `packages/core`, `packages/chains/ethereum`,
`packages/chains/solana` and `packages/features/explorer`)

## Context

The Explorer could only ever return an address's most recent `?limit=` transactions (capped at
100). There was no way to look further back. That's a real gap for an investigation tool: the
interesting activity is often not the latest.

Neither chain's data source pages by a plain row offset that maps to what the caller saw:

- **Solana**: `getSignaturesForAddress` pages with `before: <signature>`. It returns only
  signatures older than the given one. That's a real, stable cursor.
- **Ethereum**: history comes from two Etherscan lists, `txlist` (native) and `tokentx`
  (ERC-20). The adapter merges them one entry per hash and trims to `limit`. When one list comes
  back full, it also drops entries older than that list's oldest block, so it never shows a page
  with a hidden gap. Etherscan has `page` + `offset`, but page 2 of `txlist` and page 2 of
  `tokentx` don't line up with each other or with the merged page the caller was shown. Paging
  with them would skip or repeat entries. Etherscan also has a block range
  (`startblock`/`endblock`), and that does map to a position in history.

## Decision

1. **One opaque cursor in the shared contract.** `TransactionsResult`'s available branch gets an
   optional `nextCursor: string`, set when there may be older history.
   `ChainAdapter.getRecentTransactions` gets an optional third argument `{ before?: string }`
   that takes it back. Each adapter builds and parses its own cursor; nothing outside the chain's
   folder reads one. With the argument omitted, every adapter makes exactly the request it made
   before.
2. **Solana: the signature itself.** `nextCursor` is the oldest signature on a full page
   (`limit` signatures). `before` is passed straight to `getSignaturesForAddress`. A shorter page
   is the end and has no cursor.
3. **Ethereum: a block position plus a "seen" count.** The cursor is
   `block:txIndex:nativeSeen:tokenSeen`, meaning everything strictly older than
   `(block, txIndex)`. The next page is fetched with Etherscan's own `endblock = block`
   (inclusive, so the rest of that block isn't skipped), and entries at or after the cursor are
   filtered back out. `nativeSeen`/`tokenSeen` count the rows of that block the caller has
   already seen. The next fetch asks for `limit + seen` rows of each list, so those re-fetched,
   filtered-out rows can't use up the page. Without this, an address with `limit` or more entries
   in one block (a busy router, which is exactly the recorded fixture) would page into the same
   block forever. Entries the cut-off rule dropped from a page are older than its `nextCursor`, so
   the next page starts with them. They're deferred, not lost.
4. **Explorer: `?before=`, additive.** `GET /address/:chain/:address?before=<nextCursor>`. Without
   it, the request, response and cache key are byte-for-byte what they were, so the background
   indexer's warm entry is unchanged. With it, `limit` + cursor is its own cache entry. The HTTP
   layer only rejects strings that can't be anyone's cursor (characters outside `[A-Za-z0-9:]`,
   or over 128 characters) with a `400`. Whether a well-formed cursor is valid for its chain is
   the adapter's call, and an invalid one is `available: false` with a reason, like any other
   "couldn't fetch".

## Consequences

- "There may be more" is the most either source can promise from a full page. Etherscan doesn't
  say whether a full window was the last one, and neither does Solana's RPC. So a page that was
  exactly full at the true end carries a `nextCursor` whose next page is empty with no cursor.
  Callers stop when `nextCursor` is absent, not when a page is short.
- Ethereum's existing known edge carries over. A transaction in the cut-off block of a full
  `tokentx` page can have a further transfer on the next Etherscan page. Paging treats that
  transaction as already shown, so the missing transfer still isn't added.
- Ethereum can't page past a single block holding more than 10,000 of one address's rows
  (Etherscan's `page × offset` ceiling). That's reported as `available: false`, never as an
  empty page.
- Paging is anchored on the cursor, not on "now". New activity arriving between page 1 and
  page 2 doesn't shift page 2. It shows up on the next request without `?before=`.
- The web UI doesn't page yet. That's a UI change for later; the API is ready for it.

## Alternatives considered

- **Numeric offsets (`?offset=50`).** They map to neither source. On Solana an offset would mean
  re-reading every earlier signature. On Ethereum it hits the same misalignment as `page=2`, and
  any offset shifts under the caller as new transactions arrive.
- **Etherscan `page=N` for Ethereum.** Rejected for the misalignment above. Page boundaries of the
  two lists don't match each other or the merged page.
- **Exposing a structured cursor (`{ block, txIndex }`) in the API.** That makes one chain's
  internals part of the public contract. An opaque string lets each adapter change its cursor
  without breaking callers.
