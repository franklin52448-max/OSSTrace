# ADR 0012 — Tracer: cross-chain bridge hops, via Wormhole

Status: Decided 2026-10-22 (implemented in `packages/features/tracer/src/bridges/`)

## Context

ADR 0008 §5 scoped Tracer to one chain per request: `traceGraph` and `tracePath` take one
`ChainId` and never leave it. In practice that means a trail that crosses from Ethereum to Solana
(or back) through a bridge dead-ends on the source chain at the bridge's contract or custody
account, and Tracer has no way to say where the funds went next. `ROADMAP.md`'s Wave 4 named this
as the one part of Tracer that was still unsolved.

Bridging is not one protocol, and "follow a bridge" is not one generic algorithm: every bridge has
its own contracts, its own message format and its own way (if any) of linking a deposit on one
chain to a release on the other. So this ADR picks **one** real protocol, says exactly how a
source-chain transaction is linked to its destination-chain transaction with real data, and is
explicit about what that link does and doesn't prove.

## The protocol: Wormhole

Wormhole is a message-passing protocol with real, live deployments on both Ethereum and Solana and
a public spec for its messages. Its Portal Token Bridge is the usual way tokens move between those
two chains over Wormhole. Its own public explorer API (Wormholescan) indexes every message, and
that index is what gives a real source-tx → destination-tx link.

### The contract addresses this ADR depends on, and where each one comes from

| What | Chain | Address |
|---|---|---|
| Core Bridge | Ethereum | `0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B` |
| Portal Token Bridge | Ethereum | `0x3ee18B2214AFF97000D974cf647E7C347E8fa585` |
| Core Bridge | Solana | `worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth` |
| Portal Token Bridge | Solana | `wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb` |

Each address was checked against two of Wormhole's own publications and against the chain itself
on 2026-10-22:

1. **Wormhole's documentation**, "Contract Addresses":
   <https://wormhole.com/docs/reference/contract-addresses/>. All four addresses appear there.
2. **Wormhole's official TypeScript SDK**, `wormhole-foundation/wormhole-sdk-ts` at commit
   `c0dbf3498e9eb5dc40d2441ac61567a89d6fbde9`: `core/base/src/constants/contracts/core.ts` (Core
   Bridge, `Mainnet` table) and `core/base/src/constants/contracts/tokenBridge.ts` (Token Bridge,
   `Mainnet` table).
3. **The chain itself**: `eth_getCode` returns real contract bytecode at both Ethereum addresses,
   and `getAccountInfo` reports both Solana addresses as `executable: true` programs owned by
   `BPFLoaderUpgradeab1e11111111111111111111111`.

Wormhole's own chain-ID numbering (Solana = `1`, Ethereum = `2`) comes from the same SDK commit,
`core/base/src/constants/chains.ts`. Both the addresses and the chain IDs live in
`packages/features/tracer/src/bridges/wormhole.ts`, with these citations next to them. ADR 0002's
rule ("a fact without a cited source doesn't go in") applies to a bridge contract address as much
as it applies to a label.

## How a bridge hop is resolved, with real data

### The link: Wormholescan's operations API

`GET https://api.wormholescan.io/api/v1/operations?address=<address>` returns the Wormhole
"operations" (one per signed message, called a VAA) in which that address is the sender or the
recipient. Each operation carries:

- `sourceChain.transaction.txHash`, `sourceChain.from` and `sourceChain.timestamp`: the
  source-chain transaction that emitted the message;
- `content.standarizedProperties.{fromChain, toChain, fromAddress, toAddress, tokenAddress,
  tokenChain}`: the transfer the message describes, decoded from the signed payload;
- `targetChain.transaction.txHash`, `targetChain.status` and `targetChain.timestamp`, **only when
  Wormholescan has indexed a destination-chain transaction that redeemed the message**;
- `data.{symbol, tokenAmount}` when Wormholescan resolved the token.

The API is public and needs no key. Its own Swagger spec
(<https://api.wormholescan.io/swagger.json>) says "This API is public and does not require
authentication although some endpoints are rate limited". The response headers seen on
2026-10-22 were `x-ratelimit-limit: 1000` with a reset counter of under a minute. That is an
observation, not a documented guarantee. It was checked for real, in both directions: looking up
Ethereum tx `0x465e0cb5…0693b9` by `txHash` returned operation
`2/…3ee18b…a585/698122` with Solana destination tx `5BmKXqEv…qXhg2`, and looking up that Solana
tx returned the same operation.

**No new paid provider and no API key.** Wormholescan is run for the Wormhole protocol itself. It
is not a proprietary intelligence platform like the ones ADR 0004/0005 exclude: it holds no
attribution labels, only the protocol's own message index, and each operation is backed by a
guardian-signed VAA that anyone can check independently.

### What was tried and rejected

- **`POST /api/v1/operations` with a batch of tx hashes.** The Swagger spec documents it, and it
  would have let Tracer check every transaction it already fetched in one call. The live API
  answers `405 Method Not Allowed`, so nothing here depends on it.
- **Detecting bridges from chain data alone** (flagging any edge whose counterparty is a Wormhole
  contract). On Ethereum a Token Bridge `transferTokens` call is visible (`tx.to` is the bridge,
  or an ERC-20 burn to `0x0` for wrapped assets). On Solana the user's tokens go to a custody
  token account owned by a PDA, or are burned, and neither shows the program ID in a
  `TransactionSummary`. Even where detection works, chain data alone can't name the
  destination-chain transaction. The link has to come from the protocol's own index.
- **One `txHash` lookup per fetched transaction.** This would cost up to `txLimitPerNode` extra
  calls per node. One `address` lookup per node gives the same result for one call.

### Detection: one Wormholescan call per expanded node

When bridge-following is on, every node Tracer expands successfully on its own chain also gets
one `operations?address=<node>` call, with `pageSize` equal to `txLimitPerNode`. Each operation
that comes back is classified **relative to the node's own chain**:

- **Outgoing** — the operation's source chain is the node's chain, and the node is the
  operation's `sourceChain.from` or its standardized `fromAddress`.
- **Incoming** — the operation's destination chain is the node's chain, and the node is its
  standardized `toAddress`.
- **Neither** — dropped. This case matters because an EVM address is the same 20 bytes on every
  EVM chain. Wormholescan returns an operation where `0x4971…a452` sends from *Base*, or receives
  on *Arbitrum*, for a query about `0x4971…a452`. That is a different account on a different
  chain, and treating it as the Ethereum node would invent a flow that never touched it. The
  real recorded fixture `tests/fixtures/wormholescan-operations-eth-0x49719d.json` has exactly
  this case, and a test checks that it's dropped.

### What becomes an edge, and what doesn't

An operation becomes a **`kind: "bridge"` edge** only when all of the following hold:

1. Both its source and destination chains are chains OSSTrace supports (Wormhole IDs `2` and `1`).
2. Wormholescan reports a destination transaction hash for it.
3. Both endpoints are well-formed addresses for their own chains (`isRealAddress`).

Each bridge edge carries `protocol: "wormhole"`, the operation ID
(`emitterChain/emitter/sequence`, the VAA's real identity), both legs' real tx hashes
(`sourceTxHash` and `targetTxHash`), both chains, both timestamps, the app IDs Wormholescan
reports (`PORTAL_TOKEN_BRIDGE`, `NATIVE_TOKEN_TRANSFER`, …), and the token symbol and amount only
if Wormholescan resolved them (otherwise `null`, never guessed). `hash` is the source tx hash, so
code that already keys edges by `hash` keeps working.

Any operation that involves the node but fails one of those checks is **not** dropped silently.
It goes into a separate `bridgeDeadEnds` list with one of these reasons:

- `"no-destination-tx"` — Wormholescan has no destination-chain transaction for this message.
  From this source alone, Tracer **can't tell whether the transfer hasn't been redeemed yet or
  was redeemed and isn't indexed**, so the reason only says what's missing. The real recorded
  Solana fixture has several Solana → Ethereum Portal transfers in this state, days old.
- `"counterparty-chain-unsupported"` — the other end is a Wormhole chain OSSTrace has no adapter
  for (BSC, Base, Arbitrum, …). Its Wormhole chain ID is reported, never mapped to an invented
  `ChainId`.
- `"counterparty-address-unresolved"` — the other end isn't a well-formed address for its chain.

A dead end names the funds' last known whereabouts. It is never presented as a hop Tracer
followed.

### The Solana side of a Portal Token Bridge hop is a token account, not a wallet

The Token Bridge `Transfer` payload names its recipient as raw bytes (`To bytes32`, Wormhole's
`whitepapers/0003_token_bridge.md`). Solana's `complete_transfer` requires those bytes to be the
destination **SPL token account** itself: `if accs.vaa.to != accs.to.info().key.to_bytes() {
return Err(InvalidRecipient) }`, where `to` is an initialized `SplAccount`
(`wormhole-foundation/wormhole`, `solana/modules/token_bridge/program/src/api/complete_transfer.rs`,
commit `8587f77c845ed6c173bc53fc4127c4f4c2fc4212`). This was confirmed for real:
`getAccountInfo` on recipient `5SVJw4…NgW3m` (from the fixture) shows an SPL token account whose
owner is `AQFnRF…ZeLWG`.

So for an Ethereum → Solana Portal transfer, the bridge edge's target is **that token account**,
exactly as the signed message names it. It is not swapped for an owner wallet Tracer would have
to work out from somewhere else. Tracing still continues correctly from there: the Solana
adapter's SPL decoder (`decodeSplTransfers`) counts a transfer *from that token account itself*
as outgoing, so the account's onward token movements become edges. Resolving it to its owning
wallet (for label lookups, and to merge it with that wallet's other activity) is listed under
"Deferred" below. Other Wormhole apps (e.g. `NATIVE_TOKEN_TRANSFER`) name a wallet directly, and
Tracer reports exactly what each operation names.

### Traversal, budget, filters

- **Opt-in.** Bridge-following happens only when the caller asks for it (`?bridges=wormhole` on
  either endpoint). Without it, Tracer behaves exactly as under ADR 0008, with the same call
  counts and the same results.
- **Nodes can now be on either chain.** A node ID is still its canonical address. The two formats
  can't collide: Ethereum's is `0x` + hex, and base58 has no `0` in its alphabet. Each result
  also carries `nodeChains` (id → `ChainId`), and every `TracedNode.address.chain` is that node's
  own chain, no longer always the start node's. A node reached over a bridge is expanded with
  *its* chain's adapter.
- **Bridge neighbours compete for `breadth` like any other neighbour**, ranked by recency (ADR
  0008 §4). They don't get a separate quota, so `breadth` keeps meaning what it says.
- **Budget.** Bridge lookups are counted on their own (`bridgeLookupsUsed`) and happen at most once
  per expanded node, so `bridgeLookupsUsed ≤ adapterCallsUsed ≤ maxAdapterCalls`. With bridges on,
  the worst case is twice the external calls of the same trace without them, and the README's
  "Cost per request" section says so. A Wormholescan failure doesn't fail the trace. It is
  reported per node in `bridgeLookupFailures` (`{ id, reason }`), so "no bridge activity" and
  "couldn't check for bridge activity" stay distinct, as everywhere else in this project.
- **Filters apply per hop, bridge hops included** (ADR 0008 §2). A bridge edge matches a `token`
  filter on Wormholescan's reported symbol, and a `minAmount` filter on its reported token amount.
  It never matches `token=native`. If the symbol or amount is unknown, the edge fails that filter
  rather than passing by default. This is strict on purpose, and it has a visible consequence:
  USDC bridged from Ethereum arrives on Solana as a *different*, wrapped token, so a
  `token=USDC` path breaks at the first hop after the bridge. That isn't a bug. Treating two
  different tokens as the same would be the cross-token conversion ADR 0008 §3 rules out.
- **`tracePath` can now cross chains:** `GET /trace/path/:chain?from=&to=&toChain=` takes the
  `to` address's own chain. A cross-chain `to` without `bridges=wormhole` is rejected with `400`.
  Without bridges the answer could only ever be "not found", which would be a misleading result.
- **A fix to `tracePath` that this work exposed.** The search used to check for the target only
  among a node's top-`breadth` neighbours, so a fetched edge that reached `to` directly could be
  ignored just because it wasn't recent enough. A live test hit this: a busy Solana wallet's
  Wormhole hop to Ethereum was never in its 10 most recent neighbours. `breadth` is meant to limit
  *expansion* (ADR 0008 §4), not to hide evidence Tracer has already fetched. So `tracePath` now
  checks every matching edge for the target before ranking by breadth. This applies to
  single-chain paths too, and has its own test.

## Verified live, 2026-10-22

With the real `SolanaAdapter` (configured `SOLANA_RPC_URL`) and the real `WormholescanResolver`:

- `GET /trace/graph/solana/AQFnRF…ZeLWG?maxHops=2&breadth=3&bridges=wormhole` returned a
  `kind: "bridge"` edge from Ethereum `0x49719d…a452` to that wallet: operation
  `2/…1cb452…fbf9/635`, `NATIVE_TOKEN_TRANSFER`, 45050.09112573 GROW. Source tx
  `0x3374682d…a07f67`, destination tx `3AeD7HQM…bwmEQ2`. The response also had 9 real dead ends
  and the Ethereum node labeled under `chain: "ethereum"`.
- `GET /trace/path/solana?from=AQFnRF…&to=0x49719d…&toChain=ethereum&token=GROW&minAmount=40000&bridges=wormhole`
  returned `found: true` with that one bridge hop, using 1 chain call and 1 bridge lookup.

## What this does not prove

- **The cross-chain link is Wormholescan's index, not something Tracer re-derives from both
  chains.** Wormholescan reports the destination tx hash, and Tracer doesn't fetch that
  transaction from the destination chain to confirm it redeemed this exact VAA, or to confirm
  the recipient and amount. A bridge edge says where its link came from (`evidence:
  "wormholescan"`), and the README says the same. Checking it independently is listed under
  "Deferred".
- **Only bridging through Wormhole is detected.** Funds that leave over any other bridge (deBridge,
  Allbridge, Mayan's own contracts, a centralized exchange used as a bridge, …) still dead-end on
  the source chain exactly as before, with nothing to show a bridge was involved.
- **Coverage per node is limited to the `txLimitPerNode` most recent operations**, the same recency
  window ADR 0008 already uses for chain transactions.

## Deferred (real future work, not hidden)

- Independently checking each bridge edge against the destination chain: fetch `targetTxHash`
  from the destination chain's RPC, confirm it succeeded and touched the Token Bridge, and parse
  the raw VAA Wormholescan returns to cross-check recipient, amount and chain against its own
  parsed JSON. This needs either a `getTransaction` capability on `ChainAdapter` (a core
  interface change, with its own ADR) or a feature-level RPC client, which would bend the plugin
  boundary.
- Resolving a Solana Portal recipient token account to its owning wallet. The owner *at redeem
  time* is in the redeem transaction's own `postTokenBalances`, so this belongs with the check
  above.
- A second bridge protocol. Each needs its own real, cited contract addresses and its own real
  way to link the two legs. Nothing here is generic over "any bridge", on purpose.

## Consequences

- A trace that crosses Ethereum ↔ Solana through Wormhole no longer dead-ends at the bridge
  contract. It continues on the other chain, with both legs' real tx hashes on the hop.
- Tracer now depends on one more public external service when, and only when, a caller asks for
  bridges. No key is needed, and nothing changes for a caller who doesn't ask.
- `TraceEdge` (`GraphEdge | BridgeEdge`) replaces `GraphEdge` in Tracer's result types. Visualizer's
  `GraphEdge` itself is unchanged, and a caller that never enables bridges never sees a
  `kind: "bridge"` edge.
