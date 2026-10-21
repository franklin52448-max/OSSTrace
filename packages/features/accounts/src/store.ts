import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Role, StoredSession, StoredUser, UserId } from "./types.ts";

export type SetRoleOutcome =
  | { ok: true; user: StoredUser }
  | { ok: false; reason: "not_found" | "last_admin" };

export interface AccountStore {
  getUserById(id: UserId): Promise<StoredUser | null>;
  getUserByEmail(normalizedEmail: string): Promise<StoredUser | null>;
  listUsers(): Promise<StoredUser[]>;
  /** False (and nothing written) if an account with that email already exists. */
  createUser(user: StoredUser): Promise<boolean>;
  /** Null if no such user. */
  updatePasswordHash(id: UserId, passwordHash: string): Promise<StoredUser | null>;
  /**
   * Changes a user's role. Refuses (`"last_admin"`) to demote the only remaining admin, checked
   * atomically with the write so two concurrent demotions can't both pass the check.
   */
  setRole(id: UserId, role: Role, at: string): Promise<SetRoleOutcome>;

  createSession(session: StoredSession): Promise<void>;
  getSession(tokenHash: string): Promise<StoredSession | null>;
  deleteSession(tokenHash: string): Promise<void>;
}

interface AccountsFile {
  version: 1;
  users: StoredUser[];
  sessions: StoredSession[];
}

function emptyFile(): AccountsFile {
  return { version: 1, users: [], sessions: [] };
}

/**
 * File-backed JSON account store — the same tradeoff as `JsonFileLabelStore` in `@osstrace/core`:
 * a first-time contributor can run the whole system without standing up a database, and swapping
 * this for one later is a same-interface change. Where it deliberately differs from the label
 * store, because this file holds credentials rather than public seed data:
 *
 * - **Re-reads the file on every call** instead of caching it for the process lifetime, so a role
 *   change made by the operator CLI (`src/cli.ts`, a separate process) is seen immediately by a
 *   running server, and the server can't later overwrite it with a stale in-memory copy.
 * - **Serializes writes** within the process (a promise chain), so two concurrent signups can't
 *   both read the old file and each drop the other's write.
 * - **Writes atomically** (temp file + rename), so a crash mid-write can't leave a truncated file
 *   that locks every account out.
 * - **Creates the file `0600`** (owner read/write only) — it holds password hashes and emails.
 * - **Prunes expired sessions** on every write, so the file doesn't grow forever.
 *
 * Not handled: two *processes* writing in the same instant (only the in-process lock exists).
 * In practice that's one server plus the occasional operator CLI call; see ADR 0006 for when this
 * should become a real database.
 */
export class JsonFileAccountStore implements AccountStore {
  readonly #path: string;
  readonly #now: () => Date;
  #writeChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, options: { now?: () => Date } = {}) {
    this.#path = filePath;
    this.#now = options.now ?? (() => new Date());
  }

  async #read(): Promise<AccountsFile> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw cause;
    }
    const parsed = JSON.parse(raw) as AccountsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.users) || !Array.isArray(parsed.sessions)) {
      throw new Error(`${this.#path} is not a version-1 accounts file`);
    }
    return parsed;
  }

  async #write(data: AccountsFile): Promise<void> {
    const now = this.#now().getTime();
    data.sessions = data.sessions.filter((s) => Date.parse(s.expiresAt) > now);
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.#path);
    await chmod(this.#path, 0o600);
  }

  /** Runs read-modify-write steps one at a time, in call order. */
  #mutate<T>(fn: (data: AccountsFile) => T): Promise<T> {
    const run = this.#writeChain.then(async () => {
      const data = await this.#read();
      const result = fn(data);
      await this.#write(data);
      return result;
    });
    // Keep the chain alive even if this step fails, so one failed write doesn't wedge the store.
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  async getUserById(id: UserId): Promise<StoredUser | null> {
    return (await this.#read()).users.find((u) => u.id === id) ?? null;
  }

  async getUserByEmail(normalizedEmail: string): Promise<StoredUser | null> {
    return (await this.#read()).users.find((u) => u.email === normalizedEmail) ?? null;
  }

  async listUsers(): Promise<StoredUser[]> {
    return (await this.#read()).users;
  }

  createUser(user: StoredUser): Promise<boolean> {
    return this.#mutate((data) => {
      if (data.users.some((u) => u.email === user.email || u.id === user.id)) return false;
      data.users.push(user);
      return true;
    });
  }

  updatePasswordHash(id: UserId, passwordHash: string): Promise<StoredUser | null> {
    return this.#mutate((data) => {
      const index = data.users.findIndex((u) => u.id === id);
      const existing = data.users[index];
      if (!existing) return null;
      const updated: StoredUser = { ...existing, passwordHash };
      data.users[index] = updated;
      return updated;
    });
  }

  setRole(id: UserId, role: Role, at: string): Promise<SetRoleOutcome> {
    return this.#mutate((data): SetRoleOutcome => {
      const index = data.users.findIndex((u) => u.id === id);
      const existing = data.users[index];
      if (!existing) return { ok: false, reason: "not_found" };
      if (existing.role === role) return { ok: true, user: existing };
      if (existing.role === "admin" && data.users.filter((u) => u.role === "admin").length === 1) {
        return { ok: false, reason: "last_admin" };
      }
      const updated: StoredUser = { ...existing, role, roleUpdatedAt: at };
      data.users[index] = updated;
      return { ok: true, user: updated };
    });
  }

  createSession(session: StoredSession): Promise<void> {
    return this.#mutate((data) => {
      data.sessions.push(session);
    });
  }

  async getSession(tokenHash: string): Promise<StoredSession | null> {
    return (await this.#read()).sessions.find((s) => s.tokenHash === tokenHash) ?? null;
  }

  deleteSession(tokenHash: string): Promise<void> {
    return this.#mutate((data) => {
      data.sessions = data.sessions.filter((s) => s.tokenHash !== tokenHash);
    });
  }
}
