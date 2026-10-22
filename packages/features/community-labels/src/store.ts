import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { addressKey, type AccountId, type Address } from "@osstrace/core";
import type { ConfirmedSubmission, PendingSubmission, RejectedSubmission, Submission, SubmissionStatus } from "./types.ts";

export interface SubmissionFilter {
  status?: SubmissionStatus;
  submittedBy?: AccountId;
  address?: Address;
}

/**
 * A per-account cap on how many submissions may be *created* after `since` (ISO 8601, exclusive:
 * a submission made exactly one window ago has just aged out).
 * Every status counts — a submission that was later rejected still took a moderator's time.
 */
export interface CreateRateLimit {
  max: number;
  since: string;
}

export type CreateOutcome =
  | { ok: true }
  | { ok: false; reason: "duplicate" }
  /** `oldestInWindow`: submittedAt of the counted submission whose ageing out frees the next slot, so the caller can say when. */
  | { ok: false; reason: "rate_limited"; oldestInWindow: string };

/** A review decision, applied only if the submission is still pending. */
export type ReviewDecision =
  | { status: "confirmed"; reviewedBy: AccountId; reviewedAt: string }
  | { status: "rejected"; reviewedBy: AccountId; reviewedAt: string; rejectionReason: string };

export type ReviewOutcome =
  | { ok: true; submission: ConfirmedSubmission | RejectedSubmission }
  | { ok: false; reason: "not_found" | "already_reviewed" | "own_submission"; submission?: Submission };

export interface SubmissionStore {
  get(id: string): Promise<Submission | null>;
  /** Matching submissions in submission order (oldest first). */
  list(filter?: SubmissionFilter): Promise<Submission[]>;
  /**
   * Adds a pending submission. Refuses (`"duplicate"`) if the same account already has a
   * *pending* submission for the same address, and (`"rate_limited"`) if `limit` is given and the
   * account already created `limit.max` submissions since `limit.since`. Both are checked inside
   * the write lock, so concurrent requests can't each squeeze past the limit.
   */
  create(submission: PendingSubmission, limit?: CreateRateLimit): Promise<CreateOutcome>;
  /**
   * Applies a review decision atomically: refuses if the submission doesn't exist, was already
   * reviewed (so two moderators can't both decide it), or was submitted by the reviewer.
   */
  review(id: string, decision: ReviewDecision): Promise<ReviewOutcome>;
}

interface SubmissionsFile {
  version: 1;
  submissions: Submission[];
}

function emptyFile(): SubmissionsFile {
  return { version: 1, submissions: [] };
}

function matches(submission: Submission, filter: SubmissionFilter): boolean {
  if (filter.status && submission.status !== filter.status) return false;
  if (filter.submittedBy && submission.submittedBy !== filter.submittedBy) return false;
  if (filter.address && addressKey(submission.address) !== addressKey(filter.address)) return false;
  return true;
}

/**
 * File-backed JSON submission store — the same tradeoff as `JsonFileLabelStore` (no database
 * setup for a first-time contributor; a database is a same-interface swap later), with the
 * concurrency rules of `JsonFileAccountStore`, because unlike the read-mostly ingested datasets
 * this file is written by a live server while other processes read it:
 *
 * - **Re-reads the file on every call**, so the Explorer and Visualizer (separate processes that
 *   read this file through `CommunityLabelReader`) see a submission or a confirmation on their
 *   very next lookup, and this process can't overwrite a newer file with a stale copy.
 * - **Serializes writes** within the process, so two concurrent submissions or two moderators
 *   reviewing at once can't drop each other's write.
 * - **Writes atomically** (temp file + rename), so a reader never sees a half-written file.
 *
 * Not credentials, so not `0600` — but it does link account ids to submissions, and it's runtime
 * instance data rather than repo seed data, so its default location (`data/community/`) is
 * git-ignored. Only one *process* should write it (the community-labels server).
 */
export class JsonFileSubmissionStore implements SubmissionStore {
  readonly #path: string;
  #writeChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.#path = filePath;
  }

  async #read(): Promise<SubmissionsFile> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw cause;
    }
    const parsed = JSON.parse(raw) as SubmissionsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.submissions)) {
      throw new Error(`${this.#path} is not a version-1 community submissions file`);
    }
    return parsed;
  }

  async #write(data: SubmissionsFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmp, this.#path);
  }

  #mutate<T>(fn: (data: SubmissionsFile) => { result: T; changed: boolean }): Promise<T> {
    const run = this.#writeChain.then(async () => {
      const data = await this.#read();
      const { result, changed } = fn(data);
      if (changed) await this.#write(data);
      return result;
    });
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  async get(id: string): Promise<Submission | null> {
    return (await this.#read()).submissions.find((s) => s.id === id) ?? null;
  }

  async list(filter: SubmissionFilter = {}): Promise<Submission[]> {
    return (await this.#read()).submissions.filter((s) => matches(s, filter));
  }

  create(submission: PendingSubmission, limit?: CreateRateLimit): Promise<CreateOutcome> {
    return this.#mutate((data): { result: CreateOutcome; changed: boolean } => {
      const key = addressKey(submission.address);
      const duplicate = data.submissions.some(
        (s) => s.status === "community" && s.submittedBy === submission.submittedBy && addressKey(s.address) === key,
      );
      if (duplicate) return { result: { ok: false, reason: "duplicate" }, changed: false };
      if (limit) {
        const sinceMs = Date.parse(limit.since);
        const recent = data.submissions
          .filter((s) => s.submittedBy === submission.submittedBy && Date.parse(s.submittedAt) > sinceMs)
          .map((s) => s.submittedAt)
          .sort();
        if (recent.length >= limit.max) {
          // A slot frees up when enough of them age out that fewer than `max` remain.
          const freesAt = recent[recent.length - limit.max] ?? limit.since;
          return { result: { ok: false, reason: "rate_limited", oldestInWindow: freesAt }, changed: false };
        }
      }
      data.submissions.push(submission);
      return { result: { ok: true }, changed: true };
    });
  }

  review(id: string, decision: ReviewDecision): Promise<ReviewOutcome> {
    return this.#mutate((data): { result: ReviewOutcome; changed: boolean } => {
      const index = data.submissions.findIndex((s) => s.id === id);
      const existing = data.submissions[index];
      if (!existing) return { result: { ok: false, reason: "not_found" }, changed: false };
      if (existing.status !== "community") {
        return { result: { ok: false, reason: "already_reviewed", submission: existing }, changed: false };
      }
      if (existing.submittedBy === decision.reviewedBy) {
        return { result: { ok: false, reason: "own_submission", submission: existing }, changed: false };
      }
      const updated: ConfirmedSubmission | RejectedSubmission = { ...existing, ...decision };
      data.submissions[index] = updated;
      return { result: { ok: true, submission: updated }, changed: true };
    });
  }
}
