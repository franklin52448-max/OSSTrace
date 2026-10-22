import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChainId } from "@osstrace/core";
import { PRIVATE_LABELS_PER_USER_LIMIT, type StoredPrivateLabel } from "./types.ts";

export type SetPrivateLabelOutcome =
  | { ok: true; label: StoredPrivateLabel; created: boolean }
  | { ok: false; reason: "limit_reached" };

/**
 * Per-user private-label storage. **Every method takes the owner's `userId` and only ever touches
 * that user's entries** — there is deliberately no "get by address" or "list everything" method,
 * so no caller (a future feature, a careless refactor) can ask this store for someone else's label
 * by accident. The owner check is the shape of the interface, not a convention on top of it.
 *
 * `address` must already be canonical (`canonicalAddress` from `@osstrace/core`); the service does that.
 */
export interface PrivateLabelStore {
  get(userId: string, chain: ChainId, address: string): Promise<StoredPrivateLabel | null>;
  /** That user's labels only, most recently updated first. */
  list(userId: string): Promise<StoredPrivateLabel[]>;
  /** Creates or replaces that user's label for the address. */
  set(userId: string, chain: ChainId, address: string, label: string, at: string): Promise<SetPrivateLabelOutcome>;
  /** False if that user had no label for the address. Never touches any other user's entry. */
  delete(userId: string, chain: ChainId, address: string): Promise<boolean>;
}

interface PrivateLabelsFile {
  version: 1;
  labels: StoredPrivateLabel[];
}

function emptyFile(): PrivateLabelsFile {
  return { version: 1, labels: [] };
}

/** An empty or non-string owner id would be a wildcard waiting to happen — refuse it outright. */
function assertUserId(userId: string): void {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("private-label store: a non-empty owner userId is required for every call");
  }
}

function matches(entry: StoredPrivateLabel, userId: string, chain: ChainId, address: string): boolean {
  return entry.userId === userId && entry.chain === chain && entry.address === address;
}

/**
 * File-backed JSON store, built to the same bar as `JsonFileAccountStore` in
 * `@osstrace/accounts` (this file is per-user private data, not public seed data, so the
 * stricter rules apply rather than `JsonFileLabelStore`'s cache-forever approach):
 *
 * - **Re-reads the file on every call**, so two store instances on one file (or a second process)
 *   never serve or write back a stale copy.
 * - **Serializes writes** in-process (a promise chain), so concurrent saves can't drop each other.
 * - **Writes atomically** (temp file + rename), so a crash mid-write can't truncate everyone's labels.
 * - **Creates the file `0600`** (and its directory `0700` when it creates it): the contents are
 *   people's private notes about addresses, readable by nobody but the server's own OS user.
 *
 * Not handled: two *processes* writing in the same instant. Only the private-labels server writes
 * this file, so in practice there is one writer; a multi-instance deployment needs a database.
 */
export class JsonFilePrivateLabelStore implements PrivateLabelStore {
  readonly #path: string;
  readonly #perUserLimit: number;
  #writeChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, options: { perUserLimit?: number } = {}) {
    this.#path = filePath;
    this.#perUserLimit = options.perUserLimit ?? PRIVATE_LABELS_PER_USER_LIMIT;
  }

  async #read(): Promise<PrivateLabelsFile> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw cause;
    }
    const parsed = JSON.parse(raw) as PrivateLabelsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.labels)) {
      throw new Error(`${this.#path} is not a version-1 private-labels file`);
    }
    return parsed;
  }

  async #write(data: PrivateLabelsFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.#path);
    await chmod(this.#path, 0o600);
  }

  /** Runs read-modify-write steps one at a time, in call order. */
  #mutate<T>(fn: (data: PrivateLabelsFile) => { result: T; changed: boolean }): Promise<T> {
    const run = this.#writeChain.then(async () => {
      const data = await this.#read();
      const { result, changed } = fn(data);
      if (changed) await this.#write(data);
      return result;
    });
    // Keep the chain alive even if this step fails, so one failed write doesn't wedge the store.
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  async get(userId: string, chain: ChainId, address: string): Promise<StoredPrivateLabel | null> {
    assertUserId(userId);
    return (await this.#read()).labels.find((l) => matches(l, userId, chain, address)) ?? null;
  }

  async list(userId: string): Promise<StoredPrivateLabel[]> {
    assertUserId(userId);
    return (await this.#read()).labels
      .filter((l) => l.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async set(userId: string, chain: ChainId, address: string, label: string, at: string): Promise<SetPrivateLabelOutcome> {
    assertUserId(userId);
    return this.#mutate<SetPrivateLabelOutcome>((data) => {
      const index = data.labels.findIndex((l) => matches(l, userId, chain, address));
      const existing = data.labels[index];
      if (existing) {
        const updated: StoredPrivateLabel = { ...existing, label, updatedAt: at };
        data.labels[index] = updated;
        return { result: { ok: true, label: updated, created: false }, changed: true };
      }
      // Counted inside the write lock, so concurrent creates can't overshoot the limit together.
      if (data.labels.filter((l) => l.userId === userId).length >= this.#perUserLimit) {
        return { result: { ok: false, reason: "limit_reached" }, changed: false };
      }
      const created: StoredPrivateLabel = { userId, chain, address, label, createdAt: at, updatedAt: at };
      data.labels.push(created);
      return { result: { ok: true, label: created, created: true }, changed: true };
    });
  }

  async delete(userId: string, chain: ChainId, address: string): Promise<boolean> {
    assertUserId(userId);
    return this.#mutate((data) => {
      const before = data.labels.length;
      data.labels = data.labels.filter((l) => !matches(l, userId, chain, address));
      const removed = data.labels.length !== before;
      return { result: removed, changed: removed };
    });
  }
}
