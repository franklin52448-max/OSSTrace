# @osstrace/risk-scoring

Gives an address a risk score from two real signals, nothing else:

1. **Direct exposure.** Does the address itself carry a risk tag in the label dataset? Today the
   only risk tag is `"sanctioned"`, from the US OFAC SDN list and the UK Sanctions List.
2. **Hop-distance exposure.** Does Tracer's own `traceGraph` reach a risk-tagged address within a
   few real transfers? The nearer it is, the higher the score.

Every number comes with its evidence: the real tag and its cited source, the nearest flagged
address, and the actual path of transfers to it. It also says whether the search really finished.
Design and the exact rule: [ADR 0010](../../../docs/adr/0010-risk-scoring-model.md).

## The scoring rule

| Nearest risk-tagged address | `score` | `tier` |
|---|---:|---|
| The address itself | 100 | `severe` |
| 1 hop away | 75 | `high` |
| 2 hops away | 50 | `medium` |
| 3 hops away | 25 | `low` |
| None within the radius, search complete | 0 | `none` |
| None found, search **incomplete** | `null` | `inconclusive` |

- A hop is one real transfer, native or decoded ERC-20/SPL, in either direction. A reverted
  transaction is never a hop.
- Only the nearest flagged address sets the score. Several of them don't add up, but every one
  within the radius is listed in `flagged`.
- Only tags listed in `RISK_TAGS` (`src/risk.ts`) count. Safe's `"protocol-contract"` doesn't, and
  labels never do (community submissions carry no tags at all).

## `inconclusive` is not `none`

The score is a claim about everything within `maxHops` hops. If any of that wasn't checked, the
result says so (`searchIncomplete: true`) and lists every **gap** in `search.gaps`:

- `breadth-cap` / `budget-exhausted` / `unavailable`: Tracer reached the node but didn't expand it.
  For `unavailable`, the chain adapter's own reason (an RPC error, a missing API key) is attached
  as `detail`.
- `history-truncated`: the node's transaction page came back full, so older counterparties were
  never seen.

With no flagged address and any gap, the tier is `inconclusive` and the score is `null`, never
`none`/0. With a flagged address found, `scoreIsLowerBound: true` means a gap sits close enough that
a *nearer* flagged address could still exist, so treat the score as a minimum. Tracer's `depth-cap`
(nodes sitting exactly at `maxHops`) isn't a gap: that's the edge of the radius. It's counted in
`search.beyondRadius`.

## Running it

```sh
npm run dev:risk
# or: npm run dev --workspace packages/features/risk-scoring
```

It reads the root `.env` the same way Explorer and Tracer do (`ETH_RPC_URL`, `ETHERSCAN_API_KEY`,
`SOLANA_RPC_URL`) and listens on `RISK_SCORING_PORT`, default **5305**.

## API

### `GET /risk/:chain/:address?maxHops=&breadth=&txLimit=&maxCalls=`

```
curl "http://localhost:5305/risk/solana/42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi"
```

Returns a `RiskAssessment`:

```
{ address, score, tier, basis, directTags, nearest, flagged, search,
  searchIncomplete, scoreIsLowerBound, explanation }
```

- `basis`: `"direct"` | `"hop-distance"` | `"none"`.
- `directTags`: the risk tags on the address itself, each with its real `source`.
- `nearest`: `{ id, hops, riskTags, label, path }`, where `path` is the real `GraphEdge`s from the
  scored address to the flagged one, in order. `null` when nothing was found, or when the exposure
  is direct.
- `search`: `{ maxHops, breadth, txLimitPerNode, maxAdapterCalls, adapterCallsUsed, nodesChecked,
  edgesFollowed, complete, gaps, beyondRadius }`. It's `null` when a direct tag made the search
  unnecessary, because 100 is already the maximum.
- `explanation`: one plain-language sentence that says the same thing as the fields above.

The query options use the same names as Tracer's endpoints and are clamped by Tracer's own
`clampTraceOptions`. Defaults: `maxHops=2`, `breadth=5`, `txLimit=25`, `maxCalls=40`.

`GET /health` returns `{ "ok": true }`. Errors: `400` for an unsupported chain or an invalid
address, and `502` when the adapter throws.

## How it plugs in

- **Traversal:** `traceGraph` from `@osstrace/tracer`, called directly. Nothing here reimplements
  graph search. `scoreRisk` only computes hop distances over the edges Tracer returned, to
  rebuild the path.
- **One wrapper:** `RecordingAdapter` passes every call through unchanged and records how many
  transactions each one returned, plus the adapter's reason when a fetch failed. This is how
  `history-truncated` and gap `detail` are known.
- **Chain wiring + label store:** Explorer's `bootstrap.ts`, the same documented exception that
  Visualizer and Tracer take. Every dataset in `data/labels/` and every chain in the registry is
  picked up automatically.
- **Pure core:** `scoreRisk(inputs)` is the whole rule as a pure function of already-fetched data.
  `assessRisk` does the I/O.
- **Web UI:** the Lookup report has a **Risk score** card (`packages/web/src/RiskPanel.tsx`). It
  runs only when you press "Compute risk score", because a hop search can cost up to ~40 RPC calls.
  It shows the score, the tier, a SEARCH INCOMPLETE chip, the nearest flagged address with its
  path, the cited sources, and each gap. `VITE_RISK_SCORING_URL` (default `http://localhost:5305`)
  points it at this API.

## Cost per request

- **A directly-tagged address:** 0 chain calls, plus one local tag lookup.
- **Anything else:** one `traceGraph` run, at most `maxCalls` (default 40)
  `getRecentTransactions` calls. See Tracer's README, "Cost per request". After that, one local
  tag lookup per address reached.

## Real limitations

- **It only knows what this project has ingested.** Today that's ~92 sanctioned Ethereum/Solana
  addresses from two government lists. Exposure to a hacker wallet, a mixer, or any other list
  not ingested here is invisible. A `none` result means "no exposure to what this project knows
  about", never "this address is clean".
- **Busy addresses usually come back `inconclusive`.** A page of 25 transactions rarely covers a
  busy wallet's whole history, and the public RPCs rate-limit a multi-hop search. That's the
  honest result. Raise `txLimit`/`maxCalls`, or set a private RPC.
- **Ethereum edge:** the Etherscan adapter can return fewer than `txLimit` transactions even
  though older history exists. When it merges the native and token pages it drops entries past a
  full page's cut-off block. `history-truncated` can't detect that case (ADR 0010, Consequences).
- **The scope is one address on one chain.** There's no entity-level score, no cross-chain or
  bridge exposure, and exposure doesn't decay over time.
- **No caching.** Every request runs a fresh search.

## Testing

`npm test` runs `tests/risk.test.ts`. Two small test-double classes stand in for real services,
with no mocking framework: `MapChainAdapter` (fixed transactions per address, which honours
`limit`) and `MapLabelReader`. The tests cover:

- a direct tag (severe/100, zero chain calls)
- exposure at 1, 2 and 3 hops, with the real path checked
- a flagged address past `maxHops`, which is ignored
- the nearest of several flagged addresses winning
- a complete negative (`none`)
- incomplete negatives that must come back `inconclusive`: call budget, an unavailable node, the
  scored address itself unavailable, the breadth cap, and a full history page
- `scoreIsLowerBound` true vs false, depending on where the gap sits
- `RecordingAdapter`

It also runs against **this project's real seed labelset** (`data/labels/*.json`): a real
OFAC-listed Ethereum address and a Solana one score severe with OFAC's real citation, a real Safe
contract scores none, and an address one hop from a real OFAC-listed address scores high.
