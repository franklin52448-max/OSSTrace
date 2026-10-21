import type { ChainId } from "@osstrace/core";

/**
 * The private-label data model. A private label is NOT a `Label` from `@osstrace/core`:
 * it's one person's own note about an address, never part of the public dataset, never shown to
 * anyone else, and it carries no `Source` (ADR 0004 — it isn't a public claim, so ADR 0002's
 * sourcing rule doesn't apply). Keeping it a separate type, in a separate store, is what makes it
 * structurally impossible for one to end up in the shared label files or the Explorer's response.
 */

/** Longest label accepted, in Unicode code points. A label is a short name, not a document. */
export const PRIVATE_LABEL_MAX_LENGTH = 200;

/**
 * How many private labels one account may hold. Bounds the size of the (re-read-on-every-call)
 * JSON file a single account can grow; far above any real personal labelling need.
 */
export const PRIVATE_LABELS_PER_USER_LIMIT = 5000;

/** Exactly as persisted. `userId` is the accounts package's opaque id — never an email. */
export interface StoredPrivateLabel {
  userId: string;
  chain: ChainId;
  /** Canonical form (see `address.ts`): lowercase hex on Ethereum, exact base58 on Solana. */
  address: string;
  label: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. Equal to `createdAt` until the label is first edited. */
  updatedAt: string;
}

/**
 * What the owner gets back. Deliberately has no owner field: the only person who can ever receive
 * one is its owner, so there's nothing to tell them — and nothing to leak if a bug ever did send
 * one to the wrong place.
 */
export interface PrivateLabel {
  chain: ChainId;
  address: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export function toPrivateLabel(stored: StoredPrivateLabel): PrivateLabel {
  return {
    chain: stored.chain,
    address: stored.address,
    label: stored.label,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export type PrivateLabelErrorCode =
  | "unauthenticated"
  | "invalid_chain"
  | "invalid_address"
  | "invalid_label"
  | "not_found"
  | "limit_reached";

/** Same shape as `@osstrace/accounts`' `AuthResult`: expected failures are values, never throws. */
export type PrivateLabelResult<T> = ({ ok: true } & T) | { ok: false; error: PrivateLabelErrorCode; message: string };
