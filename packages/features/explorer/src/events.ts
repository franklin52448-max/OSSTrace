import type { Address, TransactionSummary } from "@osstrace/core";

/**
 * What the background indexer publishes after it refetches addresses. Every field here comes from
 * a real `ChainAdapter` fetch the indexer was already making to keep the cache warm — nothing is
 * produced on a timer of its own. See ADR 0013.
 */
export type IndexerEvent = NewTransactionsEvent | CycleCompletedEvent;

export interface NewTransactionsEvent {
  type: "new_transactions";
  address: Address;
  /** Real transactions present in this fetch and absent from the previous one, oldest first. */
  transactions: TransactionSummary[];
  /** See `TransactionDiff.windowOverflow` — more may have happened than these. */
  windowOverflow: boolean;
  detectedAt: string;
}

export interface CycleCompletedEvent {
  type: "cycle_completed";
  /** `addressKey`s refreshed this cycle with transaction history available — these get live pushes. */
  live: string[];
  /** `addressKey`s the indexer tried this cycle but couldn't get transaction history for, and why. */
  notLive: { key: string; reason: string }[];
  /** How many top addresses the indexer refreshes per cycle (its `INDEXER_TOP_N`). */
  topN: number;
  intervalMs: number;
  /** How long this cycle took — the next starts `intervalMs` after it ends, so this sets the real cadence. */
  durationMs: number;
  completedAt: string;
}

/**
 * The one channel between the indexer and the websocket layer. `InMemoryEventBus` when both run
 * in one process; `RedisEventBus` (Redis pub/sub) when the indexer is its own process, which is
 * the documented setup — see the Explorer README.
 */
export interface IndexerEventBus {
  publish(event: IndexerEvent): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(handler: (event: IndexerEvent) => void): Promise<() => void>;
  close(): Promise<void>;
}

/** Synchronous fan-out within one process. Zero dependencies; what every test uses. */
export class InMemoryEventBus implements IndexerEventBus {
  readonly #handlers = new Set<(event: IndexerEvent) => void>();

  async publish(event: IndexerEvent): Promise<void> {
    for (const handler of [...this.#handlers]) handler(event);
  }

  async subscribe(handler: (event: IndexerEvent) => void): Promise<() => void> {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.#handlers.clear();
  }
}
