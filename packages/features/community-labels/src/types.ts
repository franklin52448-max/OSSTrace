import type { AccountId, Address, Confidence, SelfAttestation, Source, SubmittedLabel } from "@osstrace/core";

/**
 * The submission data model. See docs/adr/0007-community-label-submissions-and-review.md and,
 * for `self-attested`, docs/adr/0019-self-attested-labels.md.
 *
 * A *submission* is the moderation record; a *label* (`CommunityLabel` / `ConfirmedLabel` /
 * `SelfAttestedLabel` in `@osstrace/core`) is what the public sees. They differ in one way that
 * matters: a submission can be `rejected`, and a rejected submission never becomes a label
 * anywhere — it's kept only so its submitter can see why, and so the decision is auditable.
 */
export type SubmissionStatus = "community" | "confirmed" | "rejected" | "self-attested";

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
  /** Kept when a self-attested submission is rejected, so the decision stays auditable. */
  attestation?: SelfAttestation;
}

/**
 * Public as soon as the server has checked the signature (ADR 0019). Not "pending": there's no
 * source for a moderator to confirm, since the signature is the evidence. A moderator can still
 * reject it (an impersonation, say), which takes it out of public view like any rejection.
 */
export interface SelfAttestedSubmission extends SubmissionFields {
  status: "self-attested";
  attestation: SelfAttestation;
}

export type Submission = PendingSubmission | ConfirmedSubmission | RejectedSubmission | SelfAttestedSubmission;

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
    case "self-attested":
      return { ...base, reviewStatus: "self-attested", attestation: submission.attestation };
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
  | "own_submission"
  /** Too many submissions from this account in the rate-limit window (ADR 0017). HTTP 429. */
  | "rate_limited"
  /** A self-attestation whose challenge is unknown/expired/used, or whose signature doesn't verify (ADR 0019). */
  | "invalid_attestation"
  /** "Confirm" on a self-attested submission: there's no cited source to confirm; it can only be rejected. */
  | "not_confirmable";

/**
 * Same convention as `@osstrace/accounts`: expected failures are values, never thrown.
 * `retryAfterSeconds` is set only on `rate_limited`: how long until the account can submit again.
 */
export type SubmissionResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: SubmissionErrorCode; message: string; retryAfterSeconds?: number };
