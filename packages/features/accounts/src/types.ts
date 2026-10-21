/**
 * The accounts data model. See docs/adr/0006-accounts-and-auth.md for why it's shaped this way and
 * what Wave 2 (Confirmed-tier moderation, private labels — ADR 0004) is expected to need from it.
 */

/**
 * Roles are ordered: every role can do everything the roles before it can.
 *
 * - `user` — any registered account. Wave 2: owns private labels, submits Community labels.
 * - `moderator` — can mark a Community label Confirmed (ADR 0004, Wave 2).
 * - `admin` — everything a moderator can do, plus granting/revoking roles on other accounts.
 *
 * The first admin can only be created by the operator from the command line (`src/cli.ts`) —
 * never by an HTTP request. See ADR 0006, "How the first moderator/admin is granted".
 */
export const ROLES = ["user", "moderator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** True when `actual` is `required` or a role above it (admin ⊇ moderator ⊇ user). */
export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/**
 * Stable, opaque account id (a random UUID). Anything that records "who did this" — e.g. a Wave 2
 * `confirmedBy` on a Label, or the owner of a private label — must store this id, never the email,
 * since an email is a mutable contact detail and the id is not.
 */
export type UserId = string;

/** A user exactly as persisted. Never return this shape over the network — use `PublicUser`. */
export interface StoredUser {
  id: UserId;
  /** Normalized (trimmed, lowercased). Unique across all accounts. Not verified — see ADR 0006. */
  email: string;
  /** An argon2id PHC string (`$argon2id$v=19$m=...`). Never the password itself. */
  passwordHash: string;
  role: Role;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, when `role` last changed. Equal to `createdAt` for an account never re-roled. */
  roleUpdatedAt: string;
}

/** What's safe to show the account holder (or an admin): everything except the password hash. */
export interface PublicUser {
  id: UserId;
  email: string;
  role: Role;
  createdAt: string;
  roleUpdatedAt: string;
}

export function toPublicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    roleUpdatedAt: user.roleUpdatedAt,
  };
}

/**
 * A session as persisted. Only a SHA-256 hash of the session token is stored, so a leaked or
 * accidentally-shared store file can't be used to log in as anyone.
 */
export interface StoredSession {
  /** Hex SHA-256 of the bearer token. */
  tokenHash: string;
  userId: UserId;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. A session past this instant is rejected (and pruned on the next write). */
  expiresAt: string;
}

/** Handed to the client exactly once, at signup/login. The raw token is never persisted. */
export interface IssuedSession {
  token: string;
  expiresAt: string;
}

export type AuthErrorCode =
  | "invalid_email"
  | "invalid_password"
  | "email_taken"
  | "invalid_credentials"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_role"
  | "last_admin";

/** Every service call returns this shape instead of throwing for expected failures. */
export type AuthResult<T> = ({ ok: true } & T) | { ok: false; error: AuthErrorCode; message: string };
