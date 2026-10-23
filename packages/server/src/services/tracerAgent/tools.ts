import { z } from "zod";
import {
  addressNodeId,
  addTransfersEdit,
  aggregateEdgeId,
  CHAINS,
  detectChain,
  edgesBetween,
  EVM_CHAINS,
  isAddressOnChain,
  isChain,
  isEvmAddress,
  makeAddressNode,
  NODE_LABEL_MAX,
  NODE_NOTE_MAX,
  normalizeAddress,
  pairsToCompare,
  sharedCounterparties,
  transferEdgeId,
  type AddressInfo,
  type Chain,
  type TraceDoc,
  type TraceEdge,
  type TraceNode,
  type Transfer,
  type XY,
} from "@osstrace/contract";
import { rowToTransfer as rowToTransferNoLabels } from "../../chain/store.ts";
import type { Ctx } from "../../context.ts";
import { ApiErr, ProviderError } from "../../lib/errors.ts";
import { nowIso } from "../../lib/time.ts";
import { LabelIndex } from "../labelIndex.ts";
import { computeAggregate } from "../traces.ts";
import { counterpartiesFor, queryTransfers, syncAll, windowOf, type AddrKey } from "../transfers.ts";
import type { AgentDoc } from "./doc.ts";
import type { ToolSpec } from "./openrouter.ts";

/** What a tool runs with. Deliberately small: the caller's own id (for the same read paths their
 *  own browser would use), the one doc handle, and a deadline. No request, no config, no secrets. */
export type ToolEnv = { ctx: Ctx; userId: string | null; doc: AgentDoc; deadline: number };
export type ToolResult = Record<string, unknown>;

type ToolDef<S extends z.ZodTypeAny> = {
  name: string;
  description: string;
  /** JSON Schema shown to the model. */
  parameters: Record<string, unknown>;
  /** What the server actually enforces -- the model's JSON is parsed against this, never trusted. */
  args: S;
  run: (env: ToolEnv, args: z.output<S>) => Promise<ToolResult>;
};

/** Ties each tool's `run` argument type to its own `args` schema. */
const defineTool = <S extends z.ZodTypeAny>(t: ToolDef<S>): ToolDef<S> => t;

class ToolError extends Error {}
const fail = (m: string): never => {
  throw new ToolError(m);
};

/** A model calling a tool often sends `""` or `null` for an argument it has no value for, instead
 * of leaving the key out entirely, even though the JSON Schema marks it optional and omitting it
 * works fine -- confirmed live: gpt-4.1-mini did exactly this for list_transfers' `counterparty`
 * on a genuine "who first funded this address" query (no counterparty to give), and `z.string()
 * .min(1).optional()` then rejected the empty string on every retry even though omitting the key
 * entirely would have passed. Wrap every optional tool argument in this so the model's "no value"
 * shape -- however it chooses to spell that -- is treated the same as actually omitted. */
const blank = (v: unknown) => (v === "" || v === null ? undefined : v);
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());
/** The same "no value" shapes for an optional argument that has a default (flow, sortBy, sortDir,
 *  limit, mode): `flow: ""` or `limit: null` means "use the default", exactly like leaving it out. */
const withDefault = <T extends z.ZodTypeAny>(schema: z.ZodDefault<T>) => z.preprocess(blank, schema);
/** A required text argument where clearing is the point (rename_node's label, annotate_node's note):
 *  the description says "empty string clears it", and a model asked to clear one often sends null. */
const clearable = (max: number) => z.preprocess((v) => (v === null ? "" : v), z.string().max(max));

// ---------- limits (ADR 0008's caps where a tool reuses its idea of "how far") ----------
/** expand_node's hop cap: ADR 0008 §4's `maxHops` max. */
export const MAX_HOPS = 3;
/** Counterparties expanded per node: ADR 0008 §4's `breadth` default / max. */
const DEFAULT_BREADTH = 5;
const MAX_BREADTH = 10;
/** Hard ceiling on chain syncs for one expand_node call: ADR 0008 §4's `maxAdapterCalls` default. */
const MAX_EXPAND_SYNCS = 40;
const MAX_NODES_PER_EXPAND = 50;
/** find_connections compares at most this many nodes (45 pairs). */
const MAX_CONNECT_NODES = 10;
const MAX_DOC_NODES = 500; // anonTraceDoc's own bound
/** anonTraceDoc's edge bound. A scratch canvas comes back with every message, so an agent edit that
 *  takes it past this makes the browser's next message (and Share) a 400 -- never grow past it. */
const MAX_DOC_EDGES = 1000;
const MAX_LIST = 50;

// ---------- small helpers ----------
const CARD_W = 254;
const CARD_H = 72;
const GAP_X = 290; // web placement.ts PLACEMENT_GAP
const FAN = 200; // web placement.ts FAN_STEP

/** Strings that came from the chain (token names, symbols) or a user: one line, bounded. Token
 *  names are attacker-chosen public data -- shortening them doesn't make them safe, the fixed tool
 *  whitelist does (see agent.ts), but it keeps a planted essay out of the model's context. */
export const safeText = (s: string | null | undefined, max = 40): string | null => {
  if (s === null || s === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

const key = (a: AddrKey) => `${a.chain}:${a.address}`;

function occupied(doc: TraceDoc) {
  return doc.nodes.map((n) => ({ x: n.currentPosition.x, y: n.currentPosition.y }));
}
const overlaps = (p: XY, taken: XY[]) => taken.some((q) => Math.abs(q.x - p.x) < CARD_W + 24 && Math.abs(q.y - p.y) < CARD_H + 24);

/** Free spot next to `anchor` (same fan search shape as the canvas's own placement), or to the
 *  right of everything when there's no anchor. Mutates `taken` so a batch doesn't stack. */
function placeNear(anchor: XY | null, taken: XY[]): XY {
  let base: XY;
  if (anchor) base = { x: anchor.x + GAP_X, y: anchor.y };
  else if (taken.length === 0) base = { x: 0, y: 0 };
  else base = { x: Math.max(...taken.map((p) => p.x)) + GAP_X, y: Math.min(...taken.map((p) => p.y)) };
  for (let col = 0; col < 6; col++) {
    for (let i = 0; i < 16; i++) {
      const dy = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * FAN;
      const p = { x: base.x + col * GAP_X, y: base.y + dy };
      if (!overlaps(p, taken)) {
        taken.push(p);
        return p;
      }
    }
  }
  const p = { x: base.x, y: base.y + taken.length * FAN };
  taken.push(p);
  return p;
}

/** `address` with a leading `chain:` dropped when it names `chain` itself. The system prompt (and
 *  find_connections' own schema) asks for chain:address form, so a model passes "ethereum:0x…" in a
 *  field whose chain is already its own argument; a prefix naming a different chain is refused rather
 *  than silently picking one of the two. */
function dropChainPrefix(chain: Chain, s: string): string {
  const i = s.indexOf(":");
  if (i <= 0 || !isChain(s.slice(0, i))) return s;
  if (s.slice(0, i) !== chain) fail(`"${safeText(s, 80)}" names chain ${s.slice(0, i)}, but chain is ${chain} -- use the same chain for both`);
  return s.slice(i + 1).trim();
}

/** A validated, normalized (chain, address) from model input, or a ToolError. */
function addrArg(chain: Chain, address: string): AddrKey {
  const a = dropChainPrefix(chain, address.trim());
  if (!isAddressOnChain(chain, a)) fail(`"${safeText(a, 60)}" is not a valid ${chain} address`);
  return { chain, address: normalizeAddress(chain, a) };
}

/**
 * A node reference from the model: a node id on this doc, `chain:address`, or a bare address. A bare
 * 0x address is the same account on every EVM chain, so it resolves only when exactly one EVM chain's
 * node for it is on the canvas -- otherwise the model is told to say which chain.
 */
function findNode(doc: AgentDoc, ref: string): TraceNode | null {
  const d = doc.read();
  const s = ref.trim();
  const byId = d.nodes.find((n) => n.id === s);
  if (byId) return byId;
  const target = parseAddrRef(s, false);
  if (!target) return null;
  if ("ambiguousEvm" in target) {
    const hits = EVM_CHAINS.map((c) => d.nodes.find((n) => n.id === addressNodeId(doc.traceId, c, target.address))).filter((n): n is TraceNode => !!n);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) fail(`${safeText(s, 60)} is on the canvas on more than one chain -- use chain:address`);
    return null;
  }
  return d.nodes.find((n) => n.id === addressNodeId(doc.traceId, target.chain, target.address)) ?? null;
}

/** `chain:address` or a bare address. With `defaultEvm`, a bare 0x address means Ethereum (the
 *  shape's own default, same as the canvas's search box); without it, it's reported as ambiguous. */
function parseAddrRef(ref: string, defaultEvm: true): AddrKey | null;
function parseAddrRef(ref: string, defaultEvm: false): AddrKey | { ambiguousEvm: true; address: string } | null;
function parseAddrRef(ref: string, defaultEvm: boolean): AddrKey | { ambiguousEvm: true; address: string } | null {
  const s = ref.trim();
  const i = s.indexOf(":");
  if (i > 0 && isChain(s.slice(0, i))) {
    const chain = s.slice(0, i) as Chain;
    const addr = s.slice(i + 1);
    return isAddressOnChain(chain, addr) ? { chain, address: normalizeAddress(chain, addr) } : null;
  }
  const c = detectChain(s);
  if (!c) return null;
  if (c === "ethereum" && !defaultEvm) return { ambiguousEvm: true, address: normalizeAddress("ethereum", s) };
  return { chain: c, address: normalizeAddress(c, s) };
}

function nodeOrFail(doc: AgentDoc, ref: string): TraceNode {
  return findNode(doc, ref) ?? fail(`No node "${safeText(ref, 80)}" on this trace -- call get_doc_state for the real node ids`);
}

/** Adds an address node if it isn't on the canvas yet; returns the node either way. */
function ensureNode(env: ToolEnv, a: AddrKey, anchor: XY | null, taken: XY[]): { node: TraceNode; created: boolean } {
  const d = env.doc.read();
  const id = addressNodeId(env.doc.traceId, a.chain, a.address);
  const existing = d.nodes.find((n) => n.id === id);
  if (existing) return { node: existing, created: false };
  if (d.nodes.length >= MAX_DOC_NODES) fail(`This trace already has ${MAX_DOC_NODES} nodes, the most a trace can hold`);
  const info = LabelIndex.load(env.ctx.db, env.userId, [a]).info(a.chain, a.address); // display only -- never shown to the model
  const node = makeAddressNode(env.doc.traceId, info, placeNear(anchor, taken));
  env.doc.commit([{ type: "create_node", node }]);
  return { node, created: true };
}

/** What the model may see of an address: the address, never the caller's private label for it. */
const addrOut = (i: AddressInfo) => `${i.chain}:${i.ownerAddress?.address ?? i.address}`;

function transferOut(t: Transfer, subject?: AddrKey) {
  const from = t.from.ownerAddress?.address ?? t.from.address;
  const to = t.to.ownerAddress?.address ?? t.to.address;
  const dir = subject ? (from === subject.address && to === subject.address ? "self" : from === subject.address ? "out" : to === subject.address ? "in" : "other") : undefined;
  return {
    time: t.blockTimestamp,
    ...(dir ? { direction: dir } : {}),
    from: addrOut(t.from),
    to: addrOut(t.to),
    token: { symbol: safeText(t.tokenSymbol, 16), id: t.tokenId },
    amount: t.amount,
    usd: t.usd,
    txHash: t.txHash,
  };
}

const userFacing = (e: unknown) => (e instanceof ApiErr || e instanceof ProviderError ? e.message : "unexpected error");

// ---------- the tools ----------
const chainSchema = z.enum(CHAINS as unknown as [Chain, ...Chain[]]);
const chainJson = { type: "string", enum: [...CHAINS] };
const nodeRef = z.string().min(1).max(160);
const iso = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "must be an ISO-8601 date or timestamp");

/** A time bound from the model as the instant it means. Date-only and zone-less forms are UTC
 *  (Date.parse alone reads a zone-less time in the server's own time zone), a space separator is
 *  read as "T", and a date-only *upper* bound covers that whole day: list_transfers says its bounds
 *  are inclusive, and "timeLte: 2024-01-31" meaning 00:00 that day would drop all of the 31st. */
function timeBound(s: string, end: boolean): string {
  const t = s.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return end ? `${t}T23:59:59.999Z` : `${t}T00:00:00.000Z`;
  return /(Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t}Z`;
}

const addNode = defineTool({
  name: "add_node",
  description: "Add one wallet/contract address to the trace canvas as a node. Does nothing (and says so) if it's already there.",
  parameters: { type: "object", properties: { chain: chainJson, address: { type: "string", description: "The address, exactly as given." } }, required: ["chain", "address"], additionalProperties: false },
  args: z.object({ chain: chainSchema, address: z.string().min(1).max(128) }).strict(),
  async run(env, { chain, address }) {
    const a = addrArg(chain, address);
    const { node, created } = ensureNode(env, a, null, occupied(env.doc.read()));
    return { ok: true, nodeId: node.id, chain: a.chain, address: a.address, alreadyOnCanvas: !created };
  },
});

const findConnections = defineTool({
  name: "find_connections",
  description:
    "The canvas's own 'Find connections': for every same-chain pair of the given addresses, look up real transfers directly between the two, and draw each one found as an edge. Adds nothing when no transfer exists. " +
    "Addresses not on the canvas yet are added first. Omit `addresses` to compare every address node on the canvas. " +
    "mode 'indirect' (signed-in only) also reports pairs that never transacted directly but share a counterparty -- a lead, never drawn, never proof.",
  parameters: {
    type: "object",
    properties: {
      addresses: { type: "array", maxItems: MAX_CONNECT_NODES, items: { type: "string", description: "chain:address (preferred), a bare address, or a node id" } },
      mode: { type: "string", enum: ["direct", "indirect"] },
    },
    additionalProperties: false,
  },
  args: z.object({ addresses: opt(z.array(nodeRef).max(MAX_CONNECT_NODES)), mode: withDefault(z.enum(["direct", "indirect"]).default("direct")) }).strict(),
  async run(env, { addresses, mode }) {
    if (mode === "indirect" && !env.userId) fail("Indirect mode needs a connected wallet (it's signed-in only). Direct mode works without one.");
    const taken = occupied(env.doc.read());
    let nodes: TraceNode[];
    const added: string[] = [];
    if (addresses && addresses.length) {
      // Resolve everything first, so a request that's going to be refused adds nothing.
      const existing = new Map<string, TraceNode>();
      const toAdd = new Map<string, AddrKey>();
      for (const ref of addresses) {
        const onCanvas = findNode(env.doc, ref);
        if (onCanvas) {
          existing.set(onCanvas.id, onCanvas);
          continue;
        }
        const a = parseAddrRef(ref, true) ?? fail(`"${safeText(ref, 80)}" is neither a node on this trace nor a valid address`);
        toAdd.set(key(a), a);
      }
      if (existing.size + toAdd.size < 2) fail("Need at least 2 different addresses to look for connections between");
      // Checked before anything is added: running out of room halfway would leave some of the named
      // addresses on the canvas behind an error that says nothing was done.
      const room = MAX_DOC_NODES - env.doc.read().nodes.length;
      if (toAdd.size > room) fail(`This trace has room for ${Math.max(0, room)} more node${room === 1 ? "" : "s"} (${MAX_DOC_NODES} max) but ${toAdd.size} of these addresses aren't on it yet -- remove some nodes first`);
      nodes = [...existing.values()];
      for (const a of toAdd.values()) {
        const r = ensureNode(env, a, null, taken);
        if (r.created) added.push(r.node.id);
        nodes.push(r.node);
      }
    } else {
      nodes = env.doc.read().nodes.filter((n) => n.kind === "address");
      if (nodes.length > MAX_CONNECT_NODES) fail(`This trace has ${nodes.length} address nodes; name at most ${MAX_CONNECT_NODES} to compare`);
    }
    if (nodes.filter((n) => n.kind === "address").length < 2) fail("Need at least 2 address nodes to look for connections between");
    const pairs = pairsToCompare(nodes);
    if (pairs.length === 0) return { ok: true, mode, nodesAdded: added, pairsCompared: 0, connections: [], note: "These nodes are on different chains -- only same-chain pairs are compared." };

    // Direct: the same counterparty-filtered transfer query the canvas runs, one pair at a time.
    const perPair: Transfer[][] = [];
    const connections: { a: string; b: string; transfers: number; usd: number }[] = [];
    let failedPairs = 0;
    let skippedForTime = 0;
    for (const [a, b] of pairs) {
      if (Date.now() > env.deadline - 4000) {
        skippedForTime++;
        continue;
      }
      try {
        const res = await queryTransfers(env.ctx, env.userId, {
          base: [`${a.chain}:${a.address}`],
          counterparties: [`${b.chain}:${b.address}`],
          flow: "all",
          tokens: [],
          sortKey: "time",
          sortDir: "desc",
          limit: 200,
        });
        perPair.push(res.transfers);
        if (res.transfers.length) connections.push({ a: a.id, b: b.id, transfers: res.transfers.length, usd: res.transfers.reduce((s, t) => s + (t.usd ?? 0), 0) });
      } catch {
        failedPairs++; // one pair's provider hiccup shouldn't abort the rest, same as the canvas
      }
    }
    let edgesAdded = 0;
    let notDrawnTraceFull = 0;
    if (perPair.some((ts) => ts.length)) {
      const d = env.doc.read();
      // Only transfers not drawn yet compete for the trace's remaining edge room, taken round-robin
      // across pairs: if the limit cuts the batch short, every connection found still gets an edge.
      const have = new Set(d.edges.map((e) => e.id));
      const fresh = perPair.map((ts) =>
        ts.filter((t) => {
          const id = transferEdgeId(env.doc.traceId, t.chain, t.id);
          if (have.has(id)) return false;
          have.add(id);
          return true;
        }),
      );
      const queue: Transfer[] = [];
      for (let i = 0; fresh.some((ts) => i < ts.length); i++) for (const ts of fresh) if (i < ts.length) queue.push(ts[i]!);
      const take = queue.slice(0, Math.max(0, MAX_DOC_EDGES - d.edges.length));
      notDrawnTraceFull = queue.length - take.length;
      if (take.length) {
        const addr = d.nodes.filter((n) => n.kind === "address");
        const centroid = { x: addr.reduce((s, n) => s + n.currentPosition.x, 0) / addr.length, y: addr.reduce((s, n) => s + n.currentPosition.y, 0) / addr.length };
        const edit = addTransfersEdit({ traceId: env.doc.traceId, doc: d, transfers: take, positionFor: () => centroid });
        edgesAdded = edit.doOps.filter((o) => o.type === "create_edge").length;
        env.doc.commit(edit.doOps);
      }
    }

    // Indirect: shared counterparties (signed-in only) -- reported, never drawn.
    const leads: { a: string; b: string; sharedCounterparties: string[] }[] = [];
    if (mode === "indirect") {
      const sets = new Map<string, Map<string, string>>();
      for (const n of nodes.filter((x) => x.kind === "address")) {
        const set = new Map<string, string>();
        const a = { chain: n.chain!, address: n.address! };
        try {
          await syncAll(env.ctx, [a], null, { maxRounds: 1 });
          for (const c of counterpartiesFor(env.ctx, env.userId, a, { flow: "all", limit: 100, from: null, to: null })) set.set(`${c.address.chain}:${c.address.address}`, c.address.address);
        } catch {
          /* partial indirect results are still useful, same as the canvas */
        }
        sets.set(n.id, set);
      }
      for (const [a, b] of pairs) {
        const shared = sharedCounterparties(sets.get(a.id)!, sets.get(b.id)!, new Set([`${a.chain}:${a.address}`, `${b.chain}:${b.address}`]));
        if (shared.length) leads.push({ a: a.id, b: b.id, sharedCounterparties: shared.slice(0, 20).map((s) => s.key) });
      }
    }
    return {
      ok: true,
      mode,
      nodesAdded: added,
      pairsCompared: pairs.length - skippedForTime,
      ...(failedPairs ? { pairsFailed: failedPairs } : {}),
      ...(skippedForTime ? { pairsSkippedForTime: skippedForTime } : {}),
      connections,
      edgesAdded,
      ...(notDrawnTraceFull ? { transfersNotDrawnTraceFull: notDrawnTraceFull } : {}),
      ...(mode === "indirect" ? { indirectLeads: leads } : {}),
      note: notDrawnTraceFull
        ? `${notDrawnTraceFull} of the transfers found were not drawn: the trace reached its ${MAX_DOC_EDGES}-edge limit. The connections list above is complete; the canvas shows only part of it.`
        : connections.length === 0
          ? failedPairs || skippedForTime
            ? "No direct transfers found among the pairs that could be checked -- some pairs could not be checked, so this is not a proven negative."
            : "No direct transfers between any of these pairs in the history loaded so far."
          : "Each connection is a real transfer found on-chain and drawn as an edge.",
    };
  },
});

/**
 * Multi-hop expansion, ADR 0008's BFS shape and caps, built on this server's own counterparty path
 * (syncAll + counterpartiesFor -- what /api/address/.../counterparties and the canvas's counterparty
 * panel run) rather than by calling packages/features/tracer's traceGraph. That function belongs to
 * the pre-ADR-0022 stack: it reads chains through @osstrace/core's ChainAdapter (its own RPC config,
 * no shared cache) and returns GraphEdges with no server transfer ids, so nothing it produces could
 * become a canvas node/edge this server can display, re-aggregate or persist. Same idea, same caps,
 * the canvas's real data path.
 */
const expandNode = defineTool({
  name: "expand_node",
  description:
    `Follow money outward from an address: add its top counterparties (by USD moved) as nodes with aggregate edges, then theirs, up to \`hops\` hops (1-${MAX_HOPS}). ` +
    `\`breadth\` (1-${MAX_BREADTH}, default ${DEFAULT_BREADTH}) is how many counterparties per node. Hard-capped on chain lookups; the result says honestly what was not expanded and why.`,
  parameters: {
    type: "object",
    properties: { chain: chainJson, address: { type: "string" }, hops: { type: "integer", minimum: 1, maximum: MAX_HOPS }, breadth: { type: "integer", minimum: 1, maximum: MAX_BREADTH } },
    required: ["chain", "address", "hops"],
    additionalProperties: false,
  },
  args: z.object({ chain: chainSchema, address: z.string().min(1).max(128), hops: z.number().int().min(1).max(MAX_HOPS), breadth: opt(z.number().int().min(1).max(MAX_BREADTH)) }).strict(),
  async run(env, { chain, address, hops, breadth = DEFAULT_BREADTH }) {
    const start = addrArg(chain, address);
    const taken = occupied(env.doc.read());
    const root = ensureNode(env, start, null, taken).node;
    const expanded = new Set<string>();
    let frontier: TraceNode[] = [root];
    let syncs = 0;
    let nodesAdded = 0;
    let edgesAdded = 0;
    let counterpartiesNotAdded = 0;
    let skippedTraceFull = 0;
    const unavailable: string[] = [];
    let budgetExhausted = 0;
    for (let hop = 1; hop <= hops && frontier.length; hop++) {
      const next: TraceNode[] = [];
      for (const n of frontier) {
        if (expanded.has(n.id) || n.kind !== "address" || !n.chain || !n.address) continue;
        if (syncs >= MAX_EXPAND_SYNCS || nodesAdded >= MAX_NODES_PER_EXPAND || Date.now() > env.deadline - 5000) {
          budgetExhausted++;
          continue;
        }
        expanded.add(n.id);
        const a = { chain: n.chain, address: n.address };
        syncs++;
        try {
          await syncAll(env.ctx, [a], null, { maxRounds: 1, anon: !env.userId });
        } catch {
          unavailable.push(key(a)); // couldn't check -- never reported as "no counterparties"
          continue;
        }
        // Same ranking the canvas's counterparty panel shows: USD moved, then transfer count.
        const merged = new Map<string, { info: AddressInfo; usd: number; n: number }>();
        for (const c of counterpartiesFor(env.ctx, env.userId, a, { flow: "all", limit: breadth * 2, from: null, to: null })) {
          const k = `${c.address.chain}:${c.address.address}`;
          const m = merged.get(k) ?? { info: c.address, usd: 0, n: 0 };
          m.usd += c.usd;
          m.n += c.transactionCount;
          merged.set(k, m);
        }
        // Already-expanded nodes (this node's own parent, typically) aren't "outward" -- skip them.
        const ranked = [...merged.values()].filter((m) => !expanded.has(addressNodeId(env.doc.traceId, m.info.chain, m.info.address))).sort((x, y) => y.usd - x.usd || y.n - x.n);
        counterpartiesNotAdded += Math.max(0, ranked.length - breadth);
        for (const cp of ranked.slice(0, breadth)) {
          if (nodesAdded >= MAX_NODES_PER_EXPAND) {
            counterpartiesNotAdded++;
            continue;
          }
          const ck = { chain: cp.info.chain, address: cp.info.address };
          // A full trace stops new nodes and edges, not the call: what was already added stays, and is reported
          // as a partial expansion instead of an error claiming nothing happened.
          const d0 = env.doc.read();
          const cpId = addressNodeId(env.doc.traceId, ck.chain, ck.address);
          const newNode = !d0.nodes.some((x) => x.id === cpId);
          const newEdge = edgesBetween(d0, n.id, cpId).length === 0;
          if ((newNode && d0.nodes.length >= MAX_DOC_NODES) || (newEdge && d0.edges.length >= MAX_DOC_EDGES)) {
            skippedTraceFull++;
            counterpartiesNotAdded++;
            continue;
          }
          const r = ensureNode(env, ck, n.currentPosition, taken);
          if (r.created) nodesAdded++;
          const d = env.doc.read();
          if (edgesBetween(d, n.id, r.node.id).length === 0) {
            // An aggregate edge with its real totals from the local transfer cache -- the same
            // computation a saved trace's aggregate edges get server-side.
            const edge: TraceEdge = { id: aggregateEdgeId(env.doc.traceId, n.id, r.node.id), kind: "aggregate", fromNodeID: n.id, toNodeID: r.node.id, createdAt: nowIso(), aggregate: computeAggregate(env.ctx, [a], [ck], nowIso()) };
            env.doc.commit([{ type: "create_edge", edge }]);
            edgesAdded++;
          }
          next.push(r.node);
        }
      }
      frontier = next;
    }
    const depthCapped = frontier.filter((n) => !expanded.has(n.id)).length;
    return {
      ok: true,
      rootNodeId: root.id,
      hops,
      breadth,
      nodesAdded,
      edgesAdded,
      nodesExpanded: expanded.size - unavailable.length,
      notExpanded: { depthCap: depthCapped, budgetExhausted, unavailable },
      counterpartiesNotAdded,
      ...(skippedTraceFull ? { notAddedTraceFull: skippedTraceFull } : {}),
      note: skippedTraceFull
        ? `Stopped short: the trace reached its size limit (${MAX_DOC_NODES} nodes, ${MAX_DOC_EDGES} edges), so ${skippedTraceFull} counterpart${skippedTraceFull === 1 ? "y was" : "ies were"} not added -- the picture is partial. Remove nodes to make room.`
        : budgetExhausted || unavailable.length
          ? "Stopped short: some nodes were not expanded (lookup budget or provider errors) -- the picture is partial, not complete."
          : "Aggregate edges carry real totals from the transfer history loaded so far.",
    };
  },
});

const listTransfers = defineTool({
  name: "list_transfers",
  description:
    "List an address's real transfers with the same filters/sorting as the Transfers panel: flow (in/out/self/all), sortBy (time/value/usd), sortDir, asset ('native', a token contract/mint, or a symbol like USDC), counterparty, a date range or timeLast, USD bounds. Read-only: changes nothing on the canvas.",
  parameters: {
    type: "object",
    properties: {
      chain: chainJson,
      address: { type: "string" },
      flow: { type: "string", enum: ["all", "in", "out", "self"] },
      sortBy: { type: "string", enum: ["time", "value", "usd"] },
      sortDir: { type: "string", enum: ["asc", "desc"] },
      asset: { type: "string", description: "'native', a token contract/mint address, or a token symbol" },
      counterparty: { type: "string", description: "Only transfers with this address (same chain)" },
      timeGte: { type: "string", description: "ISO-8601 date or date-time (UTC unless it has an offset), inclusive" },
      timeLte: { type: "string", description: "ISO-8601 date or date-time (UTC unless it has an offset), inclusive: a bare date includes that whole day" },
      timeLast: { type: "string", enum: ["1h", "12h", "1d", "7d", "30d", "90d", "1y", "all"] },
      usdGte: { type: "number", minimum: 0 },
      usdLte: { type: "number", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIST },
    },
    required: ["chain", "address"],
    additionalProperties: false,
  },
  args: z
    .object({
      chain: chainSchema,
      address: z.string().min(1).max(128),
      flow: withDefault(z.enum(["all", "in", "out", "self"]).default("all")),
      sortBy: withDefault(z.enum(["time", "value", "usd"]).default("time")),
      sortDir: withDefault(z.enum(["asc", "desc"]).default("desc")),
      asset: opt(z.string().min(1).max(128)),
      counterparty: opt(z.string().min(1).max(128)),
      timeGte: opt(iso),
      timeLte: opt(iso),
      timeLast: opt(z.enum(["1h", "12h", "1d", "7d", "30d", "90d", "1y", "all"])),
      usdGte: opt(z.number().finite().min(0).max(1e15)),
      usdLte: opt(z.number().finite().min(0).max(1e15)),
      limit: withDefault(z.number().int().min(1).max(MAX_LIST).default(20)),
    })
    .strict(),
  async run(env, q) {
    const a = addrArg(q.chain, q.address);
    const timeGte = q.timeGte ? timeBound(q.timeGte, false) : undefined;
    const timeLte = q.timeLte ? timeBound(q.timeLte, true) : undefined;
    const cp = q.counterparty ? addrArg(q.chain, q.counterparty) : null;
    let tokens: string[] = [];
    let symbolNote: string | null = null;
    if (q.asset) {
      const asset = dropChainPrefix(q.chain, q.asset.trim());
      if (asset.toLowerCase() === "native") tokens = ["native"];
      else if (isAddressOnChain(q.chain, asset) || isEvmAddress(asset)) tokens = [asset];
      else {
        // A symbol: resolve it to the real token ids this address has moved. Symbols aren't unique
        // and anyone can deploy a token called "USDC", so every match is used and the model is told.
        const w = windowOf({ timeLast: q.timeLast, timeGte, timeLte });
        try {
          await syncAll(env.ctx, [a], w.from, { anon: !env.userId, maxRounds: w.from === null ? 0 : undefined });
        } catch {
          /* queryTransfers below reports the provider state */
        }
        const rows = env.ctx.db.all<{ token_id: string }>(
          `SELECT DISTINCT token_id FROM transfers WHERE chain = ? AND UPPER(token_symbol) = UPPER(?)
             AND (from_addr = ? OR to_addr = ? OR from_owner = ? OR to_owner = ?) LIMIT 20`,
          a.chain,
          asset,
          a.address,
          a.address,
          a.address,
          a.address,
        );
        if (rows.length === 0) return { ok: true, transfers: [], count: 0, note: `No transfers of a token with symbol "${safeText(asset, 16)}" in what's loaded for this address.` };
        tokens = rows.map((r) => r.token_id);
        if (tokens.length > 1) symbolNote = `"${safeText(asset, 16)}" matched ${tokens.length} different token contracts -- symbols are not unique and can be imitated; check the token id.`;
      }
    }
    const res = await queryTransfers(env.ctx, env.userId, {
      base: [key(a)],
      counterparties: cp ? [key(cp)] : [],
      flow: q.flow,
      tokens,
      chain: a.chain,
      sortKey: q.sortBy,
      sortDir: q.sortDir,
      limit: q.limit,
      ...(timeGte ? { timeGte } : {}),
      ...(timeLte ? { timeLte } : {}),
      ...(q.timeLast ? { timeLast: q.timeLast } : {}),
      ...(q.usdGte !== undefined ? { usdGte: q.usdGte } : {}),
      ...(q.usdLte !== undefined ? { usdLte: q.usdLte } : {}),
    });
    return {
      ok: true,
      address: key(a),
      sortedBy: `${q.sortBy} ${q.sortDir}`,
      transfers: res.transfers.map((t) => transferOut(t, a)),
      matchingInCache: res.count.value,
      ...(res.count.capped ? { matchingCapped: true } : {}),
      more: res.nextCursor !== null,
      sync: { state: res.sync.state, coveredFrom: res.sync.coveredFrom, ...(res.sync.anonCapped ? { anonCapped: true } : {}) },
      ...(symbolNote ? { warning: symbolNote } : {}),
      ...(res.sync.state !== "ready" ? { note: "History for this address is not fully loaded -- results cover only what's loaded so far." } : {}),
    };
  },
});

const removeNode = defineTool({
  name: "remove_node",
  description: "Remove one node (and the edges touching it) from this trace.",
  parameters: { type: "object", properties: { nodeId: { type: "string", description: "A node id from get_doc_state, or chain:address" } }, required: ["nodeId"], additionalProperties: false },
  args: z.object({ nodeId: nodeRef }).strict(),
  async run(env, { nodeId }) {
    const n = nodeOrFail(env.doc, nodeId);
    const edges = env.doc.read().edges.filter((e) => e.fromNodeID === n.id || e.toNodeID === n.id).length;
    env.doc.commit([{ type: "delete_node", id: n.id }]);
    return { ok: true, removedNodeId: n.id, edgesRemoved: edges };
  },
});

const renameNode = defineTool({
  name: "rename_node",
  description: `Give a node a display name on this trace (max ${NODE_LABEL_MAX} chars; empty string clears it). Only affects this trace.`,
  parameters: { type: "object", properties: { nodeId: { type: "string" }, label: { type: "string", maxLength: NODE_LABEL_MAX } }, required: ["nodeId", "label"], additionalProperties: false },
  args: z.object({ nodeId: nodeRef, label: clearable(NODE_LABEL_MAX) }).strict(),
  async run(env, { nodeId, label }) {
    const n = nodeOrFail(env.doc, nodeId);
    const clean = safeText(label, NODE_LABEL_MAX) || null;
    env.doc.commit([{ type: "set_node_label", id: n.id, label: clean }]);
    return { ok: true, nodeId: n.id, label: clean };
  },
});

const annotateNode = defineTool({
  name: "annotate_node",
  description: `Set a node's investigator note on this trace (max ${NODE_NOTE_MAX} chars; empty string clears it).`,
  parameters: { type: "object", properties: { nodeId: { type: "string" }, note: { type: "string", maxLength: NODE_NOTE_MAX } }, required: ["nodeId", "note"], additionalProperties: false },
  args: z.object({ nodeId: nodeRef, note: clearable(NODE_NOTE_MAX) }).strict(),
  async run(env, { nodeId, note }) {
    const n = nodeOrFail(env.doc, nodeId);
    // eslint-disable-next-line no-control-regex
    const clean = note.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, NODE_NOTE_MAX) || null;
    env.doc.commit([{ type: "set_node_note", id: n.id, note: clean }]);
    return { ok: true, nodeId: n.id, note: clean };
  },
});

/** get_doc_state's own size budget: under agent.ts's per-result cap (MAX_RESULT_CHARS, 12k) with
 *  room for the fields around the lists, so it chooses what to leave out rather than being cut. */
const DOC_STATE_CHARS = 10_500;

/** The newest entries of `xs` (canvas order kept) whose JSON fits in `budget` characters. */
function newestThatFit<T>(xs: T[], budget: number): T[] {
  let used = 0;
  let i = xs.length;
  while (i > 0) {
    const c = JSON.stringify(xs[i - 1]).length + 1;
    if (used + c > budget) break;
    used += c;
    i--;
  }
  return xs.slice(i);
}

const getDocState = defineTool({
  name: "get_doc_state",
  description: "The current trace: its nodes (id, chain, address, label, note) and edges (with transfer/aggregate details). Call it before acting on 'that node', 'the second one', etc.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  args: z.object({}).strict(),
  async run(env) {
    const d = env.doc.read();
    // Transfer details come from the server's own transfer cache by id, not from anything the
    // client attached to the doc -- and with no label join, so private labels never reach the model.
    const rows = env.ctx.store.getMany(d.edges.flatMap((e) => (e.kind === "transfer" ? [{ chain: e.chain, id: e.transferID }] : [])));
    const empty = LabelIndex.empty();
    const allNodes = d.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      ...(n.chain ? { chain: n.chain } : {}),
      ...(n.address ? { address: n.address } : {}),
      ...(n.kind === "transaction" ? { tx: `${n.transactionChain}:${n.transactionHash}` } : {}),
      ...(n.kind === "entity" ? { entity: true } : {}),
      ...(n.label ? { label: safeText(n.label, NODE_LABEL_MAX) } : {}),
      ...(n.note ? { note: safeText(n.note, 300) } : {}),
    }));
    const allEdges = d.edges.map((e) => {
      if (e.kind === "aggregate")
        return { id: e.id, kind: e.kind, from: e.fromNodeID, to: e.toNodeID, usdOut: e.aggregate.cachedUSDOut, txOut: e.aggregate.cachedTransactionCountOut, usdIn: e.aggregate.cachedUSDIn, txIn: e.aggregate.cachedTransactionCountIn };
      const r = rows.get(`${e.chain}:${e.transferID}`);
      const t = r ? transferOut(rowToTransferNoLabels(r, empty)) : null;
      return { id: e.id, kind: e.kind, from: e.fromNodeID, to: e.toNodeID, ...(t ? { time: t.time, token: t.token, amount: t.amount, usd: t.usd, txHash: t.txHash } : { transferId: e.transferID }) };
    });
    // On a big canvas, the *newest* nodes are the ones "that node" / "the one you just added" mean,
    // so the oldest are left out first -- nodes before edges, since every node tool needs a node id.
    const nodes = newestThatFit(allNodes.slice(-200), DOC_STATE_CHARS);
    const edges = newestThatFit(allEdges.slice(-300), DOC_STATE_CHARS - JSON.stringify(nodes).length);
    const omitted = nodes.length < allNodes.length || edges.length < allEdges.length;
    return {
      ok: true,
      docKind: env.doc.kind,
      title: safeText(d.title, 120),
      nodeCount: d.nodes.length,
      edgeCount: d.edges.length,
      nodes,
      edges,
      ...(omitted
        ? {
            truncated: true,
            note: `Showing the newest ${nodes.length} of ${allNodes.length} nodes and ${edges.length} of ${allEdges.length} edges; the oldest are left out. Any node can still be named as chain:address.`,
          }
        : {}),
    };
  },
});

const openTraceDoc = defineTool({
  name: "open_trace_doc",
  description: "This trace's own in-app link (the URL fragment the Tracer opens it at), and whether it's saved or local-only.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  args: z.object({}).strict(),
  async run(env) {
    if (env.doc.kind === "scratch")
      return {
        ok: true,
        url: "#trace/scratch",
        persistent: false,
        note: "A local-only canvas: it lives in this browser tab and is lost on refresh. Connect a wallet to save it, or use Share to make a 3-hour read-only link.",
      };
    const d = env.doc.read();
    return { ok: true, url: `#trace/doc/${env.doc.traceId}`, persistent: true, ...(d.shareable ? { publicViewUrl: `#trace/view/${env.doc.traceId}` } : {}) };
  },
});

/** The whole tool surface the model gets. Nothing outside this list can be called -- see agent.ts. */
export const TOOLS = [addNode, findConnections, expandNode, listTransfers, removeNode, renameNode, annotateNode, getDocState, openTraceDoc] as const;
const BY_NAME = new Map<string, (typeof TOOLS)[number]>(TOOLS.map((t) => [t.name, t]));

export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

const MAX_ARG_CHARS = 8000;

/**
 * Runs one model-requested tool call. The name must be on the whitelist, the arguments must parse
 * as JSON and pass that tool's strict schema (unknown keys rejected, enums and ranges enforced), and
 * only then does any code run. Every failure comes back as `{ ok: false, error }` for the model to
 * read -- never a thrown error that could leak internals, never a partial guess.
 */
export async function runTool(env: ToolEnv, name: string, rawArgs: string): Promise<{ args: Record<string, unknown>; result: ToolResult }> {
  const tool = BY_NAME.get(name);
  if (!tool) return { args: {}, result: { ok: false, error: `Unknown tool "${safeText(name, 60)}". Only these exist: ${TOOLS.map((t) => t.name).join(", ")}.` } };
  let parsed: unknown;
  try {
    if (rawArgs.length > MAX_ARG_CHARS) throw new Error();
    parsed = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
  } catch {
    return { args: {}, result: { ok: false, error: "Arguments were not valid JSON." } };
  }
  const v = (tool.args as z.ZodTypeAny).safeParse(parsed);
  if (!v.success) {
    const issue = v.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { args: typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {}, result: { ok: false, error: `Invalid arguments -- ${where}${issue?.message ?? "rejected"}` } };
  }
  const args = v.data as Record<string, unknown>;
  try {
    return { args, result: await (tool.run as (e: ToolEnv, a: unknown) => Promise<ToolResult>)(env, args) };
  } catch (e) {
    if (e instanceof ToolError) return { args, result: { ok: false, error: e.message } };
    return { args, result: { ok: false, error: userFacing(e) } };
  }
}
