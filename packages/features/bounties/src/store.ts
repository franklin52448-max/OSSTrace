import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountId } from "@osstrace/core";
import type { Bounty, BountyStatus, BountySubmission, ClaimedBounty, Deposit, OpenBounty } from "./types.ts";

export interface BountyFilter {
  status?: BountyStatus;
}

/** `claimedBy` isn't here — the store derives it from the winning submission's own `submittedBy`, not from the caller. */
export type ClaimDecision = { claimedAt: string; resolvedBy: AccountId };
export type ClaimOutcome =
  | { ok: true; bounty: ClaimedBounty }
  | { ok: false; reason: "bounty_not_found" | "not_open" | "submission_not_found" };

export type CancelDecision = { cancelledBy: AccountId; cancelledAt: string; cancellationReason: string };
export type CancelOutcome = { ok: true; bounty: Bounty & { status: "cancelled" } } | { ok: false; reason: "not_found" | "not_open" };

export interface BountyStore {
  getBounty(id: string): Promise<Bounty | null>;
  /** Matching bounties in posting order (oldest first). */
  listBounties(filter?: BountyFilter): Promise<Bounty[]>;
  createBounty(bounty: OpenBounty): Promise<void>;
  getSubmission(id: string): Promise<BountySubmission | null>;
  /** A bounty's submissions in submission order (oldest first). */
  listSubmissions(bountyId: string): Promise<BountySubmission[]>;
  createSubmission(submission: BountySubmission): Promise<void>;
  /**
   * Atomically: the bounty must exist and be `open`, and the submission must exist, belong to
   * this bounty, and still be `pending`. On success the bounty becomes `claimed`, that submission
   * becomes `accepted`, and every other submission on the bounty that was still `pending` becomes
   * `rejected` — a claimed bounty has exactly one accepted submission and no pending ones left.
   */
  claim(bountyId: string, submissionId: string, decision: ClaimDecision): Promise<ClaimOutcome>;
  /** Atomically: the bounty must exist and be `open`. On success it becomes `cancelled`. */
  cancel(bountyId: string, decision: CancelDecision): Promise<CancelOutcome>;
  /** The real transaction reference (Solana signature / Ethereum tx hash) already recorded as a deposit, on any bounty — or `null`. */
  findDepositByTxRef(chain: Deposit["chain"], txRef: string): Promise<Deposit | null>;
  /** A bounty's verified deposits, oldest first. */
  listDeposits(bountyId: string): Promise<Deposit[]>;
  createDeposit(deposit: Deposit): Promise<void>;
}

interface BountiesFile {
  version: 1;
  bounties: Bounty[];
  submissions: BountySubmission[];
  deposits: Deposit[];
}

function emptyFile(): BountiesFile {
  return { version: 1, bounties: [], submissions: [], deposits: [] };
}

/**
 * File-backed JSON store for bounties + their submissions — same concurrency contract as
 * `JsonFileSubmissionStore` in `@osstrace/community-labels`: re-reads on every call (so a second
 * process, or the web UI's next poll, sees a change immediately), serializes writes within this
 * process, and writes atomically (temp file + rename) so a reader never sees a half-written file.
 *
 * One file holds both collections — a bounty and its submissions are always read/written
 * together, and there's no case here where only one needs to be re-read independently.
 */
export class JsonFileBountyStore implements BountyStore {
  readonly #path: string;
  #writeChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.#path = filePath;
  }

  async #read(): Promise<BountiesFile> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw cause;
    }
    const parsed = JSON.parse(raw) as BountiesFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.bounties) || !Array.isArray(parsed.submissions)) {
      throw new Error(`${this.#path} is not a version-1 bounties file`);
    }
    // `deposits` is new (ADR 0020); a file written before it exists just hasn't got any yet,
    // not a different/invalid version — never reject a real, already-live file over an addition.
    if (!Array.isArray(parsed.deposits)) parsed.deposits = [];
    return parsed;
  }

  async #write(data: BountiesFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmp, this.#path);
  }

  #mutate<T>(fn: (data: BountiesFile) => { result: T; changed: boolean }): Promise<T> {
    const run = this.#writeChain.then(async () => {
      const data = await this.#read();
      const { result, changed } = fn(data);
      if (changed) await this.#write(data);
      return result;
    });
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  async getBounty(id: string): Promise<Bounty | null> {
    return (await this.#read()).bounties.find((b) => b.id === id) ?? null;
  }

  async listBounties(filter: BountyFilter = {}): Promise<Bounty[]> {
    const { bounties } = await this.#read();
    return filter.status ? bounties.filter((b) => b.status === filter.status) : bounties;
  }

  createBounty(bounty: OpenBounty): Promise<void> {
    return this.#mutate((data) => {
      data.bounties.push(bounty);
      return { result: undefined, changed: true };
    });
  }

  async getSubmission(id: string): Promise<BountySubmission | null> {
    return (await this.#read()).submissions.find((s) => s.id === id) ?? null;
  }

  async listSubmissions(bountyId: string): Promise<BountySubmission[]> {
    return (await this.#read()).submissions.filter((s) => s.bountyId === bountyId);
  }

  createSubmission(submission: BountySubmission): Promise<void> {
    return this.#mutate((data) => {
      data.submissions.push(submission);
      return { result: undefined, changed: true };
    });
  }

  claim(bountyId: string, submissionId: string, decision: ClaimDecision): Promise<ClaimOutcome> {
    return this.#mutate((data): { result: ClaimOutcome; changed: boolean } => {
      const bountyIndex = data.bounties.findIndex((b) => b.id === bountyId);
      const bounty = data.bounties[bountyIndex];
      if (!bounty) return { result: { ok: false, reason: "bounty_not_found" }, changed: false };
      if (bounty.status !== "open") return { result: { ok: false, reason: "not_open" }, changed: false };
      const submission = data.submissions.find((s) => s.id === submissionId && s.bountyId === bountyId);
      if (!submission) return { result: { ok: false, reason: "submission_not_found" }, changed: false };

      const claimed: ClaimedBounty = {
        ...bounty,
        status: "claimed",
        claimedSubmissionId: submissionId,
        claimedBy: submission.submittedBy,
        claimedAt: decision.claimedAt,
        resolvedBy: decision.resolvedBy,
      };
      data.bounties[bountyIndex] = claimed;
      data.submissions = data.submissions.map((s) => {
        if (s.id === submissionId) return { ...s, outcome: "accepted" };
        if (s.bountyId === bountyId && s.outcome === "pending") return { ...s, outcome: "rejected" };
        return s;
      });
      return { result: { ok: true, bounty: claimed }, changed: true };
    });
  }

  cancel(bountyId: string, decision: CancelDecision): Promise<CancelOutcome> {
    return this.#mutate((data): { result: CancelOutcome; changed: boolean } => {
      const index = data.bounties.findIndex((b) => b.id === bountyId);
      const bounty = data.bounties[index];
      if (!bounty) return { result: { ok: false, reason: "not_found" }, changed: false };
      if (bounty.status !== "open") return { result: { ok: false, reason: "not_open" }, changed: false };
      const cancelled = { ...bounty, status: "cancelled" as const, ...decision };
      data.bounties[index] = cancelled;
      return { result: { ok: true, bounty: cancelled }, changed: true };
    });
  }

  async findDepositByTxRef(chain: Deposit["chain"], txRef: string): Promise<Deposit | null> {
    const { deposits } = await this.#read();
    return deposits.find((d) => d.chain === chain && d.txRef === txRef) ?? null;
  }

  async listDeposits(bountyId: string): Promise<Deposit[]> {
    return (await this.#read()).deposits.filter((d) => d.bountyId === bountyId);
  }

  createDeposit(deposit: Deposit): Promise<void> {
    return this.#mutate((data) => {
      data.deposits.push(deposit);
      return { result: undefined, changed: true };
    });
  }
}
