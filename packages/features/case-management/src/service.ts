import { randomUUID } from "node:crypto";
// Type-only, same reasoning as @osstrace/private-labels and @osstrace/bounties: importing this
// package doesn't load the accounts runtime; the server wires a real AccountService in.
import type { AuthResult, PublicUser } from "@osstrace/accounts";
import type { CaseChange, CaseStore } from "./store.ts";
import {
  toCaseItemView,
  toCaseView,
  type Case,
  type CaseItemView,
  type CaseResult,
  type CaseStatus,
  type CaseView,
} from "./types.ts";
import { parseCaseDetailsPatch, parseCaseInput, parseChainAddress, parseNote } from "./validate.ts";

/**
 * The only thing this package needs from accounts: "whose session is this?". `AccountService`
 * from `@osstrace/accounts` satisfies it as-is. Deliberately *not* `requireRole`: no role grants
 * any power over someone else's case (ADR 0011 §3), so this package never asks for one.
 */
export interface Authenticator {
  authenticate(token: string | null | undefined): Promise<AuthResult<{ user: PublicUser }>>;
}

export interface CaseServiceOptions {
  /** Injectable clock, so tests can pin timestamps through the real code path. */
  now?: () => Date;
}

/** A case in the owner's list: the case plus how many items it holds. */
export type CaseSummary = CaseView & { itemCount: number };

const NOT_FOUND = { ok: false, error: "not_found", message: "no such case" } as const;
const ITEM_NOT_FOUND = { ok: false, error: "not_found", message: "no such item in this case" } as const;
const CLOSED = { ok: false, error: "case_closed", message: "this case is closed — reopen it to change it" } as const;

/**
 * Case management (ADR 0011): a logged-in user's own private investigation records.
 *
 * **Every operation is owner-scoped.** The owner is always the user the bearer token
 * authenticates as; there is no parameter anywhere — not here, not in the HTTP layer — through
 * which a caller can name a different owner, and no role (moderator, admin) unlocks anyone else's
 * case. A case id that isn't yours behaves exactly like one that doesn't exist (`not_found`).
 *
 * Authentication is always checked first, so an anonymous caller learns nothing — not even
 * whether their input was well-formed.
 */
export class CaseService {
  readonly #auth: Authenticator;
  readonly #store: CaseStore;
  readonly #now: () => Date;

  constructor(auth: Authenticator, store: CaseStore, options: CaseServiceOptions = {}) {
    this.#auth = auth;
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  async #owner(token: string | null | undefined): Promise<CaseResult<{ ownerId: string }>> {
    const me = await this.#auth.authenticate(token);
    if (!me.ok) return { ok: false, error: "unauthenticated", message: me.message };
    return { ok: true, ownerId: me.user.id };
  }

  /** The caller's own case, or `not_found` — for a missing case and someone else's alike. */
  async #ownCase(token: string | null | undefined, caseId: unknown): Promise<CaseResult<{ ownerId: string; case: Case }>> {
    const owner = await this.#owner(token);
    if (!owner.ok) return owner;
    if (typeof caseId !== "string" || caseId.length === 0) return NOT_FOUND;
    const found = await this.#store.getCase(owner.ownerId, caseId);
    if (!found) return NOT_FOUND;
    return { ok: true, ownerId: owner.ownerId, case: found };
  }

  async create(token: string | null | undefined, body: Record<string, unknown>): Promise<CaseResult<{ case: CaseView }>> {
    const owner = await this.#owner(token);
    if (!owner.ok) return owner;
    const input = parseCaseInput(body);
    if (!input.ok) return { ok: false, error: "invalid_case", message: input.message };

    const at = this.#now().toISOString();
    const outcome = await this.#store.createCase(owner.ownerId, {
      id: randomUUID(),
      title: input.value.title,
      description: input.value.description,
      ownedBy: owner.ownerId,
      status: "open",
      createdAt: at,
      updatedAt: at,
      closedAt: null,
    });
    if (!outcome.ok) {
      return { ok: false, error: "limit_reached", message: "you already have the maximum number of cases — delete one first" };
    }
    return { ok: true, case: toCaseView(outcome.case) };
  }

  /** Your own cases, most recently updated first, optionally only `open` or only `closed`. */
  async list(token: string | null | undefined, status: unknown): Promise<CaseResult<{ cases: CaseSummary[] }>> {
    const owner = await this.#owner(token);
    if (!owner.ok) return owner;
    if (status !== undefined && status !== "open" && status !== "closed") {
      return { ok: false, error: "invalid_case", message: 'status must be "open" or "closed"' };
    }
    const filter = status === undefined ? {} : { status: status as CaseStatus };
    const [cases, counts] = await Promise.all([this.#store.listCases(owner.ownerId, filter), this.#store.countItems(owner.ownerId)]);
    return { ok: true, cases: cases.map((c) => ({ ...toCaseView(c), itemCount: counts.get(c.id) ?? 0 })) };
  }

  /** One of your cases with all its items (in the order they were added). */
  async get(token: string | null | undefined, caseId: unknown): Promise<CaseResult<{ case: CaseView; items: CaseItemView[] }>> {
    const own = await this.#ownCase(token, caseId);
    if (!own.ok) return own;
    const items = await this.#store.listItems(own.ownerId, own.case.id);
    return { ok: true, case: toCaseView(own.case), items: items.map(toCaseItemView) };
  }

  /** Edit the title and/or description. Refused while the case is closed. */
  async update(token: string | null | undefined, caseId: unknown, body: Record<string, unknown>): Promise<CaseResult<{ case: CaseView }>> {
    const own = await this.#ownCase(token, caseId);
    if (!own.ok) return own;
    const patch = parseCaseDetailsPatch(body);
    if (!patch.ok) return { ok: false, error: "invalid_case", message: patch.message };
    return this.#change(own.ownerId, own.case.id, { kind: "details", ...patch.value });
  }

  async close(token: string | null | undefined, caseId: unknown): Promise<CaseResult<{ case: CaseView }>> {
    const own = await this.#ownCase(token, caseId);
    if (!own.ok) return own;
    return this.#change(own.ownerId, own.case.id, { kind: "status", status: "closed" });
  }

  async reopen(token: string | null | undefined, caseId: unknown): Promise<CaseResult<{ case: CaseView }>> {
    const own = await this.#ownCase(token, caseId);
    if (!own.ok) return own;
    return this.#change(own.ownerId, own.case.id, { kind: "status", status: "open" });
  }

  async #change(ownerId: string, caseId: string, change: CaseChange): Promise<CaseResult<{ case: CaseView }>> {
    const outcome = await this.#store.updateCase(ownerId, caseId, change, this.#now().toISOString());
    if (outcome.ok) return { ok: true, case: toCaseView(outcome.case) };
    switch (outcome.reason) {
      case "not_found":
        return NOT_FOUND;
      case "case_closed":
        return change.kind === "status" ? { ok: false, error: "case_closed", message: "this case is already closed" } : CLOSED;
      case "case_not_closed":
        return { ok: false, error: "case_not_closed", message: "this case is already open" };
    }
  }

  /** Deletes the case and all its items, open or closed. There is no undo. */
  async remove(token: string | null | undefined, caseId: unknown): Promise<CaseResult<{}>> {
    const own = await this.#ownCase(token, caseId);
    if (!own.ok) return own;
    if (!(await this.#store.deleteCase(own.ownerId, own.case.id))) return NOT_FOUND;
    return { ok: true };
  }

  /** Adds a real address (`{ chain, address, note? }`) to one of your open cases. */
  async addItem(token: string | null | undefined, caseId: unknown, body: Record<string, unknown>): Promise<CaseResult<{ item: CaseItemView }>> {
    const own = await this.#ownCase(token, caseId);
    if (!own.ok) return own;
    const target = parseChainAddress(body["chain"], body["address"]);
    if (!target.ok) return { ok: false, error: target.error, message: target.message };
    const note = parseNote(body["note"]);
    if (!note.ok) return { ok: false, error: "invalid_item", message: note.message };

    const outcome = await this.#store.addItem(
      own.ownerId,
      own.case.id,
      { id: randomUUID(), chain: target.chain, address: target.address, note: note.value },
      this.#now().toISOString(),
    );
    if (outcome.ok) return { ok: true, item: toCaseItemView(outcome.item) };
    switch (outcome.reason) {
      case "not_found":
        return NOT_FOUND;
      case "case_closed":
        return CLOSED;
      case "duplicate_item":
        return { ok: false, error: "duplicate_item", message: "this address is already in this case — edit its note instead" };
      case "limit_reached":
        return { ok: false, error: "limit_reached", message: "this case already holds the maximum number of items" };
    }
  }

  /** Replaces the note on one item of one of your open cases. */
  async updateItem(
    token: string | null | undefined,
    caseId: unknown,
    itemId: unknown,
    body: Record<string, unknown>,
  ): Promise<CaseResult<{ item: CaseItemView }>> {
    const own = await this.#ownCase(token, caseId);
    if (!own.ok) return own;
    if (typeof itemId !== "string" || itemId.length === 0) return ITEM_NOT_FOUND;
    if (body["note"] === undefined) return { ok: false, error: "invalid_item", message: "note is required (send an empty string to clear it)" };
    const note = parseNote(body["note"]);
    if (!note.ok) return { ok: false, error: "invalid_item", message: note.message };

    const outcome = await this.#store.updateItemNote(own.ownerId, own.case.id, itemId, note.value, this.#now().toISOString());
    if (outcome.ok) return { ok: true, item: toCaseItemView(outcome.item) };
    switch (outcome.reason) {
      case "not_found":
        return NOT_FOUND;
      case "item_not_found":
        return ITEM_NOT_FOUND;
      case "case_closed":
        return CLOSED;
    }
  }

  async removeItem(token: string | null | undefined, caseId: unknown, itemId: unknown): Promise<CaseResult<{}>> {
    const own = await this.#ownCase(token, caseId);
    if (!own.ok) return own;
    if (typeof itemId !== "string" || itemId.length === 0) return ITEM_NOT_FOUND;
    const outcome = await this.#store.removeItem(own.ownerId, own.case.id, itemId, this.#now().toISOString());
    if (outcome.ok) return { ok: true };
    switch (outcome.reason) {
      case "not_found":
        return NOT_FOUND;
      case "item_not_found":
        return ITEM_NOT_FOUND;
      case "case_closed":
        return CLOSED;
    }
  }
}
