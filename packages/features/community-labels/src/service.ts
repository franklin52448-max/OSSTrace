import { randomUUID } from "node:crypto";
// Type-only: this package never constructs accounts itself (bootstrap.ts does, for the server), so
// a reader of community labels (the Explorer) doesn't load the accounts runtime just by importing us.
import type { AccountService, AuthResult, PublicUser } from "@osstrace/accounts";
import { draftFromPrivateLabel, type PrivateLabelLookup, type PrivateLabelSnapshot, type ShareDraft } from "./share.ts";
import type { AttestationScheme } from "@osstrace/core";
import { ChallengeBook, schemeFor, verifySelfAttestation } from "./selfAttestation.ts";
import type { CreateRateLimit, SubmissionStore } from "./store.ts";
import type { PendingSubmission, SelfAttestedSubmission, Submission, SubmissionResult } from "./types.ts";
import { parseLabelName, parseRejectionReason, parseSubmissionInput, parseTarget } from "./validate.ts";

/** The methodology a self-attested label's `source.url` cites (ADR 0002: every label cites one). */
export const SELF_ATTESTATION_METHODOLOGY_URL =
  "https://github.com/OpenTraceIntelligence/OSSTrace/blob/main/docs/adr/0019-self-attested-labels.md";

export interface LabelSubmissionServiceOptions {
  /** Injectable clock, so tests can pin timestamps through the real code path. */
  now?: () => Date;
  /**
   * Read access to the caller's own private labels, for "share as Community label" (ADR 0017).
   * Without it the two share methods answer `not_found`; everything else works the same.
   */
  privateLabels?: PrivateLabelLookup;
  /** Overrides `SUBMISSION_RATE_LIMIT` (e.g. a deployment that wants it stricter). */
  rateLimit?: SubmissionRateLimit;
  /**
   * Who is asking for the signature, named on the first line of every self-attestation statement
   * (like a Sign-In with Ethereum domain), so a person can see which site they're signing for.
   * Defaults to "OSSTrace".
   */
  attestationDomain?: string;
}

export interface SubmissionRateLimit {
  /** Submissions one account may create per window. */
  max: number;
  /** Rolling window length, in milliseconds. */
  windowMs: number;
}

/**
 * At most 10 submissions per account in any rolling hour (ADR 0017). Each real submission needs a
 * public source found and described, so a careful contributor rarely gets near one every six
 * minutes; a script spamming the moderation queue hits it at once. Counted from the submissions
 * store itself (every status, including later-rejected ones), so it survives a restart.
 */
export const SUBMISSION_RATE_LIMIT: SubmissionRateLimit = { max: 10, windowMs: 60 * 60 * 1000 };

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
  readonly #rateLimit: SubmissionRateLimit;
  readonly #attestationDomain: string;
  readonly #challenges = new ChallengeBook();

  constructor(store: SubmissionStore, accounts: AccountService, options: LabelSubmissionServiceOptions = {}) {
    this.#store = store;
    this.#accounts = accounts;
    this.#now = options.now ?? (() => new Date());
    this.#privateLabels = options.privateLabels ?? null;
    this.#rateLimit = options.rateLimit ?? SUBMISSION_RATE_LIMIT;
    this.#attestationDomain = options.attestationDomain ?? "OSSTrace";
  }

  /** The store-level limit for a create happening at `now`: `max` since `now - windowMs`. */
  #limitAt(now: Date): CreateRateLimit {
    return { max: this.#rateLimit.max, since: new Date(now.getTime() - this.#rateLimit.windowMs).toISOString() };
  }

  /** The 429-equivalent: when the next slot frees up, in whole seconds (at least 1). */
  #rateLimited(now: Date, oldestInWindow: string): { ok: false; error: "rate_limited"; message: string; retryAfterSeconds: number } {
    const freesAtMs = Date.parse(oldestInWindow) + this.#rateLimit.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((freesAtMs - now.getTime()) / 1000));
    const minutes = Math.ceil(retryAfterSeconds / 60);
    return {
      ok: false,
      error: "rate_limited",
      message: `you've made ${this.#rateLimit.max} submissions in the last ${Math.round(this.#rateLimit.windowMs / 60_000)} minutes, the most allowed — try again in ${minutes} minute${minutes === 1 ? "" : "s"}`,
      retryAfterSeconds,
    };
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
    // The rate limit is checked inside the store's write lock, against what's actually stored.
    const created = await this.#store.create(submission, this.#limitAt(now));
    if (!created.ok) {
      if (created.reason === "rate_limited") return this.#rateLimited(now, created.oldestInWindow);
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
    if (status !== "community" && status !== "confirmed" && status !== "rejected" && status !== "self-attested") {
      return { ok: false, error: "invalid_submission", message: 'status must be "community", "confirmed", "rejected" or "self-attested"' };
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
      case "not_confirmable":
        return {
          ok: false,
          error: "not_confirmable",
          message: "a self-attested label has no cited source to confirm (its signature was already checked) — it can only be rejected",
        };
    }
  }

  /**
   * Step 1 of a self-attestation (ADR 0019): the caller names the address they control and the
   * label they want on it, and gets back the exact statement to sign with that address's key,
   * bound to their account and a one-time nonce that expires in `CHALLENGE_TTL_MS`.
   */
  async requestSelfAttestation(
    token: string | null | undefined,
    body: Record<string, unknown>,
  ): Promise<SubmissionResult<{ challenge: { nonce: string; scheme: AttestationScheme; message: string; expiresAt: string } }>> {
    const actor = fromAuth(await this.#accounts.authenticate(token));
    if (!actor.ok) return actor;
    const target = parseTarget(body);
    if (!target.ok) return { ok: false, error: "invalid_submission", message: target.message };
    const name = parseLabelName(body["name"]);
    if (!name.ok) return { ok: false, error: "invalid_submission", message: name.message };
    const challenge = this.#challenges.issue(
      { domain: this.#attestationDomain, chain: target.value.chain, address: target.value.value, name: name.value, accountId: actor.user.id },
      this.#now(),
    );
    return {
      ok: true,
      challenge: { nonce: challenge.nonce, scheme: schemeFor(challenge.chain), message: challenge.message, expiresAt: challenge.expiresAt },
    };
  }

  /**
   * Step 2: the caller returns the nonce and the wallet's signature over the challenge message.
   * The message checked is the one the server issued, never one the client sends. The nonce is
   * used up by this call whatever the outcome. On a valid signature the label is public at once as
   * `self-attested`; it counts toward the submission rate limit like any submission.
   */
  async submitSelfAttestation(token: string | null | undefined, body: Record<string, unknown>): Promise<SubmissionResult<{ submission: Submission }>> {
    const actor = fromAuth(await this.#accounts.authenticate(token));
    if (!actor.ok) return actor;
    const now = this.#now();
    const redeemed = this.#challenges.redeem(body["nonce"], actor.user.id, now);
    if (!redeemed.ok) {
      return {
        ok: false,
        error: "invalid_attestation",
        message:
          redeemed.reason === "expired"
            ? "that challenge has expired — request a new one and sign it"
            : "unknown or already-used challenge — request a new one and sign it",
      };
    }
    const { challenge } = redeemed;
    const signature = typeof body["signature"] === "string" ? body["signature"].trim() : "";
    if (!verifySelfAttestation(challenge.chain, challenge.address, challenge.message, signature)) {
      return {
        ok: false,
        error: "invalid_attestation",
        message: `the signature isn't a valid ${schemeFor(challenge.chain)} signature of the challenge by ${challenge.address}`,
      };
    }

    const scheme = schemeFor(challenge.chain);
    const submission: SelfAttestedSubmission = {
      id: randomUUID(),
      status: "self-attested",
      address: { chain: challenge.chain, value: challenge.address },
      name: challenge.name,
      // The source (the owner's own signed statement) states the claim outright.
      confidence: "verified",
      source: {
        description:
          scheme === "eip191-personal-sign"
            ? "Signed by this address's own key (EIP-191 personal_sign) and verified by OSSTrace when submitted. The signed statement and signature are attached to this label so anyone can re-check them. Proves control of the address, not that the label is true."
            : "Signed by this address's own key (Ed25519 message signature) and verified by OSSTrace when submitted. The signed statement and signature are attached to this label so anyone can re-check them. Proves control of the address, not that the label is true.",
        url: SELF_ATTESTATION_METHODOLOGY_URL,
        addedAt: now.toISOString().slice(0, 10),
      },
      submittedBy: actor.user.id,
      submittedAt: now.toISOString(),
      attestation: { scheme, message: challenge.message, signature },
    };
    const created = await this.#store.create(submission, this.#limitAt(now));
    if (!created.ok) {
      // Self-attestations aren't subject to the one-pending-per-address rule, so this is the rate limit.
      return created.reason === "rate_limited"
        ? this.#rateLimited(now, created.oldestInWindow)
        : { ok: false, error: "duplicate_submission", message: "duplicate submission" };
    }
    return { ok: true, submission };
  }
}
