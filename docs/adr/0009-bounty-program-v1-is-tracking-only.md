# ADR 0009 — Bounty program v1: tracks bounties, never holds funds

Status: Decided 2026-10-22 (implemented in `packages/features/bounties/`)

## Context

ROADMAP.md Wave 7 and `PRD.md`'s Open Questions both named the same unresolved tension: a bounty
program where someone funds a feature with tokens held until a matching PR merges *is custody* —
and this project's own `PRD.md` Non-Goal #2 says it stays "read-only / observational, never
custodial or transactional." Three things were explicitly undecided:

1. What token funds a bounty (none exists for this project).
2. How funds are escrowed until a bounty is claimed.
3. How a payout is verified and triggered when more than one PR is close.

The operator asked for the bounty program to be real and live for launch, not deferred further.
None of the three questions above got easier by waiting, and none of them need to be answered to
ship a real, working bounty *board* — they only block an automated *payout*.

## Decision

**v1 tracks bounties, submissions, and claims. It never touches a token, holds a balance, or
moves a payout.** Concretely:

- A bounty's `reward` field is free text, exactly as the poster wrote it (e.g. `"100,000 tokens"`,
  `"$500, token TBD"`) — never parsed as a currency amount, never validated against a real asset,
  never summed or displayed as if it's a number this system can account for. It's a claim the
  poster is making to the submitters, not a balance the platform holds.
- Opening a bounty, submitting a PR against it, and a moderator marking a submission as the
  winning claim are all real, persisted actions with real authorization (reusing
  `@osstrace/accounts`, same as Community labels and private labels). Nothing about the workflow
  is fake or a placeholder.
- **The actual payout happens off-platform**, between the bounty's opener and the claimant, after
  a moderator marks a submission `claimed`. This system records that it happened and who the
  parties were; it does not make it happen.

This keeps the platform itself non-custodial — consistent with `PRD.md` Non-Goal #2 — while being
a real, launchable feature today. It does **not** resolve the three questions above; it sidesteps
needing to for v1. If this project later builds an actual token + escrow flow, that is new scope
requiring its own ADR, not an extension of this one.

### Why not wait for the token/escrow design instead?

Because the escrow question and the board-and-workflow question are genuinely separable. A bounty
board (post a spec, collect PR submissions, let a moderator pick the winner, track status) has
real value and can be fully honest about what it is — a directory and a workflow tracker — without
pretending to also be an escrow system it isn't. Shipping that now, clearly scoped, beats either
building a fake-looking payment system or leaving the whole feature undone.

### Why a moderator, not the bounty's own opener, marks the claim

Same reasoning ADR 0007 already uses for label review: letting the opener alone decide "whose PR
wins" with no check is open to a dispute with no record of who adjudicated it. A moderator action
here doesn't verify the PR is actually merged or the reward actually paid (this system has no way
to check either) — it only records "an accountable person on this project confirmed this
submission matches the spec." The bounty's own opener can still **cancel** an unclaimed bounty.

### Data model

- `Bounty`: `open | claimed | cancelled`. `reward` is a free-text field, documented above.
- `BountySubmission`: a PR URL + optional note against one bounty, `pending | accepted | rejected`.
  Claiming one rejects every other pending submission on the same bounty.
- Both are public to read — no login needed to browse the board, matching the project's own
  "public by default" posture elsewhere (labels, the graph, Tracer).

## Consequences

- Nothing in this project ever reads, writes, or references a real token contract, wallet, or
  balance for bounties. There is no secret to leak and no mainnet-funds rule this touches.
- A later real payout system is additive, not a rewrite: `Bounty.reward` staying free text means
  a future ADR can introduce a separate, real `fundedAmount`/`token`/escrow-transaction record
  alongside it without breaking anything built in v1.
- The honest limitation, stated plainly in the README/ROADMAP: this is a bounty *tracker*, not a
  bounty *bank*. Anyone funding or claiming a bounty today is trusting the other party directly,
  same as a handshake deal referencing a public GitHub issue — this system just makes that
  handshake's terms and outcome a matter of public record instead of chat history.
