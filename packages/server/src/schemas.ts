import { z } from "zod";
import type { Chain } from "@osstrace/contract";
import { badRequest } from "./lib/errors.ts";

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data as z.output<S>;
  const first = r.error.issues[0];
  const path = first?.path.length ? first.path.join(".") + ": " : "";
  throw badRequest(`${path}${first?.message ?? "invalid request"}`);
}

export const chain = z.enum(["solana", "ethereum", "bnb"]) satisfies z.ZodType<Chain>;
/** Bounty deposits only (contract's `DepositChain`): Bitcoin is accepted as a deposit payment but is
 *  never an address/trace/label chain, so it must not widen the shared `chain` enum above. */
export const depositChain = z.enum(["solana", "ethereum", "bitcoin"]);
const num = z.number().finite();
const coord = num.min(-1e7).max(1e7);
const iso = z.string().min(10).max(40).regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, "must be an ISO-8601 UTC timestamp");
const id = z.string().min(1).max(128);
const xy = z.object({ x: coord, y: coord });
const nodeColor = z.enum(["blue", "green", "amber", "red", "purple", "gray"]);

export const traceNode = z
  .object({
    id,
    kind: z.enum(["address", "entity", "transaction"]),
    currentPosition: xy,
    createdAt: z.string().max(64).optional(),
    width: num.min(0).max(10000).nullable().optional(),
    height: num.min(0).max(10000).nullable().optional(),
    color: nodeColor.nullable().optional(),
    address: z.string().min(1).max(128).optional(),
    chain: chain.optional(),
    entityID: id.optional(),
    transactionChain: chain.optional(),
    transactionHash: z.string().min(1).max(200).optional(),
    displayAddress: z.unknown().optional(),
    displayEntity: z.unknown().optional(),
  })
  .strip();

const aggregate = z.object({
  cachedUSDIn: num,
  cachedTransactionCountIn: num,
  cachedUSDOut: num,
  cachedTransactionCountOut: num,
  cachedAt: z.string().max(64),
});

export const traceEdge = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("aggregate"), fromNodeID: id, toNodeID: id, createdAt: z.string().max(64).optional(), aggregate: aggregate.partial().optional() }).strip(),
  z
    .object({
      id,
      kind: z.literal("transfer"),
      fromNodeID: id,
      toNodeID: id,
      createdAt: z.string().max(64).optional(),
      chain,
      transferID: z.string().min(1).max(200),
      displayTransfer: z.unknown().optional(),
    })
    .strip(),
]);

export const traceOp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_node"), node: traceNode }),
  z.object({ type: z.literal("delete_node"), id }),
  z.object({ type: z.literal("create_edge"), edge: traceEdge }),
  z.object({ type: z.literal("delete_edge"), id }),
  z.object({ type: z.literal("update_edge_endpoints"), id, fromNodeID: id.optional(), toNodeID: id.optional() }),
  z.object({ type: z.literal("update_node_position"), id, position: xy, clientTimestamp: iso }),
  z.object({ type: z.literal("update_node_size"), id, width: num.min(0).max(10000).nullable(), height: num.min(0).max(10000).nullable() }),
  z.object({ type: z.literal("set_node_color"), id, color: nodeColor.nullable() }),
  z.object({ type: z.literal("set_title"), title: z.string().max(1000) }),
  z.object({ type: z.literal("set_notes"), notes: z.string().max(100_000) }),
  z.object({ type: z.literal("set_shareable"), shareable: z.boolean() }),
]);
export const traceBatch = z.object({ ops: z.array(traceOp).max(500, "at most 500 ops per batch") });

/** An anon share's doc snapshot -- same node/edge shapes as a real trace, just submitted whole
 *  (a local-only canvas has no op history to replay) rather than as ops against a server doc. */
export const anonTraceDoc = z.object({
  title: z.string().max(1000),
  notes: z.string().max(100_000),
  nodes: z.array(traceNode).max(500),
  edges: z.array(traceEdge).max(1000),
});

export const visualizerFilter = z.object({
  flow: z.enum(["all", "in", "out", "self"]),
  from: z.array(z.string().max(200)).max(200).nullable(),
  to: z.array(z.string().max(200)).max(200).nullable(),
  tokens: z.array(z.string().max(200)).max(200).nullable(),
  chains: z.array(chain).nullable(),
  valueGte: num.nullable(),
  valueLte: num.nullable(),
  usdGte: num.nullable(),
  usdLte: num.nullable(),
  sortBy: z.enum(["time", "value", "usd"]),
  sortDir: z.enum(["asc", "desc"]),
});
const timeRange = z.object({ gte: num.nullable(), lte: num.nullable() });
const vizBase = z.array(z.object({ type: z.enum(["address", "entity"]), value: z.string().min(1).max(200), exclude: z.boolean() })).max(50);

export const visualizerState = z.object({
  mode: z.enum(["counterparty", "token"]),
  base: vizBase,
  filter: visualizerFilter,
  timeRange,
  isHidden: z.record(z.string().max(100), z.boolean()),
  positions: z.record(z.string().max(200), xy),
  expanded: z.array(z.string().max(200)).max(500),
});

const ts = { clientTimestamp: iso };
export const visualizerOp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_filter"), filter: visualizerFilter, ...ts }),
  z.object({ type: z.literal("set_time_range"), timeRange, ...ts }),
  z.object({ type: z.literal("set_base"), base: vizBase, ...ts }),
  z.object({ type: z.literal("set_is_hidden_for_type"), typeKey: z.string().min(1).max(100), isHiddenValue: z.boolean(), ...ts }),
  z.object({ type: z.literal("add_expanded"), nodeID: z.string().min(1).max(200), ...ts }),
  z.object({ type: z.literal("remove_expanded"), nodeID: z.string().min(1).max(200), ...ts }),
  z.object({ type: z.literal("set_position"), nodeID: z.string().min(1).max(200), position: xy, ...ts }),
  z.object({ type: z.literal("delete_position"), nodeID: z.string().min(1).max(200), ...ts }),
  z.object({ type: z.literal("set_name"), name: z.string().max(1000), ...ts }),
  z.object({ type: z.literal("set_shareable"), shareable: z.boolean(), ...ts }),
]);
export const viewBatch = z.object({ ops: z.array(visualizerOp).max(500, "at most 500 ops per batch") });

export const username = z
  .string()
  .trim()
  .min(3, "username must be 3-32 characters")
  .max(32, "username must be 3-32 characters")
  .regex(/^[A-Za-z0-9_.-]+$/, "username may only contain letters, digits, _ . -")
  .transform((s) => s.toLowerCase());
export const displayName = z.string().trim().min(1).max(64);

export const walletAddress = z.string().min(1).max(200);
export const walletSignature = z.string().min(1).max(4000);

export const preferences = z.object({
  theme: z.enum(["dark", "light"]),
  defaultChain: chain,
  defaultUsdGte: num.min(0).max(1e12),
  defaultTimeLast: z.enum(["1d", "7d", "30d", "90d", "1y", "all"]),
  flowDots: z.boolean(),
  timezone: z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "unknown IANA timezone"),
});

export const tagColor = z.string().regex(/^(#[0-9a-fA-F]{6}|[a-z]{3,16})$/, "color must be #rrggbb or a color name");
