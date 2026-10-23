import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TraceDoc, TraceEdge, TraceNode, TracerAgentChatResponse, TracerAgentStatus } from "@osstrace/contract";
import type { Ctx } from "../context.ts";
import { ApiErr, badRequest, conflict, unauthorized } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { anonTraceDoc, parse } from "../schemas.ts";
import { sha256 } from "../auth/sessions.ts";
import { loadDoc, ownedTrace, toTrace } from "../services/traces.ts";
import { clearHistory, loadHistory, runAgentTurn, saveTurn, type AgentTurn } from "../services/tracerAgent/agent.ts";
import { SavedAgentDoc, SCRATCH_DOC_ID, ScratchAgentDoc, type AgentDoc } from "../services/tracerAgent/doc.ts";
import { ANON_AGENT_COOKIE, ANON_MESSAGE_LIMIT, anonCookieOpts, anonRemaining, refundAnonMessage, reserveAnonMessage, reserveUserMessage } from "../services/tracerAgent/limits.ts";
import type { AgentLlm } from "../services/tracerAgent/openrouter.ts";

const chatBody = z.object({
  docId: z.string().min(1).max(128),
  message: z.string().trim().min(1, "message is empty").max(2000, "message is too long (2000 characters max)"),
  doc: anonTraceDoc.optional(),
});

/** A scratch canvas as its browser sent it, filled out to the reducer's TraceDoc shape. It's the
 *  caller's own data being handed back to them, so it's only normalized, not re-derived. */
function scratchDoc(d: z.infer<typeof anonTraceDoc>): TraceDoc {
  const now = nowIso();
  const nodes = d.nodes.map((n) => ({ ...n, createdAt: n.createdAt ?? now }) as TraceNode);
  const edges = d.edges.map((e): TraceEdge => {
    if (e.kind === "transfer") return { ...e, createdAt: e.createdAt ?? now } as TraceEdge;
    const a = e.aggregate ?? {};
    return {
      id: e.id,
      kind: "aggregate",
      fromNodeID: e.fromNodeID,
      toNodeID: e.toNodeID,
      createdAt: e.createdAt ?? now,
      aggregate: { cachedUSDIn: a.cachedUSDIn ?? 0, cachedTransactionCountIn: a.cachedTransactionCountIn ?? 0, cachedUSDOut: a.cachedUSDOut ?? 0, cachedTransactionCountOut: a.cachedTransactionCountOut ?? 0, cachedAt: a.cachedAt ?? now },
    };
  });
  return { title: d.title, notes: d.notes, shareable: false, nodes, edges };
}

export function registerTracerAgent(app: FastifyInstance, ctx: Ctx, llm: AgentLlm | null) {
  /** One message at a time per conversation: keeps history ordered and two tabs from racing on one trace. */
  const inFlight = new Set<string>();

  const notConfigured = () => new ApiErr("not_configured", "The Tracer AI agent isn't set up on this server yet (no model provider key is configured).");

  app.get("/api/tracer-agent/status", async (req): Promise<TracerAgentStatus> => {
    const signedIn = !!req.user;
    return {
      configured: llm !== null,
      signedIn,
      messageLimit: signedIn ? null : ANON_MESSAGE_LIMIT,
      messagesRemaining: signedIn ? null : anonRemaining(ctx.db, req.cookies[ANON_AGENT_COOKIE]),
    };
  });

  app.post("/api/tracer-agent/chat", async (req, reply): Promise<TracerAgentChatResponse> => {
    // Checked first, before anything is counted: a deployment without the key answers honestly and
    // costs the visitor nothing.
    if (!llm) throw notConfigured();
    const body = parse(chatBody, req.body ?? {});
    const user = req.user;

    // The document is fixed here, from the caller's own session, before the model ever runs -- see
    // agent.ts's runAgentTurn for why that matters.
    let doc: AgentDoc;
    if (body.docId === SCRATCH_DOC_ID) {
      if (!body.doc) throw badRequest("doc: a local-only (scratch) trace has no server copy, so its current doc must be sent with the message");
      doc = new ScratchAgentDoc(ctx, user?.id ?? null, scratchDoc(body.doc));
    } else {
      if (!user) throw unauthorized();
      doc = new SavedAgentDoc(ctx, user.id, body.docId);
    }

    const anonToken = req.cookies[ANON_AGENT_COOKIE];
    const lockKey = user ? `user:${user.id}` : `anon:${anonToken ? sha256(anonToken) : req.ip}`;
    if (inFlight.has(lockKey)) throw conflict("Still working on your previous message.");
    inFlight.add(lockKey);
    try {
      let remaining: number | null = null;
      let anonHash: string | null = null;
      if (user) {
        reserveUserMessage(ctx.db, req.ip, user.id);
      } else {
        const r = reserveAnonMessage(ctx.db, req.ip, anonToken);
        if (r.newToken) reply.setCookie(ANON_AGENT_COOKIE, r.newToken, anonCookieOpts(ctx.config));
        remaining = r.remaining;
        anonHash = r.tokenHash;
      }
      const convKey = user ? `u:${user.id}:${doc.traceId}` : `a:${anonHash}:${doc.traceId}`;

      let turn: AgentTurn;
      try {
        turn = await runAgentTurn({ ctx, llm, doc, userId: user?.id ?? null, history: loadHistory(ctx, convKey), message: body.message });
      } catch (e) {
        // The provider never answered at all: don't charge an anon visitor one of their five for it.
        if (anonHash) refundAnonMessage(ctx.db, anonHash);
        throw e;
      }
      saveTurn(ctx, convKey, body.message, turn);

      let after: TracerAgentChatResponse["doc"];
      if (doc.kind === "saved") {
        // Re-checked, not assumed: the trace can be deleted (another tab) while the turn runs -- a 404, not a crash.
        const row = ownedTrace(ctx, user!.id, doc.traceId);
        after = toTrace(ctx, row, loadDoc(ctx, row), true);
      } else {
        const { posTs: _internal, ...rest } = doc.read();
        after = rest;
      }
      return { reply: turn.reply, toolCalls: turn.toolCalls, messagesRemaining: remaining, ops: doc.applied, doc: after };
    } finally {
      inFlight.delete(lockKey);
    }
  });

  app.delete<{ Params: { docId: string } }>("/api/tracer-agent/chat/:docId", async (req, reply) => {
    const token = req.cookies[ANON_AGENT_COOKIE];
    if (req.user) clearHistory(ctx, `u:${req.user.id}:${req.params.docId}`);
    else if (token && token.length <= 100) clearHistory(ctx, `a:${sha256(token)}:${req.params.docId}`);
    return reply.status(204).send();
  });
}
