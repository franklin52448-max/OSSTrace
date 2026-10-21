import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  checkEmail,
  checkPassword,
  hashPassword,
  needsRehash,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
  verifyPassword,
} from "./password.ts";
import type { AccountStore } from "./store.ts";
import {
  isRole,
  roleAtLeast,
  toPublicUser,
  type AuthResult,
  type IssuedSession,
  type PublicUser,
  type Role,
  type StoredUser,
  type UserId,
} from "./types.ts";

/** 30 days. Absolute, not sliding: a stolen token stops working on a fixed date regardless of use. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_PREFIX = "ots_";

/** SHA-256 is right here (not argon2): the token is 256 random bits, so there's nothing to brute-force. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newSessionToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export interface AccountServiceOptions {
  sessionTtlMs?: number;
  /** Injectable clock, so tests can prove expiry against the real code path rather than a mock. */
  now?: () => Date;
}

type WithSession = { user: PublicUser; session: IssuedSession };

/**
 * Every auth operation the rest of the project needs. The HTTP layer (`http.ts`) and the operator
 * CLI (`cli.ts`) are thin wrappers over this; Wave 2 features should call `authenticate` /
 * `requireRole` directly rather than re-implementing any of it.
 */
export class AccountService {
  readonly #store: AccountStore;
  readonly #ttlMs: number;
  readonly #now: () => Date;
  #dummyHash: Promise<string> | null = null;

  constructor(store: AccountStore, options: AccountServiceOptions = {}) {
    this.#store = store;
    this.#ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = options.now ?? (() => new Date());
  }

  async #issueSession(userId: UserId): Promise<IssuedSession> {
    const token = newSessionToken();
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();
    await this.#store.createSession({
      tokenHash: hashSessionToken(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt,
    });
    return { token, expiresAt };
  }

  /** Every new account is a plain `user`. There is deliberately no way to sign up as anything else. */
  async signup(email: unknown, password: unknown): Promise<AuthResult<WithSession>> {
    const emailProblem = checkEmail(email);
    if (emailProblem) return { ok: false, error: "invalid_email", message: emailProblem };
    const passwordProblem = checkPassword(password);
    if (passwordProblem) return { ok: false, error: "invalid_password", message: passwordProblem };

    const normalized = normalizeEmail(email as string);
    if (await this.#store.getUserByEmail(normalized)) {
      return { ok: false, error: "email_taken", message: "an account with that email already exists" };
    }
    const at = this.#now().toISOString();
    const user: StoredUser = {
      id: randomUUID(),
      email: normalized,
      passwordHash: await hashPassword(password as string),
      role: "user",
      createdAt: at,
      roleUpdatedAt: at,
    };
    // createUser re-checks uniqueness inside the store's write lock, so two concurrent signups for
    // the same email can't both succeed even though both passed the check above.
    if (!(await this.#store.createUser(user))) {
      return { ok: false, error: "email_taken", message: "an account with that email already exists" };
    }
    return { ok: true, user: toPublicUser(user), session: await this.#issueSession(user.id) };
  }

  /**
   * Same error, and roughly the same time spent, whether the email is unknown or the password is
   * wrong — an unknown email still runs one argon2 verify against a throwaway hash, so response
   * time doesn't reveal which accounts exist.
   */
  async login(email: unknown, password: unknown): Promise<AuthResult<WithSession>> {
    const rejected = { ok: false, error: "invalid_credentials", message: "wrong email or password" } as const;
    // Only the max length is enforced here (it bounds CPU spent hashing). The min length is a
    // signup-time policy; raising it later mustn't lock existing accounts out.
    if (typeof email !== "string" || typeof password !== "string" || [...password].length > PASSWORD_MAX_LENGTH) {
      return rejected;
    }
    const user = await this.#store.getUserByEmail(normalizeEmail(email));
    if (!user) {
      this.#dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
      await verifyPassword(await this.#dummyHash, password);
      return rejected;
    }
    if (!(await verifyPassword(user.passwordHash, password))) return rejected;

    if (needsRehash(user.passwordHash)) {
      await this.#store.updatePasswordHash(user.id, await hashPassword(password));
    }
    return { ok: true, user: toPublicUser(user), session: await this.#issueSession(user.id) };
  }

  /** Revokes this one session. Idempotent: logging out an unknown/expired token is not an error. */
  async logout(token: string): Promise<void> {
    await this.#store.deleteSession(hashSessionToken(token));
  }

  /**
   * The one function anything else should use to answer "who is making this request?".
   * Returns the user's *current* record, so a role change (or demotion) takes effect on the very
   * next request — roles are never baked into the token.
   */
  async authenticate(token: string | null | undefined): Promise<AuthResult<{ user: PublicUser }>> {
    const unauthenticated = { ok: false, error: "unauthenticated", message: "missing, invalid or expired session" } as const;
    if (!token || !token.startsWith(TOKEN_PREFIX)) return unauthenticated;
    const session = await this.#store.getSession(hashSessionToken(token));
    if (!session || Date.parse(session.expiresAt) <= this.#now().getTime()) return unauthenticated;
    const user = await this.#store.getUserById(session.userId);
    if (!user) return unauthenticated;
    return { ok: true, user: toPublicUser(user) };
  }

  /**
   * `authenticate` plus a role check. Wave 2's "mark Confirmed" endpoint is expected to be
   * `requireRole(token, "moderator")` and nothing more. Admins pass any moderator check.
   */
  async requireRole(token: string | null | undefined, required: Role): Promise<AuthResult<{ user: PublicUser }>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    if (!roleAtLeast(auth.user.role, required)) {
      return { ok: false, error: "forbidden", message: `requires the "${required}" role` };
    }
    return auth;
  }

  /** Admin-only: list every account (without password hashes), so an admin can find who to promote. */
  async listUsers(actorToken: string | null | undefined): Promise<AuthResult<{ users: PublicUser[] }>> {
    const actor = await this.requireRole(actorToken, "admin");
    if (!actor.ok) return actor;
    return { ok: true, users: (await this.#store.listUsers()).map(toPublicUser) };
  }

  /** Admin-only over HTTP: grant or revoke a role on another account. */
  async setRole(actorToken: string | null | undefined, targetId: UserId, role: unknown): Promise<AuthResult<{ user: PublicUser }>> {
    const actor = await this.requireRole(actorToken, "admin");
    if (!actor.ok) return actor;
    return this.#applyRole(targetId, role);
  }

  /**
   * Operator-only: no session check, because it's only reachable from the command line on the
   * machine that holds the accounts file (`src/cli.ts`). This is how the very first admin exists.
   * Never wire this to an HTTP route.
   */
  async setRoleAsOperator(email: string, role: unknown): Promise<AuthResult<{ user: PublicUser }>> {
    const user = await this.#store.getUserByEmail(normalizeEmail(email));
    if (!user) return { ok: false, error: "not_found", message: `no account with email "${normalizeEmail(email)}"` };
    return this.#applyRole(user.id, role);
  }

  async #applyRole(targetId: UserId, role: unknown): Promise<AuthResult<{ user: PublicUser }>> {
    if (!isRole(role)) return { ok: false, error: "invalid_role", message: `role must be one of: user, moderator, admin` };
    const outcome = await this.#store.setRole(targetId, role, this.#now().toISOString());
    if (outcome.ok) return { ok: true, user: toPublicUser(outcome.user) };
    if (outcome.reason === "not_found") return { ok: false, error: "not_found", message: "no such user" };
    return { ok: false, error: "last_admin", message: "can't remove the last remaining admin — promote another account first" };
  }
}
