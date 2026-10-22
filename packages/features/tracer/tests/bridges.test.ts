import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonFileLabelStore,
  type Address,
  type Balance,
  type ChainAdapter,
  type ChainId,
  type TokenTransfer,
  type TransactionSummary,
  type TransactionsResult,
} from "@osstrace/core";
import { classifyWormholescanOperations, type BridgeLookupResult, type BridgeResolver } from "../src/bridges/wormhole.ts";
import { edgeMatchesFilters } from "../src/filters.ts";
import { buildTraceGraph, traceGraph, tracePath, type BridgeTracing, type TraceOptions } from "../src/trace.ts";

/*
 * Both fixtures are real, unedited Wormholescan responses, recorded 2026-10-22:
 *   GET https://api.wormholescan.io/api/v1/operations?address=0x49719d256a5ea16bfa579ea16e95bea9fa41a452&pageSize=5
 *   GET https://api.wormholescan.io/api/v1/operations?address=AQFnRFkK8Jrxi91h2HCxQrdtdayWPSHKvAURR85ZeLWG&sourceChain=1,2&targetChain=1,2&pageSize=10
 * Every operation id, tx hash and address asserted below comes from them.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}
const ETH_OPS = fixture("wormholescan-operations-eth-0x49719d.json");
const SOL_OPS = fixture("wormholescan-operations-sol-AQFnRF.json");

const ETH_NODE = "0x49719d256a5ea16bfa579ea16e95bea9fa41a452";
const SOL_WALLET = "AQFnRFkK8Jrxi91h2HCxQrdtdayWPSHKvAURR85ZeLWG";
/** The SPL token account the VAA in operation .../698122 names as recipient (owner: SOL_WALLET, checked on-chain). */
const SOL_TOKEN_ACCOUNT = "5SVJw4MneZ6ecpe4PzNRP3FPxTCjHfVhpgdEQrNNgW3m";
const OP_ETH_TO_SOL = "2/0000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585/698122";
const OP_BSC_TO_ETH = "4/000000000000000000000000b6f6d86a8f9879a9c87f643768d9efc38c1da6e7/885532";
const OP_GROW_635 = "2/0000000000000000000000001cb452bea141118f33ae076265d9302fa1c7fbf9/635";

// --- classification, against real recorded responses ---------------------------------------------

test("classify (real ETH fixture): the one Ethereum -> Solana operation becomes a transfer with both real tx hashes", () => {
  const result = classifyWormholescanOperations({ chain: "ethereum", value: ETH_NODE }, ETH_OPS);
  assert.ok(result);
  assert.equal(result.transfers.length, 1);
  const [t] = result.transfers;
  assert.deepEqual(t, {
    protocol: "wormhole",
    operationId: OP_ETH_TO_SOL,
    appIds: ["PORTAL_TOKEN_BRIDGE"],
    direction: "out",
    source: { chain: "ethereum", address: ETH_NODE, txHash: "0x465e0cb533b271cb735bad4eb2a9fd643faf172221487b7aa7bb6cc4880693b9", timestamp: "2026-10-22T00:29:59Z" },
    target: {
      chain: "solana",
      address: SOL_TOKEN_ACCOUNT,
      txHash: "5BmKXqEv1a9CbFHEA2GYkyvMAJSrXfNWAG6xMzcqmV4BFahcRNBToXsVpzjt7QY9sfqtiBBXsn5VawTPrY2qXhg2",
      timestamp: "2026-10-22T00:48:39Z",
      status: "completed",
    },
    // Wormholescan returned no `data` block for this operation, so symbol/amount are honestly unknown.
    token: { address: "0xD9e795DfbC7D1dCA53d181d613681f5C1Effab65", wormholeChainId: 2, symbol: null, amount: null },
    evidenceUrl: `https://api.wormholescan.io/api/v1/operations/${OP_ETH_TO_SOL}`,
  });
});

test("classify (real ETH fixture): the same 0x address acting on Base / BSC / Arbitrum is a different account and is dropped", () => {
  const result = classifyWormholescanOperations({ chain: "ethereum", value: ETH_NODE }, ETH_OPS);
  assert.ok(result);
  const mentioned = [...result.transfers.map((t) => t.operationId), ...result.deadEnds.map((d) => d.operationId)];
  // Base(30) -> BSC(4), BSC(4) -> Solana, and Solana -> Arbitrum(23) "to 0x4971..." all name this
  // address, none of them on Ethereum.
  assert.ok(!mentioned.includes("30/0000000000000000000000008d2de8d2f73f1f4cab472ac9a881c9b123c79627/281904"));
  assert.ok(!mentioned.includes("4/000000000000000000000000b6f6d86a8f9879a9c87f643768d9efc38c1da6e7/885543"));
  assert.ok(!mentioned.includes("1/cf5f3614e2cd9b374558f35c7618b25f0d306d5e749b7d29cc030a1a15686238/102352"));
  assert.equal(result.malformed, 0);
});

test("classify (real ETH fixture): an incoming transfer from BSC is a reported dead end, not an invented hop", () => {
  const result = classifyWormholescanOperations({ chain: "ethereum", value: ETH_NODE }, ETH_OPS);
  assert.ok(result);
  assert.deepEqual(result.deadEnds, [
    {
      protocol: "wormhole",
      operationId: OP_BSC_TO_ETH,
      nodeId: ETH_NODE,
      nodeChain: "ethereum",
      direction: "in",
      reason: "counterparty-chain-unsupported",
      sourceTxHash: "0x6a3ac7f3805853285d60228fc313bcca8cad275470251e78c8d9d60bae112f2b",
      sourceTimestamp: "2026-10-21T23:06:27Z",
      sourceWormholeChainId: 4,
      targetWormholeChainId: 2,
      counterparty: ETH_NODE,
      evidenceUrl: `https://api.wormholescan.io/api/v1/operations/${OP_BSC_TO_ETH}`,
    },
  ]);
});

test("classify (real Solana fixture): incoming Ethereum transfers become edges; outgoing ones with no indexed destination tx are dead ends", () => {
  const result = classifyWormholescanOperations({ chain: "solana", value: SOL_WALLET }, SOL_OPS);
  assert.ok(result);
  assert.deepEqual(
    result.transfers.map((t) => [t.operationId.split("/")[2], t.direction, t.source.chain, t.source.address, t.target.address, t.token.symbol, t.token.amount]),
    [
      ["635", "in", "ethereum", ETH_NODE, SOL_WALLET, "GROW", "45050.09112573"],
      ["634", "in", "ethereum", ETH_NODE, SOL_WALLET, "GROW", "38272.64319163"],
      ["124", "in", "ethereum", ETH_NODE, SOL_WALLET, "bill", "38670.417836"],
      ["123", "in", "ethereum", ETH_NODE, SOL_WALLET, "bill", "38080.082929"],
    ],
  );
  assert.ok(result.transfers.every((t) => t.appIds.includes("NATIVE_TOKEN_TRANSFER")));
  // Six real Solana -> Ethereum Portal transfers with no destination tx on Wormholescan: honestly
  // "no-destination-tx", never guessed to be either "pending" or "redeemed".
  assert.equal(result.deadEnds.length, 6);
  assert.ok(result.deadEnds.every((d) => d.reason === "no-destination-tx" && d.direction === "out" && d.targetWormholeChainId === 2));
  assert.equal(result.deadEnds[0]?.counterparty, "0x49719D256A5eA16bFa579ea16E95bea9fa41A452");
});

test("classify: an address the operations don't involve gets nothing; a malformed body or operation is never used", () => {
  const unrelated = classifyWormholescanOperations({ chain: "solana", value: SOL_TOKEN_ACCOUNT }, SOL_OPS);
  assert.deepEqual(unrelated, { transfers: [], deadEnds: [], malformed: 0 });
  assert.equal(classifyWormholescanOperations({ chain: "solana", value: SOL_WALLET }, { error: "nope" }), null);
  const partial = classifyWormholescanOperations({ chain: "solana", value: SOL_WALLET }, { operations: [{ id: "1/x/1" }, "junk"] });
  assert.deepEqual(partial, { transfers: [], deadEnds: [], malformed: 2 });
});

// --- concrete test doubles (no mocking framework) -------------------------------------------------

class MapChainAdapter implements ChainAdapter {
  readonly chain: ChainId;
  readonly #byAddress: Map<string, TransactionsResult>;
  calls: string[] = [];
  constructor(chain: ChainId, byAddress: Map<string, TransactionsResult>) {
    this.chain = chain;
    this.#byAddress = byAddress;
  }
  async getBalance(address: string): Promise<Balance> {
    return { chain: this.chain, address, native: { symbol: "X", amount: "0", decimals: 0 }, asOf: "2026-01-01T00:00:00Z" };
  }
  async getRecentTransactions(address: string, _limit: number): Promise<TransactionsResult> {
    this.calls.push(address);
    return this.#byAddress.get(address) ?? { available: false, reason: "no fixture for this address" };
  }
}

/** Serves a real recorded Wormholescan body per address, through the real classifier. Unknown addresses: a real "no operations" body. */
class RecordedWormholescan implements BridgeResolver {
  readonly protocol = "wormhole" as const;
  readonly #bodies: Map<string, unknown>;
  readonly #failFor: Set<string>;
  lookups: string[] = [];
  constructor(bodies: Map<string, unknown>, failFor: string[] = []) {
    this.#bodies = bodies;
    this.#failFor = new Set(failFor);
  }
  async lookup(node: Address, _limit: number): Promise<BridgeLookupResult> {
    this.lookups.push(node.value);
    if (this.#failFor.has(node.value)) return { available: false, reason: "Wormholescan: HTTP 503" };
    const classified = classifyWormholescanOperations(node, this.#bodies.get(node.value) ?? { operations: [] });
    return classified === null ? { available: false, reason: "unexpected shape" } : { available: true, ...classified };
  }
}

const ETH_PEER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOL_PEER = "SyntheticSo1anaPeerForTests1111111111111111"; // synthetic, not a real account

function ethTx(hash: string, from: string, to: string, valueNative: string, direction: TransactionSummary["direction"], timestamp: string): TransactionSummary {
  return { chain: "ethereum", hash, timestamp, from, to, valueNative, direction };
}

function splOut(hash: string, fromTokenAccount: string, toOwner: string, timestamp: string): TransactionSummary {
  const transfer: TokenTransfer = {
    token: "97RkJ1ZV6LqDamz5eB8XK1CwvbXZ19GPzXboC1SeFtgb",
    symbol: null,
    name: null,
    decimals: 8,
    rawAmount: "100000000",
    amount: "1",
    from: SOL_WALLET,
    to: toOwner,
    fromTokenAccount,
    direction: "out",
  };
  return { chain: "solana", hash, timestamp, from: SOL_WALLET, to: null, valueNative: "0", direction: "self", tokenTransfers: [transfer], status: "success" };
}

const OPTS: TraceOptions = { maxHops: 2, breadth: 5, txLimitPerNode: 10, maxAdapterCalls: 40 };

function setup(failBridgeFor: string[] = []) {
  const eth = new MapChainAdapter(
    "ethereum",
    new Map([[ETH_NODE, { available: true, transactions: [ethTx("0xeth-peer", ETH_NODE, ETH_PEER, "1", "out", "2026-10-01T00:00:00Z")] }]]),
  );
  const sol = new MapChainAdapter(
    "solana",
    new Map([[SOL_TOKEN_ACCOUNT, { available: true, transactions: [splOut("sol-onward", SOL_TOKEN_ACCOUNT, SOL_PEER, "2026-10-22T01:00:00Z")] }]]),
  );
  const resolver = new RecordedWormholescan(new Map([[ETH_NODE, ETH_OPS], [SOL_WALLET, SOL_OPS]]), failBridgeFor);
  const bridging: BridgeTracing = { resolver, adapters: new Map<ChainId, ChainAdapter>([["ethereum", eth], ["solana", sol]]) };
  return { eth, sol, resolver, bridging };
}

// --- traversal -----------------------------------------------------------------------------------

test("traceGraph with bridging follows a real Wormhole hop onto Solana and keeps expanding there with the Solana adapter", async () => {
  const { eth, sol, resolver, bridging } = setup();
  const result = await traceGraph({ chain: "ethereum", value: ETH_NODE }, eth, OPTS, bridging);

  const bridge = result.edges.find((e) => e.kind === "bridge");
  assert.ok(bridge && bridge.kind === "bridge");
  assert.equal(bridge.id, `wormhole:${OP_ETH_TO_SOL}`);
  assert.equal(bridge.source, ETH_NODE);
  assert.equal(bridge.target, SOL_TOKEN_ACCOUNT);
  assert.equal(bridge.sourceChain, "ethereum");
  assert.equal(bridge.targetChain, "solana");
  assert.equal(bridge.hash, "0x465e0cb533b271cb735bad4eb2a9fd643faf172221487b7aa7bb6cc4880693b9");
  assert.equal(bridge.bridge.targetTxHash, "5BmKXqEv1a9CbFHEA2GYkyvMAJSrXfNWAG6xMzcqmV4BFahcRNBToXsVpzjt7QY9sfqtiBBXsn5VawTPrY2qXhg2");
  assert.equal(bridge.bridge.evidence, "wormholescan");

  // The token account was expanded on Solana: its onward SPL transfer is a real edge now.
  assert.deepEqual(sol.calls, [SOL_TOKEN_ACCOUNT]);
  assert.ok(result.edges.some((e) => e.id === "sol-onward" && e.source === SOL_TOKEN_ACCOUNT && e.target === SOL_PEER));
  assert.equal(result.nodeChains[SOL_TOKEN_ACCOUNT], "solana");
  assert.equal(result.nodeChains[SOL_PEER], "solana");
  assert.equal(result.nodeChains[ETH_PEER], "ethereum");

  // ETH_PEER has no ETH fixture -> unavailable; SOL_PEER is past maxHops -> depth-cap.
  const reasons = new Map(result.frontier.map((f) => [f.id, f.reason]));
  assert.equal(reasons.get(ETH_PEER), "unavailable");
  assert.equal(reasons.get(SOL_PEER), "depth-cap");

  // One bridge lookup per successfully expanded node, never more than chain calls.
  assert.equal(result.adapterCallsUsed, 3);
  assert.deepEqual(resolver.lookups, [ETH_NODE, SOL_TOKEN_ACCOUNT]);
  assert.equal(result.bridges.lookupsUsed, 2);
  assert.equal(result.bridges.enabled, true);
  assert.deepEqual(result.bridges.deadEnds.map((d) => [d.operationId, d.reason]), [[OP_BSC_TO_ETH, "counterparty-chain-unsupported"]]);
});

test("traceGraph without bridging is ADR 0008 unchanged: no lookups, no bridge edges, never leaves the start chain", async () => {
  const { eth, sol, resolver } = setup();
  const result = await traceGraph({ chain: "ethereum", value: ETH_NODE }, eth, OPTS);
  assert.ok(result.edges.every((e) => e.kind !== "bridge"));
  assert.deepEqual(resolver.lookups, []);
  assert.deepEqual(sol.calls, []);
  assert.deepEqual(result.bridges, { enabled: false, protocol: null, lookupsUsed: 0, lookupFailures: [], deadEnds: [], malformedOperations: 0 });
  assert.deepEqual(Object.values(result.nodeChains).filter((c) => c !== "ethereum"), []);
});

test("traceGraph: a failed bridge lookup is reported as 'couldn't check', and the node's chain edges are still kept", async () => {
  const { eth, bridging } = setup([ETH_NODE]);
  const result = await traceGraph({ chain: "ethereum", value: ETH_NODE }, eth, OPTS, bridging);
  assert.deepEqual(result.expandedIds, [ETH_NODE]);
  assert.ok(result.edges.some((e) => e.id === "0xeth-peer"));
  assert.ok(result.edges.every((e) => e.kind !== "bridge"));
  assert.deepEqual(result.bridges.lookupFailures, [{ id: ETH_NODE, chain: "ethereum", reason: "Wormholescan: HTTP 503" }]);
});

test("tracePath crosses chains: Ethereum sender -> (Wormhole) -> Solana token account -> onward Solana recipient", async () => {
  const { eth, bridging } = setup();
  const result = await tracePath({ chain: "ethereum", value: ETH_NODE }, { chain: "solana", value: SOL_PEER }, eth, {}, OPTS, bridging);
  assert.equal(result.found, true);
  assert.deepEqual(result.path.map((e) => [e.kind, e.id]), [["bridge", `wormhole:${OP_ETH_TO_SOL}`], ["token", "sol-onward"]]);
  assert.equal(result.nodeChains[SOL_PEER], "solana");
  assert.equal(result.budgetExhausted, false);
});

test("tracePath: per-hop filters apply to bridge hops too -- an unreported token symbol never passes a token filter", async () => {
  const { eth, bridging } = setup();
  // The real operation .../698122 has no symbol from Wormholescan, so token=USDC can't match it.
  const result = await tracePath({ chain: "ethereum", value: ETH_NODE }, { chain: "solana", value: SOL_PEER }, eth, { token: "USDC" }, OPTS, bridging);
  assert.equal(result.found, false);
  assert.equal(result.budgetExhausted, false);
});

test("tracePath from Solana: minAmount picks out the one real incoming bridge transfer that qualifies", async () => {
  const sol = new MapChainAdapter("solana", new Map([[SOL_WALLET, { available: true, transactions: [] }]]));
  const resolver = new RecordedWormholescan(new Map([[SOL_WALLET, SOL_OPS]]));
  const bridging: BridgeTracing = { resolver, adapters: new Map<ChainId, ChainAdapter>([["solana", sol]]) };
  const result = await tracePath(
    { chain: "solana", value: SOL_WALLET },
    { chain: "ethereum", value: ETH_NODE },
    sol,
    { token: "GROW", minAmount: "40000" },
    OPTS,
    bridging,
  );
  assert.equal(result.found, true);
  // 635 carries 45050.09 GROW; 634 carries 38272.64 and fails the filter.
  assert.deepEqual(result.path.map((e) => e.id), [`wormhole:${OP_GROW_635}`]);
});

test("edgeMatchesFilters never treats a bridge hop as native, and needs a known amount for minAmount", async () => {
  const { eth, bridging } = setup();
  const graph = await traceGraph({ chain: "ethereum", value: ETH_NODE }, eth, { ...OPTS, maxHops: 1 }, bridging);
  const bridge = graph.edges.find((e) => e.kind === "bridge");
  assert.ok(bridge);
  assert.equal(edgeMatchesFilters(bridge, { token: "native" }), false);
  assert.equal(edgeMatchesFilters(bridge, { minAmount: "0" }), false); // amount not reported -> unknown, not 0
  assert.equal(edgeMatchesFilters(bridge, {}), true);
});

test("tracePath refuses a cross-chain question without bridging instead of answering a misleading 'not found'", async () => {
  const { eth } = setup();
  await assert.rejects(tracePath({ chain: "ethereum", value: ETH_NODE }, { chain: "solana", value: SOL_PEER }, eth, {}, OPTS), /bridge tracing/);
});

test("buildTraceGraph labels a node reached over a bridge under its own chain, not the start chain's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tracer-bridge-test-"));
  try {
    const store = new JsonFileLabelStore(join(dir, "labels.json"));
    await store.addLabel({
      address: { chain: "solana", value: SOL_TOKEN_ACCOUNT },
      name: "Test token account",
      confidence: "verified",
      source: { description: "test", url: "https://example.com", addedAt: "2026-10-22" },
    });
    const { eth, bridging } = setup();
    const report = await buildTraceGraph({ chain: "ethereum", value: ETH_NODE }, eth, store, OPTS, bridging);
    const node = report.nodes.find((n) => n.id === SOL_TOKEN_ACCOUNT);
    assert.deepEqual(node?.address, { chain: "solana", value: SOL_TOKEN_ACCOUNT });
    assert.equal(node?.label?.name, "Test token account");
    assert.equal(node?.role, "expanded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
