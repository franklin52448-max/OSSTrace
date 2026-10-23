# ADR 0020 — Bounty funding: a real on-chain deposit, verified by signature

Status: Decided 2026-10-22 (implemented in `packages/features/bounties/`)

## Context

ADR 0009 scoped the bounty board as tracking-only: `reward` is the opener's own free-text claim,
never a balance this project accounts for, and payout happens off-platform. That's still true.
This ADR adds one real capability on top of it: an opener (or anyone backing a bounty) can send
real SOL, ETH, an SPL token, or an ERC-20 token to a wallet this project controls, and have the
board show that deposit as **verified** — a real, checked fact, not a claim.

This is a genuine expansion of what this project touches: for the first time, a wallet it
controls receives real third-party funds. It does not become an escrow. The deposit sits in that
wallet exactly as a reward posted on a bulletin board would sit in a drawer — this system records
that it arrived and asserts nothing about when or whether it leaves. Payout is still manual, still
off-platform, still the operator's own responsibility. If that boundary needs to change (a real
escrow that only releases funds under code-enforced conditions), that's a separate, much larger
project — a real on-chain program on each chain, security-reviewed before it ever touches mainnet
funds — not something to fold into this board's v1.

## Decision

### 1. The receiving wallets are configuration, never generated or held by this codebase

`BOUNTIES_RECEIVING_WALLET_ETHEREUM` / `BOUNTIES_RECEIVING_WALLET_SOLANA` — public addresses only,
set once per deployment. This project never generates, stores, or has any access to the private
key behind either one. A chain with no wallet configured simply can't take deposits on it yet
(`not_configured`, not a crash, not a silent no-op).

### 2. Correlation is "your account says this tx funds this bounty," not the memo alone

The primary link between a deposit and a bounty is: a logged-in user, on a specific bounty's page,
submits the signature/hash of a transaction they just sent. The server then independently verifies
*that exact transaction* paid the configured wallet a real amount of a real asset. Solana goes
through real RPC (`SOLANA_RPC_URL`), no API key needed. Ethereum originally did too, but this
server was never configured with a dedicated Ethereum RPC URL at the time this ADR was written, so
verification went through Blockscout's REST API instead — a real, later addition of `ETH_RPC_URL`
(a dedicated Alchemy endpoint) changed this: Ethereum deposits are now verified via real RPC too
when that's configured, falling back to Blockscout automatically when it isn't (zero-config
self-hosting stays intact either way). See `packages/server/src/chain/deposits.ts`.

A memo is included when the chain makes that clean (Solana's Memo program), and recorded if
present, but it is **not** load-bearing for correlation. Reasons:

- Ethereum has no native memo field. A plain ETH transfer can carry one in `data` (an unused
  value-transfer's data field is otherwise idle), but an ERC-20 `transfer()` call's `data` *is*
  the function call — there's no room left for a memo without a second, nonstandard convention
  real wallets don't support. Making the memo required would mean ERC-20 deposits either can't
  carry one (silently breaking correlation) or need extra, wallet-unfriendly round-trips.
- The receiving wallet is shared across every bounty on that chain. Without the account-level
  claim, matching a deposit to a bounty would depend entirely on a human-typed string a user is
  free to mistype, omit, or paste wrong — exactly the kind of guess this project's "never invent a
  connection" rule exists to prevent elsewhere (ADR 0008 §4, the Tracer budget-exhausted distinction).

So: the memo is a visible, honest cross-check a moderator can glance at, never the source of truth.

### 3. What "verified" means, exactly — reusing real decode logic, not reinventing it

**Solana**: the existing `summarizeTransaction`/`decodeSplTransfers` in `@osstrace/chain-solana`
already answer "what did this real, parsed transaction do to this address" — for a native SOL
move (direct decode of a System Program transfer, falling back to pre/post balance delta) and for
SPL/Token-2022 transfers (owner-resolved, real decimals). Deposit verification calls these
directly against the configured wallet, rather than writing a second decoder. A `direction !== "in"`
summary means the wallet wasn't actually paid by that transaction — refused, not verified.

**Ethereum**: `eth_getTransactionReceipt` (status must be success — a reverted tx moved nothing)
plus `eth_getTransactionByHash` for a native transfer (`to`/`value`/`input`-as-memo), or the
receipt's own logs for an ERC-20 transfer — matched against the real `Transfer(address,address,uint256)`
event topic hash (`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`, keccak256 of
the event signature, a public, stable constant — not this project's own invention) whose `to` topic
is the configured wallet. The token's real decimals come from a live `eth_call` to that contract's
own `decimals()` (selector `0x313ce567`), never assumed.

### 4. Idempotency: one real transaction funds one bounty, once

A signature/hash already recorded against any bounty is refused on a second submission —
`already_recorded`, naming which bounty it's already attached to. Without this, the same real
deposit could be claimed as "evidence" for multiple bounties.

### 5. Status: additive, not a gate

Recording a deposit doesn't change a bounty's `open`/`claimed`/`cancelled` status, and isn't
restricted by it — funding can happen at any point in a bounty's life (e.g. a supporter backing an
already-claimed bounty's stated reward after the fact). The board shows total verified deposits per
asset alongside the opener's own free-text `reward`; it never overwrites or parses that text.

## What this does not do

- **No escrow.** Nothing here can release funds; nothing here proves the operator *will* pay out.
  The deposit being verified means the money really arrived at the configured address, nothing more.
- **No price/value conversion.** A verified deposit is reported in its own asset and raw amount
  (e.g. "2.5 SOL", "100000 of mint `Fo3J...`") — never converted to a dollar figure or compared
  against the opener's free-text reward claim, which this system still never parses (ADR 0009).
- **No multi-signature aggregation beyond listing.** Each deposit is its own verified record; the
  board sums them for display, but doesn't merge, net, or dedupe beyond the one-tx-one-bounty rule
  in §4.

## Consequences

- A wallet this project doesn't control the key to, but whose address is public config, can now
  receive real funds tied to a specific bounty, with on-chain proof anyone can re-check independently
  (the signature/hash is shown; nothing here is privileged).
- `@osstrace/chain-solana` and `@osstrace/chain-ethereum` gain no new public surface — verification
  reuses `summarizeTransaction`/`decodeSplTransfers` and plain JSON-RPC calls already used elsewhere,
  so there's one real decoder per chain, not two.
- The web UI gains real wallet-connect (Solana via the Wallet Standard through
  `@solana/wallet-adapter-react`; Ethereum via the standard injected EIP-1193 provider) so a user
  can send the deposit and get the signature without leaving the page, plus a plain "paste a
  signature" fallback for anyone who sent from an exchange or a wallet this page can't connect to.

## What would change this decision

- **Real demand for the project to guarantee payout, not just record a deposit** → a real escrow
  program, its own ADR, its own security review before any mainnet deployment.
- **A third chain** → its own verification function here, same pattern, cited real event/program
  identifiers, no generic "any chain" abstraction invented ahead of actually needing one.

## Addendum (2026-10-23): Bitcoin, deposit-only

Bitcoin is the "third chain" above, added for bounty deposits only — it is not an address
lookup/trace/label chain anywhere else in the app (the shared `Chain` type stays Solana/Ethereum;
deposits use a separate, wider `DepositChain`). `DEPOSIT_WALLET_BITCOIN` is the receiving address;
`verifyBitcoinDeposit` in `packages/server/src/chain/deposits.ts` checks a pasted txid against a
public Esplora-API explorer (`ESPLORA_URL`, Blockstream.info by default, no key): the tx must be
confirmed in a block and have at least one output paying the configured address, and the amount is
the sum of those outputs. There's no asset allowlist because base-layer Bitcoin has no fungible-token
standard to fake a deposit with.

The one deliberate difference from Solana/Ethereum: **no sender-ownership check.** There's no
Bitcoin wallet-connect standard to sign in with, and a Bitcoin transaction has no single
recoverable sender (many inputs, no ecrecover-style authority). So any signed-in user, on any
chain's account, can record a verified BTC payment, and its `fromAddress` (the first input's
previous-output address, when the explorer resolves it) is display-only. The cost is that someone
watching the public wallet could attach another person's BTC payment to a bounty of their choosing;
the one-tx-one-bounty rule in §4 still holds, so a payment can't be counted twice. The web UI only
offers Bitcoin in the "paste the reference" form, never the connect-and-send one.
