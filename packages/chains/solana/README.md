# @osstrace/chain-solana

Implements `ChainAdapter` for Solana mainnet-beta.

## Data sources

Both balance and transaction history come from standard public Solana RPC methods
(`getBalance`, `getSignaturesForAddress`, `getParsedTransactions`) — **no API key needed at all**,
unlike Ethereum. Defaults to the public mainnet-beta RPC if `SOLANA_RPC_URL` isn't set; a private
RPC (Helius/Triton/QuickNode) is recommended for anything beyond light use, since public RPC rate
limits are easy to hit.

If the RPC fails or refuses the history calls (most often a 429 rate limit from the public
endpoint, after web3.js's own retries), `getRecentTransactions` returns `{ available: false,
reason: "Solana RPC: ..." }` per the `ChainAdapter` contract, rather than throwing — so the
Explorer still returns the balance and labels, with history marked unavailable. (Before, the
error propagated and the whole lookup failed with a 502.)

## How transactions are resolved

Transaction details for every signature are fetched in **one batched RPC call**
(`getParsedTransactions`, plural — confirmed by reading `@solana/web3.js`'s own source that it
sends a single `_rpcBatchRequest`, not N sequential ones). This used to be N individual
`getParsedTransaction` calls, one per signature — see `SCALING-AND-COSTS.md` (local only) for why
that was the single biggest cost/latency problem in the whole project before this fix.

For each transaction returned, this adapter fills the top-level (native SOL) fields exactly as
before:
1. Tries to find a decoded native SOL `system` transfer instruction (top-level or inner)
   involving the queried address, and reports its real `source`/`destination`/`lamports`.
2. If the transaction isn't a plain native transfer (an SPL token transfer, a program
   interaction, a swap, etc.), it falls back to the queried address's own net balance change
   (`postBalance - preBalance`) for that transaction — reported honestly as `from: "unresolved
   (non-transfer instruction)"` when we can't name the actual counterparty, rather than
   guessing one.

…and then, separately, decodes SPL token movements into `tokenTransfers` (see below). The two
never mix: top-level `valueNative` is always SOL, token amounts only ever appear in
`tokenTransfers`.

## How SPL token transfers are decoded

`src/splToken.ts` (pure, no RPC calls of its own) reads the RPC's own `jsonParsed` decoding of
every SPL Token **and Token-2022** `transfer` / `transferChecked` instruction, top-level and inner,
in execution order, and keeps the ones whose source or destination — the token account itself,
or that account's owner — is the queried address. Each becomes a `TokenTransfer` (type in
`@osstrace/core`) with:

- `token` — the mint. `transferChecked` states it; a plain `transfer` doesn't, so it comes from
  the transaction's own `pre/postTokenBalances` for the accounts involved.
- `decimals` / `amount` — `transferChecked`'s own decimals, or the token-balance entry's for a plain
  `transfer`. `rawAmount` is always the exact integer from the instruction; `amount` is it scaled
  by the real decimals, and `null` if decimals couldn't be resolved.
- `from` / `to` — the **owners** of the source/destination token accounts (what a person means by
  "who sent this"), from `pre/postTokenBalances`, or from an `initializeAccount*` instruction in
  the same transaction — that's how temporary accounts (e.g. a WSOL account opened and closed
  inside one swap, absent from both balance lists) still get their real owner. `null` if neither
  source names an owner. `fromTokenAccount` / `toTokenAccount` are the token accounts themselves.
- `direction` — relative to the queried address (`self` when it's on both sides).
- `symbol` / `name` — always `null`: SPL mints carry no on-chain symbol/name (that's in separate
  Metaplex/Token-2022 metadata accounts this adapter doesn't fetch), so they're honestly unknown.

`tokenTransfers` is absent (not `[]`) when nothing was decoded, so native-only consumers see
exactly the old shape. No extra RPC calls: everything comes from the same batched
`getParsedTransactions` response.

`maxSupportedTransactionVersion` is set generously high (255) rather than the more "obvious" 0 —
a live test caught a real transaction using a newer version format that `0` rejected, and
`getParsedTransactions` fails its *entire* batch if even one transaction in it exceeds the cap.

## Why `@solana/web3.js` v1.x, not v3/Kit

Deliberate choice, same reasoning as this machine's `solana-reclaimer` project: v3 is a thin
legacy bridge over `@solana/kit`'s different (functional, no classes) paradigm, with sparser
real-world examples. v1.x is still fully functional against mainnet RPC. Known tradeoff: `npm
audit` flags a moderate-severity transitive issue in v1.x's `jayson`/`stream-json` dependency
chain, fixed only by the v3 upgrade. Accepted for now — re-evaluate if `@solana/kit` matures, or
if a non-breaking patch lands upstream.

## Known limitations (real, disclosed — not hidden)

- Only `transfer` / `transferChecked` are decoded as token movements. `mintTo`/`burn` (and their
  `Checked` variants) and token movements done by programs that don't go through the SPL Token
  program's transfer instructions aren't reported in `tokenTransfers`; the native balance-delta
  fallback still covers the SOL side of those transactions.
- Incoming token transfers to a wallet are only seen if `getSignaturesForAddress(wallet)` returns
  the transaction — i.e. the wallet itself is one of the transaction's accounts. A plain transfer
  into a wallet's existing associated token account often doesn't list the wallet at all; querying
  the token account's own address does find it.
- The native top-level fields report only the *first* system transfer involving the address (in
  top-level-then-inner order), as before — a transaction with several native transfers isn't
  itemized.
- Token symbols/names aren't resolved (see above).
- Even batched, a large `limit` is still one RPC call doing more work — fine at the small limits
  the Explorer uses today, but not something to raise arbitrarily high against a public RPC
  without a private endpoint. The public mainnet-beta endpoint rate-limits batched
  `getTransaction` calls readily (HTTP 429), and some other public RPCs (e.g. publicnode) cap a
  batch at **one** `getTransaction`, so `limit > 1` fails there outright.

## Testing

`npm test` runs real tests; none mock the network layer:

- `tests/adapter.test.ts` — live balance + history calls for the native System Program's own
  address, which is guaranteed to have both a real balance and a long real transaction history on
  any live cluster.
- `tests/splToken.test.ts` — offline unit tests of SPL decoding against two real mainnet
  transactions saved verbatim as raw `getTransaction` (`jsonParsed`) responses in
  `tests/fixtures/` (a Raydium v4 swap using plain `transfer` incl. a temporary WSOL account, and a
  Jupiter route using `transferChecked` incl. a Token-2022 mint), with amounts reconciled against
  the transactions' own token-balance changes; plus live tests that re-fetch both transactions from
  the chain and check they decode identically, and a live `getRecentTransactions` run against
  Raydium's AMM authority.

Every live test skips (not fails) if the RPC is unreachable, rate-limits it (429), or rejects
the batch size; set `SOLANA_RPC_URL` to a private endpoint to run them all reliably.
