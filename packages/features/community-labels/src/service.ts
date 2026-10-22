import { randomUUID } from "node:crypto";
// Type-only: this package never constructs accounts itself (bootstrap.ts does, for the server), so
// a reader of community labels (the Explorer) doesn't load the accounts runtime just by importing us.
import type { AccountService, AuthResult, PublicUser } from "@osstrace/accounts";
import { draftFromPrivateLabel, type PrivateLabelLookup, type PrivateLabelSnapshot, type ShareDraft } from "./share.ts";
import type { SubmissionStore } from "./store.ts";
import type { PendingSubmission, Submission, SubmissionResult } from "./types.ts";
import { parseRejectionReason, parseSubmissionInput } from "./validate.ts";

export interface LabelSubmissionServiceOptions {
  /** Injectable clock, so tests can pin timestamps through the real code path. */
  now?: () => Date;
  /**
   * Read access to the caller's own private labels, for "share as Community label" (ADR 0017).
   * Without it the two share methods answer `not_found`; everything else works the same.
   */
  privateLabels?: PrivateLabelLookup;
}

type Actor = SubmissionResult<{ user: PublicUser }>;

function fromAuth(auth: AuthResult<{ user: PublicUser }>): Actor {
  if (auth.ok) return auth;
  // authenticate/requireRole only ever fail as "unauthenticated" or "forbidden".
  return auth.error === "forbidden"
    ? { ok: false, error: "forbidden", message: auth.message }
    : { ok: false, error: "unauthenticated", message: auth.message };
}

/**
 * The community label pipeline (ADR 0004 tiers 1–2, ADR 0007):
 *
 * - any logged-in user can **submit** a label for an address, with a required cited source;
 * - it's public immediately, as a `community` (unreviewed) label;
 * - a `moderator` (or admin) **confirms** it — it becomes a `confirmed` label — or **rejects** it
 *   with a reason, which removes it from public view.
 *
 * Identity and roles come entirely from `@osstrace/accounts` (`authenticate` / `requireRole`),
 * re-checked on every call, so a demoted moderator loses review rights on their next request.
 * Who did what is recorded by account id, never email.
 */
export class LabelSubmissionService {
  readonly #store: SubmissionStore;
  readonly #accounts: AccountService;
  readonly #now: () => Date;
  readonly #privateLabels: PrivateLabelLookup | null;

  constructor(store: SubmissionStore, accounts: AccountService, options: LabelSubmissionServiceOptions = {}) {
    this.#store = store;
    this.#accounts = accounts;
    this.#now = options.now ?? (() => new Date());
    this.#privateLabels = options.privateLabels ?? null;
  }

  async submit(token: string | null | undefined, body: Record<string, unknown>): Promise<SubmissionResult<{ submission: Submission }>> {
    const actor = fromAuth(await this.#accounts.authenticate(token));
    if (!actor.ok) return actor;
    return this.#createPending(actor.user, body);
  }

  /**
   * The pre-filled starting point for sharing the caller's own private label for this address as
   * a Community submission: its text as the name, and no confidence or source (a private label has
   * neither, so the submitter must supply them). Nothing is written.
   */
  async shareDraft(token: string | null | undefined, chain: unknown, address: unknown): Promise<SubmissionResult<{ draft: ShareDraft }>> {
    const found = await this.#ownPrivateLabel(token, chain, address);
    if (!found.ok) return found;
    return { ok: true, draft: draftFromPrivateLabel(found.label) };
  }

  /**
   * "Share as Community label": submits the caller's own private label for `body.chain` +
   * `body.address` as a new, independent Community submission. `body.name` overrides the private
   * label's text (the user edited the pre-filled name); if absent, the text is used as-is.
   * `body.confidence` and `body.source` are required and validated exactly like any submission:
   * this is `submit` with a pre-filled name, not a way around ADR 0002.
   *
   * The private label is only *read*, never changed or removed, and nothing links the two
   * afterwards: whatever later happens to the submission (confirmed, rejected) doesn't touch it.
   */
  async shareFromPrivateLabel(token: string | null | undefined, body: Record<string, unknown>): Promise<SubmissionResult<{ submission: Submission }>> {
    const found = await this.#ownPrivateLabel(token, body["chain"], body["address"]);
    if (!found.ok) return found;
    return this.#createPending(found.user, {
      chain: body["chain"],
      address: body["address"],
      name: body["name"] === undefined ? found.label.label : body["name"],
      confidence: body["confidence"],
      source: body["source"],
    });
  }

  async #ownPrivateLabel(
    token: string | null | undefined,
    chain: unknown,
    address: unknown,
  ): Promise<SubmissionResult<{ user: PublicUser; label: PrivateLabelSnapshot }>> {
    const actor = fromAuth(await this.#accounts.authenticate(token));
    if (!actor.ok) return actor;
    if (!this.#privateLabels) {
      return { ok: false, error: "not_found", message: "sharing private labels isn't enabled on this server" };
    }
    // Owner-scoped by the same token: this can only ever return the caller's own private label.
    const lookup = await this.#privateLabels.get(token, chain, address);
    if (!lookup.ok) {
      return lookup.error === "unauthenticated"
        ? { ok: false, error: "unauthenticated", message: lookup.message }
        : { ok: false, error: "invalid_submission", message: lookup.message };
    }
    if (!lookup.label) return { ok: false, error: "not_found", message: "you have no private label for that address" };
    return { ok: true, user: actor.user, label: lookup.label };
  }

  /** The one path that writes a `community` submission, shared by `submit` and `shareFromPrivateLabel`. */
  async #createPending(user: PublicUser, body: Record<string, unknown>): Promise<SubmissionResult<{ submission: Submission }>> {
    const input = parseSubmissionInput(body);
    if (!input.ok) return { ok: false, error: "invalid_submission", message: input.message };

    const now = this.#now();
    const submission: PendingSubmission = {
      id: randomUUID(),
      status: "community",
      address: input.value.address,
      name: input.value.name,
      confidence: input.value.confidence,
      source: {
        description: input.value.source.description,
        url: input.value.source.url,
        // Source.addedAt is "the date this entry was added" — for a submission, the day it was submitted.
        addedAt: now.toISOString().slice(0, 10),
      },
      submittedBy: user.id,
      submittedAt: now.toISOString(),
    };
    const created = await this.#store.create(submission);
    if (!created.ok) {
      return {
        ok: false,
        error: "duplicate_submission",
        message: "you already have a pending submission for this address — wait for it to be reviewed",
      };
    }
    return { ok: true, submission };
  }

  /** The caller's own submissions, any status, newest first — so a submitter can see a rejection reason. */
  async listMine(token: string | null | undefined): Promise<SubmissionResult<{ submissions: Submission[] }>> {
    const actor = fromAuth(await this.#accounts.authenticate(token));
    if (!actor.ok) return actor;
    const mine = await this.#store.list({ submittedBy: actor.user.id });
    return { ok: true, submissions: mine.reverse() };
  }

  /** Moderator view. Default `community` = the review queue, oldest first (first in, first reviewed). */
  async listForReview(token: string | null | undefined, status: unknown = "community"): Promise<SubmissionResult<{ submissions: Submission[] }>> {
    const actor = fromAuth(await this.#accounts.requireRole(token, "moderator"));
    if (!actor.ok) return actor;
    if (status !== "community" && status !== "confirmed" && status !== "rejected") {
      return { ok: false, error: "invalid_submission", message: 'status must be "community", "confirmed" or "rejected"' };
    }
    return { ok: true, submissions: await this.#store.list({ status }) };
  }

  /** `requireRole(token, "moderator")` and nothing more, per ADR 0006 — plus "not your own submission". */
  async confirm(token: string | null | undefined, id: string): Promise<SubmissionResult<{ submission: Submission }>> {
    const actor = fromAuth(await this.#accounts.requireRole(token, "moderator"));
    if (!actor.ok) return actor;
    return this.#review(id, { status: "confirmed", reviewedBy: actor.user.id, reviewedAt: this.#now().toISOString() });
  }

  async reject(token: string | null | undefined, id: string, reason: unknown): Promise<SubmissionResult<{ submission: Submission }>> {
    const actor = fromAuth(await this.#accounts.requireRole(token, "moderator"));
    if (!actor.ok) return actor;
    const parsed = parseRejectionReason(reason);
    if (!parsed.ok) return { ok: false, error: "invalid_submission", message: parsed.message };
    return this.#review(id, {
      status: "rejected",
      reviewedBy: actor.user.id,
      reviewedAt: this.#now().toISOString(),
      rejectionReason: parsed.value,
    });
  }

  async #review(
    id: string,
    decision: Parameters<SubmissionStore["review"]>[1],
  ): Promise<SubmissionResult<{ submission: Submission }>> {
    const outcome = await this.#store.review(id, decision);
    if (outcome.ok) return { ok: true, submission: outcome.submission };
    switch (outcome.reason) {
      case "not_found":
        return { ok: false, error: "not_found", message: "no such submission" };
      case "already_reviewed":
        return { ok: false, error: "already_reviewed", message: `this submission was already ${outcome.submission?.status}` };
      case "own_submission":
        return { ok: false, error: "own_submission", message: "a moderator can't review their own submission — another moderator must" };
    }
  }
}
