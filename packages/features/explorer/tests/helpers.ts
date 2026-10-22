import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Balance, ChainAdapter, TransactionsResult, TransactionSummary } from "@osstrace/core";
import { WebSocket } from "ws";

/** A transaction fixture: `n` sets both the hash and the timestamp (n minutes after a fixed epoch). */
export function tx(n: number, overrides: Partial<TransactionSummary> = {}): TransactionSummary {
  return {
    chain: "ethereum",
    hash: `0xtx${n}`,
    timestamp: new Date(Date.UTC(2026, 9, 22, 12, n)).toISOString(),
    from: "0xsender",
    to: "0xwatched",
    valueNative: "1",
    direction: "in",
    ...overrides,
  };
}

/**
 * A concrete ChainAdapter stand-in (not a mocking framework): its transaction history is a plain
 * array the test edits between indexer cycles, newest first like the real adapters return it.
 * `result` can be swapped to an unavailable result; `calls` proves how often it's actually hit.
 */
export class ScriptedAdapter implements ChainAdapter {
  readonly chain = "ethereum" as const;
  history: TransactionSummary[] = [];
  unavailable: string | null = null;
  throwError: string | null = null;
  txCalls = 0;

  async getBalance(address: string): Promise<Balance> {
    return { chain: "ethereum", address, native: { symbol: "ETH", amount: "1", decimals: 18 }, asOf: "2026-10-22T12:00:00Z" };
  }

  async getRecentTransactions(_address: string, limit: number): Promise<TransactionsResult> {
    this.txCalls++;
    if (this.throwError) throw new Error(this.throwError);
    if (this.unavailable) return { available: false, reason: this.unavailable };
    return { available: true, transactions: this.history.slice(0, limit) };
  }

  /** A new transaction lands on chain: it goes to the front, like the newest entry from a real adapter. */
  land(t: TransactionSummary): void {
    this.history.unshift(t);
  }
}

export async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "explorer-stream-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A real ws client that queues every message it receives, so a test can await the next one. */
export class TestClient {
  readonly socket: WebSocket;
  readonly #queue: unknown[] = [];
  readonly #waiters: ((msg: unknown) => void)[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const msg: unknown = JSON.parse(data.toString());
      const waiter = this.#waiters.shift();
      if (waiter) waiter(msg);
      else this.#queue.push(msg);
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** The next message, or a rejection after `timeoutMs` — a missing push must fail the test, not hang it. */
  next<T = Record<string, unknown>>(timeoutMs = 2000): Promise<T> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i !== -1) this.#waiters.splice(i, 1);
        reject(new Error(`no message within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = (msg: unknown): void => {
        clearTimeout(timer);
        resolve(msg as T);
      };
      this.#waiters.push(waiter);
    });
  }

  /** Resolves true if nothing arrives within `ms` — proves something was *not* pushed. */
  async silentFor(ms: number): Promise<boolean> {
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}
