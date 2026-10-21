import argon2 from "argon2";

/**
 * Password hashing: argon2id via the `argon2` npm package (node-argon2, bindings to the reference
 * C implementation, shipped with prebuilt binaries — no compiler needed on macOS/Linux/Windows).
 *
 * Parameters are OWASP's first recommended argon2id configuration (m=19 MiB, t=2, p=1). They're
 * embedded in every hash string, so raising them later only affects new hashes; old ones still
 * verify, and `needsRehash` lets login transparently upgrade them.
 */
export const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 10;
/** Bounded so a multi-megabyte "password" can't be used to burn CPU. */
export const PASSWORD_MAX_LENGTH = 256;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

/** False for a wrong password *and* for a malformed hash — never throws on bad input. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, HASH_OPTIONS);
  } catch {
    return true;
  }
}

/**
 * Length-only policy, per NIST SP 800-63B: no composition rules ("one uppercase, one symbol"),
 * which push people toward predictable patterns without adding real strength.
 */
export function checkPassword(password: unknown): string | null {
  if (typeof password !== "string") return "password must be a string";
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (length > PASSWORD_MAX_LENGTH) return `password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  return null;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed + lowercased, so `Alice@Example.com` and `alice@example.com` are one account. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Shape check only — this system never sends email, so it can't verify ownership (ADR 0006). */
export function checkEmail(email: unknown): string | null {
  if (typeof email !== "string") return "email must be a string";
  const normalized = normalizeEmail(email);
  if (normalized.length > 254) return "email must be at most 254 characters";
  if (!EMAIL_SHAPE.test(normalized)) return "email doesn't look like an email address";
  return null;
}
