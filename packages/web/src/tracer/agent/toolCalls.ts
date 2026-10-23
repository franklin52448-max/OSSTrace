/**
 * How the agent's turn reaches the Tracer canvas, and how it's described in the chat.
 *
 * The server runs every tool against the trace with the same edit builders the canvas's own
 * buttons use (Find connections, add node, remove...: shared through @osstrace/contract) and
 * returns the ops it applied, in order. `agentEdit` turns those into one ordinary `Edit` that
 * TracerPage feeds to its `run` -- the store transaction every manual change goes through -- so
 * there's exactly one "the graph changed" path, and the agent's turn undoes like any other edit.
 * Running the builders again here instead would apply each change twice.
 *
 * `describeToolCall` only words what a tool reported (its real result fields); it never changes
 * anything and never claims more than the result says.
 */
import type { TraceDoc, TraceNode, TraceOp } from "@osstrace/contract";
import { shortAddress } from "../../kit/format.ts";
import { nodeTitle } from "../canvas/NodeCard.tsx";
import type { Edit } from "../lib/ops.ts";
import type { AgentScratchDoc, AgentToolCall } from "./api.ts";

/** What the panel needs from the page it's mounted in. */
export interface AgentCanvas {
  /** The id the server knows this trace by: a saved trace's uuid, or "scratch". */
  docId: string;
  /** The latest local document (including still-saving changes). */
  getDoc(): TraceDoc | null;
  /** Apply the ops the server reports for a turn, through the page's normal edit path. */
  applyAgentOps(ops: TraceOp[], after: AgentScratchDoc | null): Promise<boolean>;
}

export type AgentStepStatus = "applied" | "read" | "failed";
export type AgentStep = { tool: string; status: AgentStepStatus; summary: string; href?: string };

/** Undo ops for `ops`, computed against the document they're about to change. */
export function invertOps(doc: TraceDoc, ops: TraceOp[]): TraceOp[] {
  const undo: TraceOp[] = [];
  let nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  let edges = new Map(doc.edges.map((e) => [e.id, e]));
  for (const op of ops) {
    switch (op.type) {
      case "create_node":
        if (!nodes.has(op.node.id)) {
          undo.push({ type: "delete_node", id: op.node.id });
          nodes.set(op.node.id, op.node);
        }
        break;
      case "create_edge":
        if (!edges.has(op.edge.id)) {
          undo.push({ type: "delete_edge", id: op.edge.id });
          edges.set(op.edge.id, op.edge);
        }
        break;
      case "delete_node": {
        const n = nodes.get(op.id);
        if (!n) break;
        const touching = [...edges.values()].filter((e) => e.fromNodeID === n.id || e.toNodeID === n.id);
        // reversed below, so the node comes back before its edges
        undo.push(...touching.map((edge): TraceOp => ({ type: "create_edge", edge })), { type: "create_node", node: n });
        nodes = new Map([...nodes].filter(([id]) => id !== n.id));
        edges = new Map([...edges].filter(([, e]) => e.fromNodeID !== n.id && e.toNodeID !== n.id));
        break;
      }
      case "delete_edge": {
        const e = edges.get(op.id);
        if (e) {
          undo.push({ type: "create_edge", edge: e });
          edges.delete(e.id);
        }
        break;
      }
      case "set_node_color":
      case "set_node_label":
      case "set_node_note":
      case "update_node_size": {
        const n = nodes.get(op.id);
        if (!n) break;
        if (op.type === "set_node_color") undo.push({ type: "set_node_color", id: n.id, color: n.color ?? null });
        else if (op.type === "set_node_label") undo.push({ type: "set_node_label", id: n.id, label: n.label ?? null });
        else if (op.type === "set_node_note") undo.push({ type: "set_node_note", id: n.id, note: n.note ?? null });
        else undo.push({ type: "update_node_size", id: n.id, width: n.width ?? null, height: n.height ?? null });
        break;
      }
      case "set_title":
        undo.push({ type: "set_title", title: doc.title });
        break;
      case "set_notes":
        undo.push({ type: "set_notes", notes: doc.notes });
        break;
      default:
        break; // positions/endpoints/shareable aren't undone (same as a manual drag's persist batch)
    }
  }
  return undo.reverse();
}

/**
 * One edit for a turn's ops. Created nodes/edges are taken from the server's after-turn doc when it
 * has them, so the canvas gets the server's own numbers (an aggregate edge's totals are computed
 * server-side while the turn runs, after the op that created it).
 */
export function agentEdit(before: TraceDoc, ops: TraceOp[], after: AgentScratchDoc | null): Edit | null {
  if (ops.length === 0) return null;
  const afterNodes = new Map((after?.nodes ?? []).map((n) => [n.id, n]));
  const afterEdges = new Map((after?.edges ?? []).map((e) => [e.id, e]));
  const doOps = ops.map((op): TraceOp => {
    if (op.type === "create_node") return { ...op, node: afterNodes.get(op.node.id) ?? op.node };
    if (op.type === "create_edge") return { ...op, edge: afterEdges.get(op.edge.id) ?? op.edge };
    return op;
  });
  return { label: "Agent changes", doOps, undoOps: invertOps(before, doOps) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function nameOf(doc: TraceDoc | null, id: unknown, fallback?: unknown): string {
  const n: TraceNode | undefined = typeof id === "string" ? doc?.nodes.find((x) => x.id === id) : undefined;
  if (n) {
    const t = nodeTitle(n);
    return t.mono ? shortAddress(t.title, 6, 4) : t.title;
  }
  const a = str(fallback);
  return a ? shortAddress(a, 6, 4) : "a node";
}

/** Words for one tool call, from its own result. `doc` (the canvas after the turn) names nodes. */
export function describeToolCall(call: AgentToolCall, doc: TraceDoc | null): AgentStep {
  const { tool, result: r } = call;
  const step = (status: AgentStepStatus, summary: string, href?: string): AgentStep => ({ tool, status, summary, ...(href ? { href } : {}) });
  if (r["ok"] === false) return step("failed", str(r["error"]) ?? "This step didn't work.");

  switch (tool) {
    case "add_node": {
      const name = nameOf(doc, r["nodeId"], r["address"]);
      return r["alreadyOnCanvas"] ? step("read", `${name} was already on the canvas`) : step("applied", `Added ${name}`);
    }
    case "find_connections": {
      const conns = Array.isArray(r["connections"]) ? r["connections"].length : 0;
      const edges = num(r["edgesAdded"]) ?? 0;
      const leads = Array.isArray(r["indirectLeads"]) ? r["indirectLeads"].length : 0;
      const parts = [conns ? `Found ${plural(conns, "direct connection")}` : "No direct connections found"];
      if (edges) parts.push(`drew ${plural(edges, "edge")}`);
      const undrawn = num(r["transfersNotDrawnTraceFull"]) ?? 0;
      if (undrawn) parts.push(`${plural(undrawn, "transfer")} not drawn (the trace is full)`);
      if (leads) parts.push(`${plural(leads, "possible indirect link")} (shared counterparties, not drawn)`);
      const failed = (num(r["pairsFailed"]) ?? 0) + (num(r["pairsSkippedForTime"]) ?? 0);
      if (failed) parts.push(`${plural(failed, "pair")} couldn't be checked`);
      return step(edges ? "applied" : "read", parts.join(", "));
    }
    case "expand_node": {
      const nodes = num(r["nodesAdded"]) ?? 0;
      const edges = num(r["edgesAdded"]) ?? 0;
      // "Stopped short" is the result's own word for nodes it didn't get to (budget, provider errors,
      // a full trace); an incompletely loaded history is a different caveat and is worded as itself.
      const stoppedShort = /stopped short/i.test(str(r["note"]) ?? "");
      const partialHistory = num(r["nodesWithPartialHistory"]) ?? 0;
      const base = nameOf(doc, r["rootNodeId"]);
      const summary = nodes || edges ? `Expanded ${base}: ${plural(nodes, "node")}, ${plural(edges, "edge")} added` : `Expanded ${base}: nothing new to add`;
      const caveats = [stoppedShort ? "partial: some nodes couldn't be expanded" : null, partialHistory ? "ranked from history that isn't fully loaded yet" : null].filter(Boolean);
      return step(nodes || edges ? "applied" : "read", caveats.length ? `${summary} (${caveats.join("; ")})` : summary);
    }
    case "list_transfers": {
      const n = Array.isArray(r["transfers"]) ? r["transfers"].length : 0;
      const sorted = str(r["sortedBy"]);
      return step("read", `Looked at ${plural(n, "transfer")}${sorted ? `, sorted by ${sorted}` : ""}`);
    }
    case "remove_node": {
      const edges = num(r["edgesRemoved"]);
      return step("applied", `Removed a node${edges ? ` and ${plural(edges, "edge")}` : ""}`);
    }
    case "rename_node": {
      const label = str(r["label"]);
      return step("applied", label ? `Renamed a node to "${label}"` : "Cleared a node's name");
    }
    case "annotate_node":
      return step("applied", str(r["note"]) ? `Added a note on ${nameOf(doc, r["nodeId"])}` : `Cleared the note on ${nameOf(doc, r["nodeId"])}`);
    case "get_doc_state":
      return step("read", "Read the canvas");
    case "open_trace_doc": {
      const url = str(r["url"]);
      const href = url && url.startsWith("#trace/") ? url : undefined;
      return step("read", r["persistent"] === false ? "This canvas is local-only: connect a wallet to save it" : "Link to this trace", href);
    }
    default:
      return step("read", `Ran ${tool}`);
  }
}
