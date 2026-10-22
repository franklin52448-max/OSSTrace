# ADR 0010 — Risk scoring: nearest risk tag by hop distance, and an incomplete search is never "none"

Status: Decided 2026-10-22 (implemented in `packages/features/risk-scoring/`)

> Numbering note: other features were being built in parallel when this was written. If another
> ADR also landed as 0010, renumber this one to the next free number at merge time; nothing in the
> code depends on the number except the comments that cite it.

## Context

ROADMAP Wave 3 lists Risk Scoring: "address/entity risk indicators (sanctions exposure, hop-distance
from a flagged address)". Two pieces it needs already exist:

- **Real risk data.** The label dataset (`data/labels/`) tags every address on the US OFAC SDN list
  and the UK Sanctions List with `"sanctioned"`, each with its own cited source (ADR 0002).
- **Real graph traversal.** Tracer's `traceGraph` (ADR 0008) expands up to 3 hops with hard caps,
  and says honestly which nodes it didn't expand and why (`depth-cap` / `breadth-cap` /
  `budget-exhausted` / `unavailable`).

What had to be decided: what the score is, how it's computed, and how it handles a search that
didn't finish. That last one matters most. A risk tool exists to flag things. If it reports "no
exposure" when it really means "we stopped looking", that is a correctness bug, and a dangerous
one, because the safe-looking answer is the one nobody double-checks.

## Decision

### 1. Two signals only, both from real data

- **Direct exposure:** the address itself carries a risk tag.
- **Hop-distance exposure:** `traceGraph` reaches an address carrying a risk tag. Only the nearest
  one sets the score.

Nothing else moves the score: no balance, no volume, no age of the address, no "looks like a mixer"
guessing. Each of those would be a heuristic with no cited source behind it, and this project's
rule (ADR 0002) is that a claim about an address needs one.

### 2. Which tags count: an explicit allowlist

`RISK_TAGS` in `src/risk.ts`. Today it holds one tag:

| Tag | Why it's risk | Real sources that emit it today |
|---|---|---|
| `sanctioned` | The address is on a government sanctions list | `ofac-sdn.json` (US OFAC SDN), `uk-sanctions-list.json` (UK Sanctions List) |

Any other tag is ignored, including Safe's `"protocol-contract"`. Labels don't count, only tags.
Community labels carry no tags (`CommunityLabelReader.getTags` always returns `[]`), so an
unreviewed community claim can't move a score. Adding a risk tag means adding a row here and a line
in `RISK_TAGS`, and only for a tag that a real ingested source actually emits. A placeholder entry
for data we don't have yet doesn't count.

### 3. The score: a lookup table on hop distance

| Nearest risk-tagged address | Score | Tier |
|---|---:|---|
| The address itself (0 hops) | 100 | `severe` |
| 1 hop away | 75 | `high` |
| 2 hops away | 50 | `medium` |
| 3 hops away | 25 | `low` |
| None within the searched radius, **search complete** | 0 | `none` |
| None found, **search incomplete** | `null` | `inconclusive` |

In other words, `score = 100 − 25 × hops`. A "hop" is one real transfer, native or decoded token,
in either direction. Direction isn't weighted: receiving from a sanctioned address and sending to
one are both exposure, and the returned path shows which it was. A reverted transaction is never an
edge (Visualizer's `deriveGraph` drops `status: "failed"`), so a failed attempt to move funds isn't
exposure.

Several flagged addresses don't add up. The score is the nearest one's and nothing more. Summing
them would mean deciding how much two 2-hop exposures are worth against one 1-hop exposure, which
is an invented weighting. Every flagged address in the radius is still listed in `flagged`, nearest
first, so nothing is hidden.

Why a table and not a model: anyone can check it by hand from the returned path and tag. A
weighted model would need calibration data this project doesn't have.

### 4. Direct exposure skips the search

100 is the maximum, so nothing a hop search finds can change it. A directly-tagged address costs
zero chain calls. `search` is `null` and `searchIncomplete` is `false`: the *score* is final,
even though the graph around it wasn't searched.

### 5. Honesty about an incomplete search (carrying ADR 0008 §4 forward)

The scored claim is "nearest risk-tagged address within `maxHops` hops". The search is
**complete** only when every address within that radius that's reachable through the fetched
history was checked. Every place it might not have been is a **gap**:

| Gap | Where it comes from | Counts when |
|---|---|---|
| `breadth-cap` | Tracer frontier | the node is at hop `d < maxHops` (its neighbors at `d+1` were never seen) |
| `budget-exhausted` | Tracer frontier | same |
| `unavailable` | Tracer frontier, plus the adapter's own reason text as `detail` | same, including the scored address itself at hop 0 |
| `history-truncated` | risk scoring | an expanded node's transaction page came back full (`returned >= txLimitPerNode`), so older counterparties were never seen |

`history-truncated` is risk scoring's own addition. Tracer never claims that a node's page held
its whole history, so Tracer doesn't need it. But "no sanctioned counterparty in the last 25
transactions" is a much weaker statement than "no sanctioned counterparty", and the score must not
blur the two. A small `RecordingAdapter` wrapper counts what each call returned, and Tracer sees
exactly the same data.

**Tracer's `depth-cap` is not a gap.** A depth-capped node sits exactly at `maxHops`. Its own tags
were checked, and what lies past it is outside the radius the score makes any claim about. It's
still reported, as `search.beyondRadius`. Counting it as a gap would make almost every result
"incomplete" by definition, and the flag would stop meaning anything.

How gaps change the result:

- **No flagged address, no gaps:** `none`, score 0. A real negative within the radius.
- **No flagged address, any gap:** `inconclusive`, score `null`, `searchIncomplete: true`,
  `scoreIsLowerBound: true`. It is never `none`. `null` rather than 0 means a caller that reads
  only the number can't treat it as clean.
- **Flagged address at hop `d`:** the tier and score are set by `d`. `searchIncomplete` is `true`
  if there's any gap. `scoreIsLowerBound` is `true` only if some gap at hop `g` has `g + 1 < d`.
  Such a gap could be hiding a *nearer* flagged address, so the real score could be higher. A gap
  further out can't change the score, but more flagged addresses might sit in it, and the
  explanation says so.

### 6. Search options: Tracer's, reused and clamped by Tracer

Risk scoring calls `traceGraph` directly and clamps options with Tracer's own `clampTraceOptions`
(1–3 hops, breadth ≤ 10, ≤ 50 tx per node, ≤ 100 calls). The defaults differ in one way:
`txLimitPerNode` is **25** rather than Tracer's 10. That makes `history-truncated` gaps less
frequent without raising `maxAdapterCalls` (still 40). `maxHops` defaults to 2. A caller asks for
3 with `?maxHops=3`, and should expect to hit the call budget, and so get an incomplete search, on
most active addresses.

### 7. No new data provider, no caching

The service uses the same RPC configuration and Explorer bootstrap (chain registry + label store)
as Tracer and Visualizer. It adds no paid service and no new external API.

## Consequences

- Coverage is only as good as the ingested risk sources: today that's ~92 distinct sanctioned
  Ethereum/Solana addresses from two government lists. A `none` result means "no exposure to what
  this project knows about", never "this address is clean". The README says so plainly.
- On real, busy addresses the most common honest answer will be `inconclusive`, usually because the
  page came back full or the public RPC rate-limited a call. That is the correct answer, and the
  fix is more budget or a private RPC, never loosening the rule.
- **Known edge (Ethereum):** the Etherscan adapter merges `txlist` and `tokentx` pages and drops
  entries older than a full page's cut-off block (`mergeHistory` in
  `packages/chains/ethereum/src/etherscan.ts`). So it can return *fewer* than `limit` transactions
  even though older history exists, and `history-truncated` can't see that. The real fix is a
  "more history exists" signal on `TransactionsResult` in `@osstrace/core`. That changes the
  `ChainAdapter` contract, so it's left for its own decision and not slipped in here.
- Only a single chain and one address at a time, the same as Tracer. There is no entity-level
  score, and no cross-chain or bridge exposure.

## What would change this decision

- A second risk tag from a real source (a sourced exploit/hacker list, say) would need its own row
  in §2. If it deserves a different severity from sanctions, the table in §3 becomes per-tag, and
  that change needs this ADR updated, not just a code edit.
- A core `hasMore` signal on transaction history would replace the `returned >= limit` heuristic in
  §5 and close the Ethereum edge above.
