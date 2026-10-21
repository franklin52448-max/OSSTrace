import type { AuthResult, PublicUser } from "@opentrace/accounts";
import type { ChainId } from "@opentrace/core";
import { canonicalAddress, isChainId, SUPPORTED_CHAINS } from "./address.ts";
import type { PrivateLabelStore } from "./store.ts";
import {
  PRIVATE_LABEL_MAX_LENGTH,
  toPrivateLabel,
  type PrivateLabel,
  type PrivateLabelResult,
} from "./types.ts";

/**
 * The only thing this package needs from accounts: "whose session is this?". `AccountService`
 * from `@opentrace/accounts` satisfies it as-is; it's an interface so the dependency is explicit
 * and narrow (this package can never create users, change roles or issue sessions).
 */
export interface Authenticator {
  authenticate(token: string | null | undefined): Promise<AuthResult<{ user: PublicUser }>>;
}

export interface PrivateLabelServiceOptions {
  /** Injectable clock, so tests can assert exact timestamps through the real code path. */
  now?: () => Date;
}

/** Control characters (newlines, tabs, NUL, escapes) — a label is one line of plain text. */
const CONTROL_CHARS = /\p{Cc}/u;

/** Null if acceptable, else a human-readable reason. No source is required — see ADR 0004. */
export function checkLabelText(value: unknown): string | null {
  if (typeof value !== "string") return "label must be a string";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "label must not be empty";
  if ([...trimmed].length > PRIVATE_LABEL_MAX_LENGTH) return `label must be at most ${PRIVATE_LABEL_MAX_LENGTH} characters`;
  if (CONTROL_CHARS.test(trimmed)) return "label must be a single line of text (no control characters)";
  return null;
}

type Target = { userId: string; chain: ChainId; address: string };

/**
 * Every private-label operation, each one owner-scoped: the owner is *always* the user the bearer
 * token authenticates as, and there is no parameter anywhere — not here, not in the HTTP layer —
 * through which a caller can name a different owner. That's the whole isolation guarantee.
 */
export class PrivateLabelService {
  readonly #auth: Authenticator;
  readonly #store: PrivateLabelStore;
  readonly #now: () => Date;

  constructor(auth: Authenticator, store: PrivateLabelStore, options: PrivateLabelServiceOptions = {}) {
    this.#auth = auth;
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  /** Authenticates first, then validates — an unauthenticated caller learns nothing, not even "bad address". */
  async #resolve(
    token: string | null | undefined,
    chain: unknown,
    address: unknown,
  ): Promise<PrivateLabelResult<{ target: Target }>> {
    const me = await this.#auth.authenticate(token);
    if (!me.ok) return { ok: false, error: "unauthenticated", message: me.message };
    if (!isChainId(chain)) {
      return { ok: false, error: "invalid_chain", message: `chain must be one of: ${SUPPORTED_CHAINS.join(", ")}` };
    }
    const canonical = typeof address === "string" ? canonicalAddress(chain, address) : null;
    if (!canonical) return { ok: false, error: "invalid_address", message: `not a valid ${chain} address` };
    return { ok: true, target: { userId: me.user.id, chain, address: canonical } };
  }

  /** Your own label for this address, or `label: null` if you haven't set one. */
  async get(token: string | null | undefined, chain: unknown, address: unknown): Promise<PrivateLabelResult<{ label: PrivateLabel | null }>> {
    const resolved = await this.#resolve(token, chain, address);
    if (!resolved.ok) return resolved;
    const { userId, chain: c, address: a } = resolved.target;
    const stored = await this.#store.get(userId, c, a);
    return { ok: true, label: stored ? toPrivateLabel(stored) : null };
  }

  /** All of your own labels, most recently updated first. */
  async list(token: string | null | undefined): Promise<PrivateLabelResult<{ labels: PrivateLabel[] }>> {
    const me = await this.#auth.authenticate(token);
    if (!me.ok) return { ok: false, error: "unauthenticated", message: me.message };
    return { ok: true, labels: (await this.#store.list(me.user.id)).map(toPrivateLabel) };
  }

  /** Creates or replaces your own label for this address. */
  async set(
    token: string | null | undefined,
    chain: unknown,
    address: unknown,
    label: unknown,
  ): Promise<PrivateLabelResult<{ label: PrivateLabel; created: boolean }>> {
    const resolved = await this.#resolve(token, chain, address);
    if (!resolved.ok) return resolved;
    const problem = checkLabelText(label);
    if (problem) return { ok: false, error: "invalid_label", message: problem };
    const { userId, chain: c, address: a } = resolved.target;
    const outcome = await this.#store.set(userId, c, a, (label as string).trim(), this.#now().toISOString());
    if (!outcome.ok) {
      return {
        ok: false,
        error: "limit_reached",
        message: "you already have the maximum number of private labels — remove one first",
      };
    }
    return { ok: true, label: toPrivateLabel(outcome.label), created: outcome.created };
  }

  /** Removes your own label for this address. `not_found` if you didn't have one. */
  async remove(token: string | null | undefined, chain: unknown, address: unknown): Promise<PrivateLabelResult<{}>> {
    const resolved = await this.#resolve(token, chain, address);
    if (!resolved.ok) return resolved;
    const { userId, chain: c, address: a } = resolved.target;
    if (!(await this.#store.delete(userId, c, a))) {
      return { ok: false, error: "not_found", message: "you have no private label for that address" };
    }
    return { ok: true };
  }
}
