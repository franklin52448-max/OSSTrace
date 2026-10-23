import type { TraceOp, TracerAgentChatRequest, TracerAgentChatResponse, TracerAgentScratchDoc, TracerAgentStatus, TracerAgentToolCall } from "@osstrace/contract";
import { api, ApiRequestError } from "../../kit/api.ts";

// POST /api/tracer-agent/chat and GET /api/tracer-agent/status -- see @osstrace/contract's api.ts.
export type AgentScratchDoc = TracerAgentScratchDoc;
export type AgentToolCall = TracerAgentToolCall;
type AgentChatResponse = TracerAgentChatResponse;
export type AgentStatus = TracerAgentStatus;

/** Free messages a visitor without a wallet gets, used only until the server has said its own number. */
export const ANON_MESSAGE_LIMIT = 5;

export type AgentChatOutcome =
  | { kind: "ok"; reply: string; toolCalls: AgentToolCall[]; messagesRemaining: number | null; ops: TraceOp[]; doc: AgentScratchDoc | null }
  /** 503 not_configured: the server has no model key, so the agent genuinely isn't available. Nothing ran. */
  | { kind: "not-configured"; message: string }
  /** 429 for a visitor whose free messages are used up. Nothing ran. */
  | { kind: "limit"; message: string }
  | { kind: "error"; message: string; retryAfterSec?: number };

/** A 429 that's about the free-message allowance (vs. a generic "slow down"): the server's own words say so. */
const isAllowanceMessage = (msg: string) => /free .*messages|connect a wallet/i.test(msg);

export const getAgentStatus = () => api<AgentStatus>("/tracer-agent/status");

/**
 * Sends one message. Never invents a reply: anything other than a real 2xx body comes back as a
 * typed non-ok outcome that the panel shows as exactly what it is.
 */
export async function sendAgentMessage(docId: string, message: string, doc?: AgentScratchDoc): Promise<AgentChatOutcome> {
  try {
    const body: TracerAgentChatRequest = doc ? { docId, message, doc } : { docId, message };
    const r = await api<Partial<AgentChatResponse> | null>("/tracer-agent/chat", { method: "POST", json: body });
    if (!r || typeof r.reply !== "string") return { kind: "error", message: "The agent sent back a response this page can't read." };
    const toolCalls = (Array.isArray(r.toolCalls) ? r.toolCalls : []).filter((c): c is AgentToolCall => !!c && typeof c.tool === "string").map((c) => ({ tool: c.tool, args: obj(c.args), result: obj(c.result) }));
    const ops = Array.isArray(r.ops) ? r.ops.filter((o): o is TraceOp => !!o && typeof o === "object" && typeof (o as { type?: unknown }).type === "string") : [];
    const after = r.doc && Array.isArray(r.doc.nodes) && Array.isArray(r.doc.edges) ? r.doc : null;
    return { kind: "ok", reply: r.reply, toolCalls, messagesRemaining: typeof r.messagesRemaining === "number" ? r.messagesRemaining : null, ops, doc: after };
  } catch (err) {
    if (err instanceof ApiRequestError) {
      const message = err.body?.message;
      if (err.status === 503 || err.body?.code === "not_configured") return { kind: "not-configured", message: message ?? "The AI agent isn't turned on yet." };
      if (err.status === 429 && message && isAllowanceMessage(message)) return { kind: "limit", message };
      if (err.status === 429) return { kind: "error", message: message ?? "Too many messages, try again shortly.", retryAfterSec: err.retryAfterSec };
      if (err.status === 409) return { kind: "error", message: message ?? "Still working on your previous message." };
      return { kind: "error", message: message ?? `The agent request failed (HTTP ${err.status}).` };
    }
    return { kind: "error", message: "Could not reach the server." };
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
