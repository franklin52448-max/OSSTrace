# @opentrace/chain-solana

Implements `ChainAdapter` for Solana mainnet-beta.

## Data sources

Both balance and transaction history come from standard public Solana RPC methods
(`getBalance`, `getSignaturesForAddress`, `getParsedTransaction`) — **no API key needed at all**,
unlike Ethereum. Defaults to the public mainnet-beta RPC if `SOLANA_RPC_URL` isn't set; a private
RPC (Helius/Triton/QuickNode) is recommended for anything beyond light use, since public RPC rate
limits are easy to hit.

## How transactions are resolved

For each signature, this adapter:
1. Tries to find a decoded native SOL `system` transfer instruction (top-level or inner)
   involving the queried address, and reports its real `source`/`destination`/`lamports`.
2. If the transaction isn't a plain native transfer (an SPL token transfer, a program
   interaction, a swap, etc.), it falls back to the queried address's own net balance change
   (`postBalance - preBalance`) for that transaction — reported honestly as `from: "unresolved
   (non-transfer instruction)"` when we can't name the actual counterparty, rather than
   guessing one.

## Known limitations (real, disclosed — not hidden)

- SPL token transfers aren't decoded into their own transfer records yet — they currently show up
  via the balance-delta fallback (which reports the *native SOL* fee/balance change for that tx,
  not the token amount moved). Decoding SPL Token `transfer`/`transferChecked` instructions the
  same way the native-transfer path works is the natural next addition.
- One `getParsedTransaction` RPC call per signature — fine at the small limits the Explorer uses
  today, but not something to raise to a large `limit` against a public RPC without a private
  endpoint.

## Testing

`npm test` runs real tests against a live public RPC (skips cleanly if unreachable): the native
System Program's own address, which is guaranteed to have both a real balance and a long real
transaction history on any live cluster, so the test never depends on one specific wallet still
being active.
