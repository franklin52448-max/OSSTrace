# @opentrace/chain-solana

Implements `ChainAdapter` for Solana mainnet-beta.

## Data sources

Both balance and transaction history come from standard public Solana RPC methods
(`getBalance`, `getSignaturesForAddress`, `getParsedTransactions`) — **no API key needed at all**,
unlike Ethereum. Defaults to the public mainnet-beta RPC if `SOLANA_RPC_URL` isn't set; a private
RPC (Helius/Triton/QuickNode) is recommended for anything beyond light use, since public RPC rate
limits are easy to hit.

## How transactions are resolved

Transaction details for every signature are fetched in **one batched RPC call**
(`getParsedTransactions`, plural — confirmed by reading `@solana/web3.js`'s own source that it
sends a single `_rpcBatchRequest`, not N sequential ones). This used to be N individual
`getParsedTransaction` calls, one per signature — see `SCALING-AND-COSTS.md` (local only) for why
that was the single biggest cost/latency problem in the whole project before this fix.

For each transaction returned, this adapter:
1. Tries to find a decoded native SOL `system` transfer instruction (top-level or inner)
   involving the queried address, and reports its real `source`/`destination`/`lamports`.
2. If the transaction isn't a plain native transfer (an SPL token transfer, a program
   interaction, a swap, etc.), it falls back to the queried address's own net balance change
   (`postBalance - preBalance`) for that transaction — reported honestly as `from: "unresolved
   (non-transfer instruction)"` when we can't name the actual counterparty, rather than
   guessing one.

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

- SPL token transfers aren't decoded into their own transfer records yet — they currently show up
  via the balance-delta fallback (which reports the *native SOL* fee/balance change for that tx,
  not the token amount moved). Decoding SPL Token `transfer`/`transferChecked` instructions the
  same way the native-transfer path works is the natural next addition.
- Even batched, a large `limit` is still one RPC call doing more work — fine at the small limits
  the Explorer uses today, but not something to raise arbitrarily high against a public RPC
  without a private endpoint.

## Testing

`npm test` runs real tests against a live public RPC (skips cleanly if unreachable): the native
System Program's own address, which is guaranteed to have both a real balance and a long real
transaction history on any live cluster, so the test never depends on one specific wallet still
being active.
