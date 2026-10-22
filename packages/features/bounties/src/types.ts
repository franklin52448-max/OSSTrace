import type { AccountId } from "@osstrace/core";

/**
 * The bounty data model. See docs/adr/0009-bounty-program-v1-is-tracking-only.md.
 *
 * This system never holds or moves a payout — `reward` is the poster's own free-text claim, not a
 * balance this project accounts for. The real exchange happens off-platform; this is the record
 * of the spec, who submitted against it, and who a moderator recorded as the accepted claim.
 */
export type BountyStatus = "open" | "claimed" | "cancelled";

interface BountyFields {
  /** Random UUID. */
  id: string;
  title: string;
  /** The in-depth feature spec: what it does, how it should behave, what "done" looks like. */
  description: string;
  /** Free text exactly as the poster wrote it (e.g. "100,000 tokens", "$500, token TBD"). Never
   *  parsed as a currency amount or validated against a real asset — see ADR 0009. */
  reward: string;
  openedBy: AccountId;
  /** ISO 8601 timestamp. */
  openedAt: string;
}

export interface OpenBounty extends BountyFields {
  status: "open";
}

export interface ClaimedBounty extends BountyFields {
  status: "claimed";
  claimedSubmissionId: string;
  /** The submitter whose PR was accepted. */
  claimedBy: AccountId;
  claimedAt: string;
  /** The moderator/admin who recorded the claim — never the bounty's own opener or the claimant. */
  resolvedBy: AccountId;
}

export interface CancelledBounty extends BountyFields {
  status: "cancelled";
  cancelledAt: string;
  /** The bounty's own opener, or a moderator/admin — see ADR 0009. */
  cancelledBy: AccountId;
  cancellationReason: string;
}

export type Bounty = OpenBounty | ClaimedBounty | CancelledBounty;

export type BountySubmissionOutcome = "pending" | "accepted" | "rejected";

export interface BountySubmission {
  /** Random UUID. */
  id: string;
  bountyId: string;
  submittedBy: AccountId;
  /** A real PR URL — never fetched server-side (SSRF risk); a moderator checks it before claiming. */
  prUrl: string;
  /** Optional context for the moderator. Empty string, never omitted. */
  note: string;
  submittedAt: string;
  outcome: BountySubmissionOutcome;
}

export type BountyErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_bounty"
  | "invalid_submission"
  | "not_found"
  | "not_open"
  | "already_resolved";

/** Same convention as `@osstrace/accounts` and `@osstrace/community-labels`: expected failures are values, never thrown. */
export type BountyResult<T> = ({ ok: true } & T) | { ok: false; error: BountyErrorCode; message: string };
