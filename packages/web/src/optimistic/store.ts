/**
 * Framework-agnostic optimistic document engine.
 *
 * - Every edit is a transaction {doOps, undoOps}. It is applied locally at once (optimistic) and sent
 *   through ONE serial queue, so at most one batch request is in flight per document, in order.
 * - local = applyOps(remote, ops of every in-flight transaction + committed transactions newer than remote).
 *   The rebase rule drops committed transactions whose committedAt <= remote.updatedAt (the server copy has them).
 * - Batches are split into chunks of maxOpsPerRequest (500), sent sequentially.
 * - Failure: the transaction is removed (local rolls back), undo records that point at it are dropped, the
 *   document is refetched. No retry.
 * - Undo/redo: depth 30, a replay is a NEW transaction through the same queue. A failed replay clears both
 *   stacks and refetches.
 * - Scratch mode (localOnly): dispatch never hits the network; ops are applied to the in-memory "remote".
 */

export type TxnStatus = "in-flight" | "committed";

export type Transaction<O> = {
  id: number;
  label: string;
  doOps: O[];
  undoOps: O[];
  status: TxnStatus;
  committedAt?: string;
};

export type UndoRecord<O> = { label: string; doOps: O[]; undoOps: O[]; txnId?: number };

export type DispatchResult = { updatedAt: string };

export type OptimisticConfig<D, O> = {
  applyOps: (doc: D, ops: O[]) => D;
  /** Network dispatch for one chunk. Ignored in localOnly mode. */
  dispatch?: (ops: O[]) => Promise<DispatchResult>;
  /** Scratch documents: apply to the in-memory remote, never call the network. */
  localOnly?: boolean;
  maxOpsPerRequest?: number;
  undoDepth?: number;
  /** Called on replayed undo/redo ops (e.g. stamp a fresh clientTimestamp). */
  prepareReplay?: (ops: O[]) => O[];
  /** Keep derived/transient data from the previous local copy. */
  decorate?: (next: D, prev: D | null) => D;
  /** Return false to skip the refetch after a successful commit (e.g. position-only batches). */
  refetchAfterCommit?: (ops: O[]) => boolean;
  /** Remove undo ops that would recreate something whose create is still in flight. */
  sanitizeUndo?: (undoOps: O[], doOps: O[], inFlight: Transaction<O>[]) => O[];
  /** Ask the owner to refetch the remote document. */
  invalidate?: () => void;
  onError?: (err: unknown, txn: Transaction<O>) => void;
};

export type BeginOptions<O> = {
  label: string;
  doOps: O[];
  undoOps?: O[];
  pushToUndoStack?: boolean;
};

export type Snapshot<D> = {
  doc: D | null;
  isSaving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  lastSavedAt: string | null;
  lastError: string | null;
};

const DEFAULT_MAX_OPS = 500;
const DEFAULT_UNDO_DEPTH = 30;

export function chunk<T>(xs: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** ISO timestamps from the server are the same format and UTC, so string order equals time order. */
const notAfter = (a: string, b: string) => a <= b;

export class OptimisticDocumentStore<D, O> {
  private remote: D | null = null;
  private remoteUpdatedAt: string | null = null;
  private txns: Transaction<O>[] = [];
  private local: D | null = null;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private undoStack: UndoRecord<O>[] = [];
  private redoStack: UndoRecord<O>[] = [];
  private listeners = new Set<() => void>();
  private snapshot: Snapshot<D>;
  private lastSavedAt: string | null = null;
  private lastError: string | null = null;
  private localClock = 0;
  private cfg: OptimisticConfig<D, O>;

  constructor(cfg: OptimisticConfig<D, O>) {
    this.cfg = cfg;
    this.snapshot = this.buildSnapshot();
  }

  configure(cfg: Partial<OptimisticConfig<D, O>>) {
    this.cfg = { ...this.cfg, ...cfg };
  }

  // ---------- subscription ----------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;
  getDoc = () => this.local;
  getTransactions = () => this.txns;

  private emit() {
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l();
  }

  private buildSnapshot(): Snapshot<D> {
    return {
      doc: this.local,
      isSaving: this.txns.some((t) => t.status === "in-flight"),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
      lastSavedAt: this.lastSavedAt,
      lastError: this.lastError,
    };
  }

  // ---------- remote ----------
  /** Feed the latest server copy (e.g. from a query hook). Triggers the rebase. */
  setRemote(doc: D, updatedAt: string) {
    this.remote = doc;
    this.remoteUpdatedAt = updatedAt;
    if (!this.lastSavedAt || updatedAt > this.lastSavedAt) this.lastSavedAt = updatedAt;
    this.recompute();
  }

  /** Patch the remote copy in place (e.g. a refreshed aggregate edge) without a refetch. */
  patchRemote(fn: (doc: D) => D) {
    if (this.remote === null) return;
    this.remote = fn(this.remote);
    this.recompute();
  }

  private recompute() {
    if (this.remote === null) {
      this.local = null;
      this.emit();
      return;
    }
    const ru = this.remoteUpdatedAt;
    // rebase rule: committed transactions already contained in the server copy are dropped for good
    this.txns = this.txns.filter((t) => !(t.status === "committed" && t.committedAt && ru && notAfter(t.committedAt, ru)));
    const ops = this.txns.flatMap((t) => t.doOps);
    let next = ops.length ? this.cfg.applyOps(this.remote, ops) : this.remote;
    if (this.cfg.decorate) next = this.cfg.decorate(next, this.local);
    this.local = next;
    this.emit();
  }

  // ---------- transactions ----------
  beginTransaction(opts: BeginOptions<O>): Promise<boolean> {
    const { label, doOps, pushToUndoStack = true } = opts;
    if (doOps.length === 0) return Promise.resolve(true);
    const inFlight = this.txns.filter((t) => t.status === "in-flight");
    let undoOps = opts.undoOps ?? [];
    if (this.cfg.sanitizeUndo) undoOps = this.cfg.sanitizeUndo(undoOps, doOps, inFlight);
    const txn: Transaction<O> = { id: ++this.seq, label, doOps, undoOps, status: "in-flight" };
    this.txns = [...this.txns, txn];
    if (pushToUndoStack) this.pushRecord({ label, doOps, undoOps, txnId: txn.id });
    this.recompute();
    return this.enqueue(txn);
  }

  /** Register an undo record without sending anything (drag: the persist batch is a separate transaction). */
  pushUndoRecord(rec: UndoRecord<O>) {
    this.pushRecord(rec);
    this.emit();
  }

  private pushRecord(rec: UndoRecord<O>) {
    const depth = this.cfg.undoDepth ?? DEFAULT_UNDO_DEPTH;
    this.undoStack = [...this.undoStack, rec].slice(-depth);
    this.redoStack = [];
  }

  private enqueue(txn: Transaction<O>, onFail?: () => void): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      try {
        const max = this.cfg.maxOpsPerRequest ?? DEFAULT_MAX_OPS;
        let updatedAt = "";
        for (const part of chunk(txn.doOps, max)) {
          const res = await this.send(part);
          updatedAt = res.updatedAt;
        }
        this.txns = this.txns.map((t) => (t.id === txn.id ? { ...t, status: "committed", committedAt: updatedAt } : t));
        this.lastSavedAt = updatedAt;
        this.lastError = null;
        this.recompute();
        if (!this.cfg.localOnly && (this.cfg.refetchAfterCommit?.(txn.doOps) ?? true)) this.cfg.invalidate?.();
        return true;
      } catch (err) {
        this.txns = this.txns.filter((t) => t.id !== txn.id);
        this.undoStack = this.undoStack.filter((r) => r.txnId !== txn.id);
        this.redoStack = this.redoStack.filter((r) => r.txnId !== txn.id);
        this.lastError = err instanceof Error ? err.message : String(err);
        onFail?.();
        this.recompute();
        this.cfg.onError?.(err, txn);
        this.cfg.invalidate?.();
        return false;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async send(ops: O[]): Promise<DispatchResult> {
    if (this.cfg.localOnly) {
      if (this.remote === null) throw new Error("scratch document not initialised");
      this.remote = this.cfg.applyOps(this.remote, ops);
      this.remoteUpdatedAt = this.nextLocalStamp();
      return { updatedAt: this.remoteUpdatedAt };
    }
    if (!this.cfg.dispatch) throw new Error("no dispatch configured");
    return this.cfg.dispatch(ops);
  }

  /** Strictly increasing ISO stamps for scratch documents. */
  private nextLocalStamp() {
    const now = Math.max(Date.now(), this.localClock + 1);
    this.localClock = now;
    return new Date(now).toISOString();
  }

  // ---------- undo / redo ----------
  undo(): Promise<boolean> {
    const rec = this.undoStack.at(-1);
    if (!rec) return Promise.resolve(false);
    this.undoStack = this.undoStack.slice(0, -1);
    return this.replay(rec, "undo");
  }

  redo(): Promise<boolean> {
    const rec = this.redoStack.at(-1);
    if (!rec) return Promise.resolve(false);
    this.redoStack = this.redoStack.slice(0, -1);
    return this.replay(rec, "redo");
  }

  private replay(rec: UndoRecord<O>, kind: "undo" | "redo"): Promise<boolean> {
    const raw = kind === "undo" ? rec.undoOps : rec.doOps;
    const ops = this.cfg.prepareReplay ? this.cfg.prepareReplay(raw) : raw;
    const txn: Transaction<O> = { id: ++this.seq, label: `${kind === "undo" ? "Undo" : "Redo"} ${rec.label}`, doOps: ops, undoOps: [], status: "in-flight" };
    const moved: UndoRecord<O> = { ...rec, txnId: txn.id };
    if (kind === "undo") this.redoStack = [...this.redoStack, moved];
    else this.undoStack = [...this.undoStack, moved];
    if (ops.length === 0) {
      this.emit();
      return Promise.resolve(true);
    }
    this.txns = [...this.txns, txn];
    this.recompute();
    return this.enqueue(txn, () => {
      this.undoStack = [];
      this.redoStack = [];
    });
  }

  clearHistory() {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /** Resolves once every queued transaction has settled. */
  flush(): Promise<void> {
    return this.queue.then(() => undefined);
  }
}
