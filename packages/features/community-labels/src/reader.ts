import type { Address, Entity, LabelReader, SubmittedLabel, Tag } from "@opentrace/core";
import type { SubmissionStore } from "./store.ts";
import { submissionToLabel, type ConfirmedSubmission, type PendingSubmission } from "./types.ts";

/**
 * Exposes community submissions to the label lookup (Explorer, Visualizer) as a read-only
 * `LabelReader`, plugged into `CompositeLabelStore` *after* every ingested dataset — so an
 * official source's label (a sanctions designation, say) always takes precedence over a
 * community one for the same address.
 *
 * The core model shows at most one Label per address. When several non-rejected submissions exist
 * for one address, this picks:
 *   1. the most recently **confirmed** one, else
 *   2. the most recently submitted **community** (unreviewed) one.
 * Rejected submissions are never shown. There's deliberately no `addLabel`: a community label can
 * only come into existence through `LabelSubmissionService.submit`.
 */
export class CommunityLabelReader implements LabelReader {
  readonly #store: SubmissionStore;

  constructor(store: SubmissionStore) {
    this.#store = store;
  }

  async getLabel(address: Address): Promise<SubmittedLabel | null> {
    const forAddress = await this.#store.list({ address });
    const confirmed = forAddress
      .filter((s): s is ConfirmedSubmission => s.status === "confirmed")
      .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0];
    if (confirmed) return submissionToLabel(confirmed);
    const pending = forAddress
      .filter((s): s is PendingSubmission => s.status === "community")
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    return pending ? submissionToLabel(pending) : null;
  }

  /** Community submissions are labels only; tags still come only from ingested sources. */
  async getTags(_address: Address): Promise<Tag[]> {
    return [];
  }

  async getEntity(_address: Address): Promise<Entity | null> {
    return null;
  }
}
