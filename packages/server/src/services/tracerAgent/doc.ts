import { applyTraceOps, type TraceDoc, type TraceOp } from "@osstrace/contract";
import type { Ctx } from "../../context.ts";
import { nowIso } from "../../lib/time.ts";
import { commitTraceOps, loadDoc, ownedTrace, refreshChangedAggregates } from "../traces.ts";

/** The local-only canvas's fixed id (web: useTraceDocument.ts's SCRATCH_ID, ADR 0025). Deterministic
 *  node/edge ids for a scratch canvas are derived from it, exactly as they are client-side. */
export const SCRATCH_DOC_ID = "scratch";

/**
 * The one trace document a single agent turn may touch, and nothing else. Every tool reads and
 * writes through this handle; none of them is ever given a trace id, a user id or the db to pick a
 * different document with.
 */
export interface AgentDoc {
  readonly kind: "saved" | "scratch";
  readonly traceId: string;
  read(): TraceDoc;
  commit(ops: TraceOp[]): { applied: number; skipped: number };
  /** Every op committed this turn, in order (returned to the client). */
  readonly applied: TraceOp[];
}

/** A signed-in user's saved trace. Reads and writes go through the same owner-checked path as the
 *  canvas's own `/batch` (commitTraceOps), so the agent can't reach a trace its caller doesn't own. */
export class SavedAgentDoc implements AgentDoc {
  readonly kind = "saved" as const;
  readonly traceId: string;
  readonly applied: TraceOp[] = [];
  readonly #ctx: Ctx;
  readonly #userId: string;
  constructor(ctx: Ctx, userId: string, traceId: string) {
    this.#ctx = ctx;
    this.#userId = userId;
    this.traceId = traceId;
    ownedTrace(ctx, userId, traceId); // 404 up front for a trace that isn't the caller's
  }
  read(): TraceDoc {
    return loadDoc(this.#ctx, ownedTrace(this.#ctx, this.#userId, this.traceId));
  }
  commit(ops: TraceOp[]) {
    if (ops.length === 0) return { applied: 0, skipped: 0 };
    const r = commitTraceOps(this.#ctx, this.#userId, this.traceId, ops);
    this.applied.push(...ops);
    return { applied: r.applied, skipped: r.skipped };
  }
}

/**
 * A local-only canvas (ADR 0025): the browser sent its own current doc with the message, the agent
 * edits that copy in memory through the same shared reducer the browser runs, and the result goes
 * back in the response. Nothing is persisted -- there is no server-side row for a scratch canvas.
 * Aggregate edges get their numbers from the same server-side computation a saved trace's do.
 */
export class ScratchAgentDoc implements AgentDoc {
  readonly kind = "scratch" as const;
  readonly traceId = SCRATCH_DOC_ID;
  readonly applied: TraceOp[] = [];
  #doc: TraceDoc;
  readonly #ctx: Ctx;
  readonly #userId: string | null;
  constructor(ctx: Ctx, userId: string | null, doc: TraceDoc) {
    this.#ctx = ctx;
    this.#userId = userId;
    this.#doc = doc;
  }
  read(): TraceDoc {
    return this.#doc;
  }
  commit(ops: TraceOp[]) {
    if (ops.length === 0) return { applied: 0, skipped: 0 };
    const before = this.#doc;
    const r = applyTraceOps(before, ops);
    // An anon caller owns no entities, so "" resolves an entity node to no addresses -- same as it would for anyone else's.
    refreshChangedAggregates(this.#ctx, this.#userId ?? "", before, r.doc, nowIso());
    this.#doc = r.doc;
    this.applied.push(...ops);
    return { applied: r.applied, skipped: r.skipped };
  }
}
