import { randomUUID } from "node:crypto";
// Type-only, same reasoning as @osstrace/community-labels: a reader of the public board shouldn't
// load the accounts runtime just by importing us.
import type { AccountService, AuthResult, PublicUser } from "@osstrace/accounts";
import { roleAtLeast } from "@osstrace/accounts";
import type { BountyStore } from "./store.ts";
import type { Bounty, BountyResult, BountyStatus, BountySubmission, OpenBounty } from "./types.ts";
import { parseBountyInput, parseCancellationReason, parseSubmissionInput } from "./validate.ts";

export interface BountyServiceOptions {
  /** Injectable clock, so tests can pin timestamps through the real code path. */
  now?: () => Date;
}

type Actor = BountyResult<{ user: PublicUser }>;

function fromAuth(auth: AuthResult<{ user: PublicUser }>): Actor {
  if (auth.ok) return auth;
  return auth.error === "forbidden" ? { ok: false, error: "forbidden", message: auth.message } : { ok: false, error: "unauthenticated", message: auth.message };
}

/**
 * The bounty board (ADR 0009): any logged-in user can open a bounty (a spec + their own free-text
 * reward claim) or submit a PR against one; a moderator records which submission wins; the
 * opener, or a moderator, can cancel an unclaimed bounty. This system never holds or moves the
 * reward itself — see the ADR for why that's a deliberate v1 scope decision, not an oversight.
 */
export class BountyService {
  readonly #store: BountyStore;
  readonly #accounts: AccountService;
  readonly #now: () => Date;

  constructor(store: BountyStore, accounts: AccountService, options: BountyServiceOptions = {}) {
    this.#store = store;
    this.#accounts = accounts;
    this.#now = options.now ?? (() => new Date());
  }

  async open(token: string | null | undefined, body: Record<string, unknown>): Promise<BountyResult<{ bounty: Bounty }>> {
    const actor = fromAuth(await this.#accounts.authenticate(token));
    if (!actor.ok) return actor;
    const input = parseBountyInput(body);
    if (!input.ok) return { ok: false, error: "invalid_bounty", message: input.message };

    const bounty: OpenBounty = {
      id: randomUUID(),
      status: "open",
      title: input.value.title,
      description: input.value.description,
      reward: input.value.reward,
      openedBy: actor.user.id,
      openedAt: this.#now().toISOString(),
    };
    await this.#store.createBounty(bounty);
    return { ok: true, bounty };
  }

  /** Public — no login needed to browse the board. Newest first. */
  async list(status: unknown): Promise<BountyResult<{ bounties: Bounty[] }>> {
    if (status !== undefined && status !== "open" && status !== "claimed" && status !== "cancelled") {
      return { ok: false, error: "invalid_bounty", message: 'status must be "open", "claimed" or "cancelled"' };
    }
    const filter = status === undefined ? {} : { status: status as BountyStatus };
    const bounties = await this.#store.listBounties(filter);
    return { ok: true, bounties: bounties.slice().reverse() };
  }

  async get(id: string): Promise<BountyResult<{ bounty: Bounty }>> {
    const bounty = await this.#store.getBounty(id);
    if (!bounty) return { ok: false, error: "not_found", message: "no such bounty" };
    return { ok: true, bounty };
  }

  /** Public, same reasoning as `list` — a PR link submitted against a public bounty is not private. */
  async listSubmissions(bountyId: string): Promise<BountyResult<{ submissions: BountySubmission[] }>> {
    const bounty = await this.#store.getBounty(bountyId);
    if (!bounty) return { ok: false, error: "not_found", message: "no such bounty" };
    const submissions = await this.#store.listSubmissions(bountyId);
    return { ok: true, submissions: submissions.slice().reverse() };
  }

  async submit(token: string | null | undefined, bountyId: string, body: Record<string, unknown>): Promise<BountyResult<{ submission: BountySubmission }>> {
    const actor = fromAuth(await this.#accounts.authenticate(token));
    if (!actor.ok) return actor;
    const bounty = await this.#store.getBounty(bountyId);
    if (!bounty) return { ok: false, error: "not_found", message: "no such bounty" };
    if (bounty.status !== "open") return { ok: false, error: "not_open", message: `this bounty is ${bounty.status}, not open` };
    const input = parseSubmissionInput(body);
    if (!input.ok) return { ok: false, error: "invalid_submission", message: input.message };

    const submission: BountySubmission = {
      id: randomUUID(),
      bountyId,
      submittedBy: actor.user.id,
      prUrl: input.value.prUrl,
      note: input.value.note,
      submittedAt: this.#now().toISOString(),
      outcome: "pending",
    };
    await this.#store.createSubmission(submission);
    return { ok: true, submission };
  }

  /** `requireRole(token, "moderator")` and nothing more, same pattern ADR 0007 uses for label review. */
  async claim(token: string | null | undefined, bountyId: string, submissionId: unknown): Promise<BountyResult<{ bounty: Bounty }>> {
    const actor = fromAuth(await this.#accounts.requireRole(token, "moderator"));
    if (!actor.ok) return actor;
    if (typeof submissionId !== "string" || !submissionId) {
      return { ok: false, error: "invalid_submission", message: "submissionId is required" };
    }
    const outcome = await this.#store.claim(bountyId, submissionId, { claimedAt: this.#now().toISOString(), resolvedBy: actor.user.id });
    if (outcome.ok) return { ok: true, bounty: outcome.bounty };
    switch (outcome.reason) {
      case "bounty_not_found":
        return { ok: false, error: "not_found", message: "no such bounty" };
      case "not_open":
        return { ok: false, error: "not_open", message: "this bounty is no longer open" };
      case "submission_not_found":
        return { ok: false, error: "invalid_submission", message: "no such submission on this bounty" };
    }
  }

  /** The bounty's own opener, or a moderator/admin — see ADR 0009 for why not the opener alone with no role involved at all. */
  async cancel(token: string | null | undefined, bountyId: string, reason: unknown): Promise<BountyResult<{ bounty: Bounty }>> {
    const actor = fromAuth(await this.#accounts.authenticate(token));
    if (!actor.ok) return actor;
    const bounty = await this.#store.getBounty(bountyId);
    if (!bounty) return { ok: false, error: "not_found", message: "no such bounty" };
    if (bounty.openedBy !== actor.user.id && !roleAtLeast(actor.user.role, "moderator")) {
      return { ok: false, error: "forbidden", message: "only the bounty's opener or a moderator can cancel it" };
    }
    const parsed = parseCancellationReason(reason);
    if (!parsed.ok) return { ok: false, error: "invalid_bounty", message: parsed.message };

    const outcome = await this.#store.cancel(bountyId, { cancelledBy: actor.user.id, cancelledAt: this.#now().toISOString(), cancellationReason: parsed.value });
    if (outcome.ok) return { ok: true, bounty: outcome.bounty };
    return outcome.reason === "not_found" ? { ok: false, error: "not_found", message: "no such bounty" } : { ok: false, error: "not_open", message: "this bounty is no longer open" };
  }
}
