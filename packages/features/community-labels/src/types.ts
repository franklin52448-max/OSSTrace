import type { AccountId, Address, Confidence, Source, SubmittedLabel } from "@opentrace/core";

/**
 * The submission data model. See docs/adr/0007-community-label-submissions-and-review.md.
 *
 * A *submission* is the moderation record; a *label* (`CommunityLabel` / `ConfirmedLabel` in
 * `@opentrace/core`) is what the public sees. They differ in one way that matters: a submission
 * can be `rejected`, and a rejected submission never becomes a label anywhere — it's kept only so
 * its submitter can see why, and so the decision is auditable.
 */
export type SubmissionStatus = "community" | "confirmed" | "rejected";

interface SubmissionFields {
  /** Random UUID. */
  id: string;
  address: Address;
  name: string;
  confidence: Confidence;
  /** Required, exactly as on every other label (ADR 0002). `addedAt` is the submission date. */
  source: Source;
  /** The submitter's account id — never their email (ADR 0006). */
  submittedBy: AccountId;
  /** ISO 8601 timestamp. */
  submittedAt: string;
}

export interface PendingSubmission extends SubmissionFields {
  status: "community";
}

export interface ConfirmedSubmission extends SubmissionFields {
  status: "confirmed";
  reviewedBy: AccountId;
  reviewedAt: string;
}

export interface RejectedSubmission extends SubmissionFields {
  status: "rejected";
  reviewedBy: AccountId;
  reviewedAt: string;
  /** Shown to the submitter. Required: a rejection with no reason teaches nobody anything. */
  rejectionReason: string;
}

export type Submission = PendingSubmission | ConfirmedSubmission | RejectedSubmission;

/** What the public label lookup shows for a submission — `null` for a rejected one. */
export function submissionToLabel(submission: Submission): SubmittedLabel | null {
  const base = {
    address: submission.address,
    name: submission.name,
    confidence: submission.confidence,
    source: submission.source,
    submissionId: submission.id,
    submittedBy: submission.submittedBy,
    submittedAt: submission.submittedAt,
  };
  switch (submission.status) {
    case "community":
      return { ...base, reviewStatus: "community" };
    case "confirmed":
      return { ...base, reviewStatus: "confirmed", confirmedBy: submission.reviewedBy, confirmedAt: submission.reviewedAt };
    case "rejected":
      return null;
  }
}

export type SubmissionErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_submission"
  | "duplicate_submission"
  | "not_found"
  | "already_reviewed"
  | "own_submission";

/** Same convention as `@opentrace/accounts`: expected failures are values, never thrown. */
export type SubmissionResult<T> = ({ ok: true } & T) | { ok: false; error: SubmissionErrorCode; message: string };
