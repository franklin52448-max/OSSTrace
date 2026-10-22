import type { ChainId } from "@osstrace/core";

/**
 * "Share as Community label" (ADR 0017): turning one of your own private labels (ADR 0004,
 * `@osstrace/private-labels`) into a public Community submission.
 *
 * A private label never needed a source, so its text can't become a public claim as-is. Sharing
 * only uses it as the *starting point* of a submission: the name is pre-filled, and the submitter
 * still has to supply a real cited source and a confidence, validated by exactly the same
 * `parseSubmissionInput` every other submission goes through (ADR 0002).
 */

/** The fields of a private label sharing needs. `PrivateLabel` from `@osstrace/private-labels` fits as-is. */
export interface PrivateLabelSnapshot {
  chain: ChainId;
  address: string;
  label: string;
}

/**
 * The only thing sharing needs from private labels: "what is *the caller's own* label for this
 * address?", answered by the caller's session token. `PrivateLabelService` satisfies it as-is.
 *
 * Deliberately read-only — there is no set or delete here — so this package structurally *can't*
 * modify or remove the private label it shares from. Sharing creates an independent submission;
 * the private label stays exactly as it was, whatever later happens to the submission.
 */
export interface PrivateLabelLookup {
  get(
    token: string | null | undefined,
    chain: unknown,
    address: unknown,
  ): Promise<{ ok: true; label: PrivateLabelSnapshot | null } | { ok: false; error: string; message: string }>;
}

/**
 * What the submission form is pre-filled with. Only the name comes from the private label;
 * `confidence` and `source` are deliberately empty — the submitter has to supply them, because a
 * private note has neither.
 */
export interface ShareDraft {
  chain: ChainId;
  address: string;
  name: string;
  confidence: null;
  source: null;
}

export function draftFromPrivateLabel(label: PrivateLabelSnapshot): ShareDraft {
  return { chain: label.chain, address: label.address, name: label.label, confidence: null, source: null };
}
