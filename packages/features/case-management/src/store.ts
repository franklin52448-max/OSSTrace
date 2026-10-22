import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChainId } from "@osstrace/core";
import { CASES_PER_USER_LIMIT, ITEMS_PER_CASE_LIMIT, type Case, type CaseItem, type CaseStatus } from "./types.ts";

export interface CaseFilter {
  status?: CaseStatus;
}

export type CreateCaseOutcome = { ok: true; case: Case } | { ok: false; reason: "limit_reached" };

/** A change to an existing case. `details` needs the case open; `status` needs it to be in the other status. */
export type CaseChange =
  | { kind: "details"; title?: string; description?: string }
  | { kind: "status"; status: CaseStatus };

export type UpdateCaseOutcome =
  | { ok: true; case: Case }
  | { ok: false; reason: "not_found" | "case_closed" | "case_not_closed" };

export interface NewItem {
  id: string;
  chain: ChainId;
  /** Already canonical (`canonicalAddress` from `@osstrace/core`); the service does that. */
  address: string;
  note: string;
}

export type AddItemOutcome =
  | { ok: true; item: CaseItem; case: Case }
  | { ok: false; reason: "not_found" | "case_closed" | "duplicate_item" | "limit_reached" };

export type ItemChangeOutcome =
  | { ok: true; item: CaseItem; case: Case }
  | { ok: false; reason: "not_found" | "item_not_found" | "case_closed" };

export type RemoveItemOutcome =
  | { ok: true; case: Case }
  | { ok: false; reason: "not_found" | "item_not_found" | "case_closed" };

/**
 * Per-owner case storage. **Every method takes the owner's id and only ever touches that owner's
 * cases and items** — there is deliberately no "get case by id" without an owner, and no
 * list-everything method, so no caller (a future feature, an admin screen, a careless refactor) can
 * ask this store for someone else's case by accident. Same shape as `PrivateLabelStore`: the owner
 * check is the shape of the interface, not a convention on top of it. See ADR 0011 §3.
 */
export interface CaseStore {
  /** That owner's cases only, most recently updated first. */
  listCases(ownerId: string, filter?: CaseFilter): Promise<Case[]>;
  /** Null if the case doesn't exist *or belongs to someone else* — the two are indistinguishable. */
  getCase(ownerId: string, caseId: string): Promise<Case | null>;
  /** The items of that owner's case, in the order they were added. Empty if the case isn't theirs. */
  listItems(ownerId: string, caseId: string): Promise<CaseItem[]>;
  /** Item count per case id, over that owner's own items only (for the case list). */
  countItems(ownerId: string): Promise<Map<string, number>>;
  /** `case.ownedBy` must equal `ownerId`. Counts the owner's cases inside the write lock. */
  createCase(ownerId: string, newCase: Case): Promise<CreateCaseOutcome>;
  updateCase(ownerId: string, caseId: string, change: CaseChange, at: string): Promise<UpdateCaseOutcome>;
  /** Deletes the case and every one of its items in one atomic write. False if it isn't that owner's case. */
  deleteCase(ownerId: string, caseId: string): Promise<boolean>;
  /** Atomically: the case must be that owner's, open, under the item limit, and not already hold the address. */
  addItem(ownerId: string, caseId: string, item: NewItem, at: string): Promise<AddItemOutcome>;
  updateItemNote(ownerId: string, caseId: string, itemId: string, note: string, at: string): Promise<ItemChangeOutcome>;
  removeItem(ownerId: string, caseId: string, itemId: string, at: string): Promise<RemoveItemOutcome>;
}

interface CasesFile {
  version: 1;
  cases: Case[];
  items: CaseItem[];
}

function emptyFile(): CasesFile {
  return { version: 1, cases: [], items: [] };
}

/** An empty or non-string owner id would be a wildcard waiting to happen — refuse it outright. */
function assertOwnerId(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new Error("case store: a non-empty owner id is required for every call");
  }
}

const isOwnCase = (c: Case, ownerId: string, caseId: string): boolean => c.id === caseId && c.ownedBy === ownerId;
const isOwnItem = (i: CaseItem, ownerId: string, caseId: string): boolean => i.caseId === caseId && i.ownedBy === ownerId;

/**
 * File-backed JSON store for cases + their items — the same concurrency contract as
 * `JsonFileBountyStore` and `JsonFilePrivateLabelStore`, at the private-data bar of the latter:
 *
 * - **Re-reads the file on every call**, so two store instances on one file (or a second process)
 *   never serve or write back a stale copy.
 * - **Serializes writes** in-process (a promise chain), so concurrent saves can't drop each other.
 * - **Writes atomically** (temp file + rename), so a crash mid-write can't truncate everyone's cases,
 *   and deleting a case with its items is one rename — never a case-less set of items.
 * - **Creates the file `0600`** (its directory `0700` when it creates it): the contents are
 *   people's private investigation notes, readable by nobody but the server's own OS user.
 *
 * Not handled: two *processes* writing in the same instant. Only the case-management server writes
 * this file; a multi-instance deployment needs a database-backed `CaseStore`.
 */
export class JsonFileCaseStore implements CaseStore {
  readonly #path: string;
  readonly #casesPerUser: number;
  readonly #itemsPerCase: number;
  #writeChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, options: { casesPerUserLimit?: number; itemsPerCaseLimit?: number } = {}) {
    this.#path = filePath;
    this.#casesPerUser = options.casesPerUserLimit ?? CASES_PER_USER_LIMIT;
    this.#itemsPerCase = options.itemsPerCaseLimit ?? ITEMS_PER_CASE_LIMIT;
  }

  async #read(): Promise<CasesFile> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw cause;
    }
    const parsed = JSON.parse(raw) as CasesFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.cases) || !Array.isArray(parsed.items)) {
      throw new Error(`${this.#path} is not a version-1 cases file`);
    }
    return parsed;
  }

  async #write(data: CasesFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.#path);
    await chmod(this.#path, 0o600);
  }

  /** Runs read-modify-write steps one at a time, in call order. */
  #mutate<T>(fn: (data: CasesFile) => { result: T; changed: boolean }): Promise<T> {
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

  async listCases(ownerId: string, filter: CaseFilter = {}): Promise<Case[]> {
    assertOwnerId(ownerId);
    return (await this.#read()).cases
      .filter((c) => c.ownedBy === ownerId && (!filter.status || c.status === filter.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getCase(ownerId: string, caseId: string): Promise<Case | null> {
    assertOwnerId(ownerId);
    return (await this.#read()).cases.find((c) => isOwnCase(c, ownerId, caseId)) ?? null;
  }

  async listItems(ownerId: string, caseId: string): Promise<CaseItem[]> {
    assertOwnerId(ownerId);
    const data = await this.#read();
    if (!data.cases.some((c) => isOwnCase(c, ownerId, caseId))) return [];
    return data.items.filter((i) => isOwnItem(i, ownerId, caseId));
  }

  async countItems(ownerId: string): Promise<Map<string, number>> {
    assertOwnerId(ownerId);
    const data = await this.#read();
    const own = new Set(data.cases.filter((c) => c.ownedBy === ownerId).map((c) => c.id));
    const counts = new Map<string, number>();
    for (const item of data.items) {
      if (item.ownedBy === ownerId && own.has(item.caseId)) counts.set(item.caseId, (counts.get(item.caseId) ?? 0) + 1);
    }
    return counts;
  }

  createCase(ownerId: string, newCase: Case): Promise<CreateCaseOutcome> {
    assertOwnerId(ownerId);
    if (newCase.ownedBy !== ownerId) throw new Error("case store: a new case must be owned by the caller");
    return this.#mutate((data): { result: CreateCaseOutcome; changed: boolean } => {
      // Counted inside the write lock, so concurrent creates can't overshoot the limit together.
      if (data.cases.filter((c) => c.ownedBy === ownerId).length >= this.#casesPerUser) {
        return { result: { ok: false, reason: "limit_reached" }, changed: false };
      }
      data.cases.push(newCase);
      return { result: { ok: true, case: newCase }, changed: true };
    });
  }

  updateCase(ownerId: string, caseId: string, change: CaseChange, at: string): Promise<UpdateCaseOutcome> {
    assertOwnerId(ownerId);
    return this.#mutate((data): { result: UpdateCaseOutcome; changed: boolean } => {
      const index = data.cases.findIndex((c) => isOwnCase(c, ownerId, caseId));
      const existing = data.cases[index];
      if (!existing) return { result: { ok: false, reason: "not_found" }, changed: false };

      let updated: Case;
      if (change.kind === "details") {
        if (existing.status === "closed") return { result: { ok: false, reason: "case_closed" }, changed: false };
        updated = {
          ...existing,
          ...(change.title === undefined ? {} : { title: change.title }),
          ...(change.description === undefined ? {} : { description: change.description }),
          updatedAt: at,
        };
      } else if (change.status === "closed") {
        if (existing.status === "closed") return { result: { ok: false, reason: "case_closed" }, changed: false };
        updated = { ...existing, status: "closed", closedAt: at, updatedAt: at };
      } else {
        if (existing.status === "open") return { result: { ok: false, reason: "case_not_closed" }, changed: false };
        updated = { ...existing, status: "open", closedAt: null, updatedAt: at };
      }
      data.cases[index] = updated;
      return { result: { ok: true, case: updated }, changed: true };
    });
  }

  deleteCase(ownerId: string, caseId: string): Promise<boolean> {
    assertOwnerId(ownerId);
    return this.#mutate((data) => {
      if (!data.cases.some((c) => isOwnCase(c, ownerId, caseId))) return { result: false, changed: false };
      data.cases = data.cases.filter((c) => !isOwnCase(c, ownerId, caseId));
      data.items = data.items.filter((i) => !isOwnItem(i, ownerId, caseId));
      return { result: true, changed: true };
    });
  }

  addItem(ownerId: string, caseId: string, item: NewItem, at: string): Promise<AddItemOutcome> {
    assertOwnerId(ownerId);
    return this.#mutate((data): { result: AddItemOutcome; changed: boolean } => {
      const caseIndex = data.cases.findIndex((c) => isOwnCase(c, ownerId, caseId));
      const existing = data.cases[caseIndex];
      if (!existing) return { result: { ok: false, reason: "not_found" }, changed: false };
      if (existing.status === "closed") return { result: { ok: false, reason: "case_closed" }, changed: false };
      const items = data.items.filter((i) => isOwnItem(i, ownerId, caseId));
      if (items.some((i) => i.chain === item.chain && i.address === item.address)) {
        return { result: { ok: false, reason: "duplicate_item" }, changed: false };
      }
      if (items.length >= this.#itemsPerCase) return { result: { ok: false, reason: "limit_reached" }, changed: false };

      const stored: CaseItem = { ...item, caseId, ownedBy: ownerId, addedAt: at, updatedAt: at };
      const updatedCase: Case = { ...existing, updatedAt: at };
      data.items.push(stored);
      data.cases[caseIndex] = updatedCase;
      return { result: { ok: true, item: stored, case: updatedCase }, changed: true };
    });
  }

  updateItemNote(ownerId: string, caseId: string, itemId: string, note: string, at: string): Promise<ItemChangeOutcome> {
    assertOwnerId(ownerId);
    return this.#mutate((data): { result: ItemChangeOutcome; changed: boolean } => {
      const caseIndex = data.cases.findIndex((c) => isOwnCase(c, ownerId, caseId));
      const existing = data.cases[caseIndex];
      if (!existing) return { result: { ok: false, reason: "not_found" }, changed: false };
      const itemIndex = data.items.findIndex((i) => i.id === itemId && isOwnItem(i, ownerId, caseId));
      const item = data.items[itemIndex];
      if (!item) return { result: { ok: false, reason: "item_not_found" }, changed: false };
      if (existing.status === "closed") return { result: { ok: false, reason: "case_closed" }, changed: false };

      const updatedItem: CaseItem = { ...item, note, updatedAt: at };
      const updatedCase: Case = { ...existing, updatedAt: at };
      data.items[itemIndex] = updatedItem;
      data.cases[caseIndex] = updatedCase;
      return { result: { ok: true, item: updatedItem, case: updatedCase }, changed: true };
    });
  }

  removeItem(ownerId: string, caseId: string, itemId: string, at: string): Promise<RemoveItemOutcome> {
    assertOwnerId(ownerId);
    return this.#mutate((data): { result: RemoveItemOutcome; changed: boolean } => {
      const caseIndex = data.cases.findIndex((c) => isOwnCase(c, ownerId, caseId));
      const existing = data.cases[caseIndex];
      if (!existing) return { result: { ok: false, reason: "not_found" }, changed: false };
      if (!data.items.some((i) => i.id === itemId && isOwnItem(i, ownerId, caseId))) {
        return { result: { ok: false, reason: "item_not_found" }, changed: false };
      }
      if (existing.status === "closed") return { result: { ok: false, reason: "case_closed" }, changed: false };

      data.items = data.items.filter((i) => !(i.id === itemId && isOwnItem(i, ownerId, caseId)));
      const updatedCase: Case = { ...existing, updatedAt: at };
      data.cases[caseIndex] = updatedCase;
      return { result: { ok: true, case: updatedCase }, changed: true };
    });
  }
}
