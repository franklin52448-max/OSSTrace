import type { AccountId, ChainId } from "@osstrace/core";

/**
 * The case-management data model. See docs/adr/0011-case-management-private-owner-only-cases.md.
 *
 * A case is one investigator's own private working record: a title, a description, and a set of
 * real addresses (items), each with the investigator's own note. It is visible to its owner only —
 * never to other users, moderators or admins — and it is not a public claim, so neither the case
 * nor its notes carry a `Source` (same reasoning ADR 0004 uses for private labels).
 */
export type CaseStatus = "open" | "closed";

/** Exactly as persisted. `ownedBy` is the accounts package's opaque user id — never an email. */
export interface Case {
  /** Random UUID. */
  id: string;
  /** One line, 1–140 characters. */
  title: string;
  /** Free text, may be empty, may span lines. */
  description: string;
  ownedBy: AccountId;
  status: CaseStatus;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. Moves on any change to the case, including adding/editing/removing an item. */
  updatedAt: string;
  /** ISO 8601 while `closed`, `null` while `open`. */
  closedAt: string | null;
}

/** Exactly as persisted. Carries `ownedBy` too, so the store can filter every item by owner *and* case. */
export interface CaseItem {
  /** Random UUID. */
  id: string;
  caseId: string;
  ownedBy: AccountId;
  chain: ChainId;
  /** `canonicalAddress` form from `@osstrace/core`: lowercase hex on Ethereum, exact base58 on Solana. */
  address: string;
  /** The investigator's own free-text note. May be empty. */
  note: string;
  /** ISO 8601. */
  addedAt: string;
  /** ISO 8601. Equal to `addedAt` until the note is first edited. */
  updatedAt: string;
}

/**
 * What the owner gets back. Deliberately has no owner field: the only person who can ever receive
 * a case is its owner, so there's nothing to tell them — and nothing to leak if a bug ever sent
 * one to the wrong place. Same choice as `PrivateLabel` in `@osstrace/private-labels`.
 */
export type CaseView = Omit<Case, "ownedBy">;
export type CaseItemView = Omit<CaseItem, "ownedBy">;

export function toCaseView(c: Case): CaseView {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    closedAt: c.closedAt,
  };
}

export function toCaseItemView(item: CaseItem): CaseItemView {
  return {
    id: item.id,
    caseId: item.caseId,
    chain: item.chain,
    address: item.address,
    note: item.note,
    addedAt: item.addedAt,
    updatedAt: item.updatedAt,
  };
}

/** How many cases one account may hold. Bounds the re-read-on-every-call file — ADR 0011 "Limits". */
export const CASES_PER_USER_LIMIT = 500;
/** How many items one case may hold. */
export const ITEMS_PER_CASE_LIMIT = 1000;

export type CaseErrorCode =
  | "unauthenticated"
  | "invalid_case"
  | "invalid_item"
  | "invalid_chain"
  | "invalid_address"
  /** No such case/item *for this owner* — another user's case is indistinguishable from none. */
  | "not_found"
  | "case_closed"
  | "case_not_closed"
  | "duplicate_item"
  | "limit_reached";

/** Same convention as `@osstrace/accounts` and `@osstrace/bounties`: expected failures are values, never thrown. */
export type CaseResult<T> = ({ ok: true } & T) | { ok: false; error: CaseErrorCode; message: string };
