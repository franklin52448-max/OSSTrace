import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CompositeLabelStore,
  JsonFileLabelStore,
  type Address,
  type Balance,
  type ChainAdapter,
  type ChainId,
  type Entity,
  type Label,
  type LabelReader,
  type Tag,
  type TransactionSummary,
  type TransactionsResult,
} from "@osstrace/core";
import { assessRisk, clampRiskOptions, DEFAULT_RISK_TRACE_OPTIONS, RecordingAdapter, riskTagsOf, SCORE_BY_HOPS } from "../src/risk.ts";
import type { TraceOptions } from "@osstrace/tracer/src/trace.ts";

/** A real, concrete ChainAdapter stand-in: each address has its own fixed transaction list, or none at all. */
class MapChainAdapter implements ChainAdapter {
  readonly chain: ChainId;
  readonly #byAddress: Map<string, TransactionsResult>;
  calls: string[] = [];
  constructor(chain: ChainId, byAddress: Map<string, TransactionsResult>) {
    this.chain = chain;
    this.#byAddress = byAddress;
  }
  async getBalance(address: string): Promise<Balance> {
    return { chain: this.chain, address, native: { symbol: "ETH", amount: "0", decimals: 18 }, asOf: "2026-01-01T00:00:00Z" };
  }
  async getRecentTransactions(address: string, limit: number): Promise<TransactionsResult> {
    this.calls.push(address);
    const result = this.#byAddress.get(address) ?? { available: false, reason: "no fixture for this address" };
    // Honour `limit` the way a real adapter does: newest-first page, at most `limit` long.
    return result.available ? { available: true, transactions: result.transactions.slice(0, limit) } : result;
  }
}

/** A real, concrete in-memory LabelReader: fixed tags/labels per address. */
class MapLabelReader implements LabelReader {
  readonly #tags: Tag[];
  readonly #labels: Label[];
  constructor(tags: Tag[], labels: Label[] = []) {
    this.#tags = tags;
    this.#labels = labels;
  }
  async getLabel(address: Address): Promise<Label | null> {
    return this.#labels.find((l) => l.address.chain === address.chain && l.address.value === address.value) ?? null;
  }
  async getTags(address: Address): Promise<Tag[]> {
    return this.#tags.filter((t) => t.address.chain === address.chain && t.address.value === address.value);
  }
  async getEntity(_address: Address): Promise<Entity | null> {
    return null;
  }
}

const CENTER = "0x1111111111111111111111111111111111111111";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = `0x${"c".repeat(40)}`;
const D = "0xdddddddddddddddddddddddddddddddddddddddd";
const E = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const F = "0xffffffffffffffffffffffffffffffffffffffff";

const TEST_SOURCE = { description: "test fixture", url: "https://example.invalid/test-fixture", addedAt: "2026-10-22" };
const sanctionedTag = (value: string): Tag => ({ address: { chain: "ethereum", value }, tag: "sanctioned", source: TEST_SOURCE });

function tx(hash: string, from: string, to: string, direction: TransactionSummary["direction"], timestamp: string): TransactionSummary {
  return { chain: "ethereum", hash, timestamp, from, to, valueNative: "1", direction };
}
const ok = (transactions: TransactionSummary[]): TransactionsResult => ({ available: true, transactions });

/** A chain CENTER -> A -> B -> C -> D, each node's history holding both of its real edges. */
function chainAdapter(): MapChainAdapter {
  return new MapChainAdapter(
    "ethereum",
    new Map([
      [CENTER, ok([tx("h1", CENTER, A, "out", "2026-01-01T00:00:00Z")])],
      [A, ok([tx("h2", A, B, "out", "2026-01-02T00:00:00Z"), tx("h1", CENTER, A, "in", "2026-01-01T00:00:00Z")])],
      [B, ok([tx("h3", B, C, "out", "2026-01-03T00:00:00Z"), tx("h2", A, B, "in", "2026-01-02T00:00:00Z")])],
      [C, ok([tx("h4", C, D, "out", "2026-01-04T00:00:00Z"), tx("h3", B, C, "in", "2026-01-03T00:00:00Z")])],
      [D, ok([tx("h4", C, D, "in", "2026-01-04T00:00:00Z")])],
    ]),
  );
}

const OPTS: TraceOptions = { maxHops: 3, breadth: 5, txLimitPerNode: 25, maxAdapterCalls: 40 };
const center: Address = { chain: "ethereum", value: CENTER };

test("the score table is exactly ADR 0010's: 100/75/50/25 for 0-3 hops", () => {
  assert.deepEqual(SCORE_BY_HOPS, [100, 75, 50, 25]);
});

test("clampRiskOptions uses risk scoring's defaults and Tracer's own clamps", () => {
  assert.deepEqual(clampRiskOptions({}), DEFAULT_RISK_TRACE_OPTIONS);
  assert.deepEqual(clampRiskOptions({ maxHops: 9, txLimitPerNode: 500 }), { ...DEFAULT_RISK_TRACE_OPTIONS, maxHops: 3, txLimitPerNode: 50 });
});

test("riskTagsOf keeps only listed risk tags — a protocol-contract tag is not risk", () => {
  const protocol: Tag = { address: { chain: "ethereum", value: A }, tag: "protocol-contract", source: TEST_SOURCE };
  assert.deepEqual(riskTagsOf([protocol, sanctionedTag(A)]), [sanctionedTag(A)]);
  assert.deepEqual(riskTagsOf([protocol]), []);
});

test("direct tag: severe/100, the tag and its source are returned, and no adapter call is made", async () => {
  const adapter = chainAdapter();
  const result = await assessRisk(center, adapter, new MapLabelReader([sanctionedTag(CENTER)]), OPTS);
  assert.equal(result.score, 100);
  assert.equal(result.tier, "severe");
  assert.equal(result.basis, "direct");
  assert.deepEqual(result.directTags, [sanctionedTag(CENTER)]);
  assert.equal(result.search, null);
  assert.equal(result.searchIncomplete, false);
  assert.equal(result.scoreIsLowerBound, false);
  assert.deepEqual(adapter.calls, []);
});

for (const [hops, flaggedId, tier] of [
  [1, A, "high"],
  [2, B, "medium"],
  [3, C, "low"],
] as const) {
  test(`hop-distance exposure at ${hops} hop(s): score ${SCORE_BY_HOPS[hops]}, tier ${tier}, with the real path as evidence`, async () => {
    const label: Label = { address: { chain: "ethereum", value: flaggedId }, name: "Flagged fixture", confidence: "verified", source: TEST_SOURCE };
    const result = await assessRisk(center, chainAdapter(), new MapLabelReader([sanctionedTag(flaggedId)], [label]), OPTS);
    assert.equal(result.basis, "hop-distance");
    assert.equal(result.score, SCORE_BY_HOPS[hops]);
    assert.equal(result.tier, tier);
    assert.equal(result.nearest?.id, flaggedId);
    assert.equal(result.nearest?.hops, hops);
    assert.deepEqual(result.nearest?.riskTags, [sanctionedTag(flaggedId)]);
    assert.deepEqual(result.nearest?.label, label);
    // The path is the real edge chain from CENTER to the flagged address, in order.
    assert.deepEqual(
      result.nearest?.path.map((e) => e.hash),
      ["h1", "h2", "h3"].slice(0, hops),
    );
    // The whole radius was covered: D sits exactly at maxHops (depth-cap) — the radius edge, not a gap.
    assert.equal(result.searchIncomplete, false);
    assert.equal(result.scoreIsLowerBound, false);
    assert.equal(result.search?.beyondRadius, 1);
  });
}

test("a flagged address past maxHops is never counted", async () => {
  // D is 4 hops out; with maxHops 3 it's never reached.
  const result = await assessRisk(center, chainAdapter(), new MapLabelReader([sanctionedTag(D)]), OPTS);
  assert.equal(result.tier, "none");
  assert.equal(result.flagged.length, 0);
});

test("the nearest flagged address wins; every flagged address within the radius is still listed", async () => {
  const result = await assessRisk(center, chainAdapter(), new MapLabelReader([sanctionedTag(C), sanctionedTag(A)]), OPTS);
  assert.equal(result.score, 75);
  assert.deepEqual(
    result.flagged.map((f) => [f.id, f.hops]),
    [
      [A, 1],
      [C, 3],
    ],
  );
});

test("no exposure, search complete: tier none, score 0 — a real negative within the radius", async () => {
  const result = await assessRisk(center, chainAdapter(), new MapLabelReader([]), OPTS);
  assert.equal(result.tier, "none");
  assert.equal(result.score, 0);
  assert.equal(result.searchIncomplete, false);
  assert.equal(result.scoreIsLowerBound, false);
  assert.equal(result.search?.complete, true);
  assert.deepEqual(result.search?.gaps, []);
  assert.equal(result.search?.nodesChecked, 4); // CENTER, A, B, C
});

test("no exposure but the call budget ran out: inconclusive, score null, never reported as none", async () => {
  const result = await assessRisk(center, chainAdapter(), new MapLabelReader([sanctionedTag(C)]), { ...OPTS, maxAdapterCalls: 2 });
  // C (the real flagged address) was never reached because B couldn't be expanded.
  assert.equal(result.tier, "inconclusive");
  assert.equal(result.score, null);
  assert.equal(result.searchIncomplete, true);
  assert.equal(result.scoreIsLowerBound, true);
  assert.deepEqual(result.search?.gaps, [{ id: B, hops: 2, reason: "budget-exhausted" }]);
  assert.match(result.explanation, /NOT a clean result/);
});

test("no exposure but a node was unavailable: inconclusive", async () => {
  const adapter = new MapChainAdapter("ethereum", new Map([[CENTER, ok([tx("h1", CENTER, A, "out", "2026-01-01T00:00:00Z")])]]));
  const result = await assessRisk(center, adapter, new MapLabelReader([]), OPTS);
  assert.equal(result.tier, "inconclusive");
  // The adapter's own reason text is carried onto the gap, not reduced to a bare "unavailable".
  assert.deepEqual(result.search?.gaps, [{ id: A, hops: 1, reason: "unavailable", detail: "no fixture for this address" }]);
});

test("the scored address's own history unavailable: inconclusive with a gap at hop 0", async () => {
  const adapter = new MapChainAdapter("ethereum", new Map());
  const result = await assessRisk(center, adapter, new MapLabelReader([]), OPTS);
  assert.equal(result.tier, "inconclusive");
  assert.deepEqual(result.search?.gaps, [{ id: CENTER, hops: 0, reason: "unavailable", detail: "no fixture for this address" }]);
});

test("no exposure but a breadth cap skipped a neighbor: inconclusive", async () => {
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([
      [CENTER, ok([tx("h-a", CENTER, A, "out", "2026-01-02T00:00:00Z"), tx("h-e", CENTER, E, "out", "2026-01-01T00:00:00Z")])],
      [A, ok([tx("h-a", CENTER, A, "in", "2026-01-02T00:00:00Z")])],
    ]),
  );
  const result = await assessRisk(center, adapter, new MapLabelReader([]), { ...OPTS, breadth: 1 });
  assert.equal(result.tier, "inconclusive");
  assert.deepEqual(result.search?.gaps, [{ id: E, hops: 1, reason: "breadth-cap" }]);
});

test("no exposure but a node's history page came back full: inconclusive (history-truncated)", async () => {
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([
      [CENTER, ok([tx("h-a", CENTER, A, "out", "2026-01-03T00:00:00Z"), tx("h-f", F, CENTER, "in", "2026-01-01T00:00:00Z")])],
      [A, ok([tx("h-a", CENTER, A, "in", "2026-01-03T00:00:00Z")])],
    ]),
  );
  // txLimitPerNode 1: CENTER returns a full page (1 of its 2 txs), so F's transfer — and F, which IS
  // sanctioned — is never seen. That must surface as a gap, not as "none".
  const result = await assessRisk(center, adapter, new MapLabelReader([sanctionedTag(F)]), { ...OPTS, txLimitPerNode: 1 });
  assert.equal(result.tier, "inconclusive");
  assert.deepEqual(result.search?.gaps, [
    { id: CENTER, hops: 0, reason: "history-truncated" },
    { id: A, hops: 1, reason: "history-truncated" },
  ]);
});

test("exposure found, but a gap closer in could hide a nearer one: score is a lower bound", async () => {
  // CENTER -> A -> B (sanctioned, hop 2); CENTER -> E, E unavailable at hop 1. E's unchecked
  // neighbors would sit at hop 2 — they can't beat B, so the score stands. A hop-0 gap (CENTER's own
  // page full) could hide a hop-1 flagged address, and that one makes the score a lower bound.
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([
      [CENTER, ok([tx("h-a", CENTER, A, "out", "2026-01-03T00:00:00Z"), tx("h-e", CENTER, E, "out", "2026-01-02T00:00:00Z")])],
      [A, ok([tx("h-b", A, B, "out", "2026-01-04T00:00:00Z")])],
    ]),
  );
  const notLowerBound = await assessRisk(center, adapter, new MapLabelReader([sanctionedTag(B)]), OPTS);
  assert.equal(notLowerBound.score, 50);
  assert.equal(notLowerBound.searchIncomplete, true); // E unavailable at hop 1
  assert.equal(notLowerBound.scoreIsLowerBound, false); // ...but E's neighbors are at hop 2, can't be nearer than B

  const lowerBound = await assessRisk(center, adapter, new MapLabelReader([sanctionedTag(B)]), { ...OPTS, txLimitPerNode: 2 });
  // CENTER's page is now full (2 of 2 asked): an older counterparty at hop 1 could exist.
  assert.equal(lowerBound.score, 50);
  assert.equal(lowerBound.scoreIsLowerBound, true);
  assert.match(lowerBound.explanation, /treat this score as a minimum/);
});

test("RecordingAdapter records what the adapter actually returned and changes nothing", async () => {
  const inner = chainAdapter();
  const recording = new RecordingAdapter(inner);
  const result = await recording.getRecentTransactions(A, 1);
  assert.equal(result.available && result.transactions.length, 1);
  assert.equal(recording.fetchedCountById.get(A), 1);
  assert.equal((await recording.getRecentTransactions(E, 5)).available, false);
  assert.equal(recording.fetchedCountById.has(E), false);
});

// --- Against this project's real, ingested seed labelset (data/labels/*.json) ---

const DATA_DIR = fileURLToPath(new URL("../../../../data/labels/", import.meta.url));
const DATASETS = ["ofac-sdn.json", "uk-sanctions-list.json", "safe-deployments.json"];

function realStore(): CompositeLabelStore {
  return new CompositeLabelStore(DATASETS.map((f) => new JsonFileLabelStore(`${DATA_DIR}${f}`)));
}

async function firstTagged(file: string, tag: string, chain: ChainId): Promise<Tag> {
  const data = JSON.parse(await readFile(`${DATA_DIR}${file}`, "utf8")) as { tags: Tag[] };
  const found = data.tags.find((t) => t.tag === tag && t.address.chain === chain);
  assert.ok(found, `expected at least one ${chain} "${tag}" tag in ${file}`);
  return found;
}

test("real seed labelset: a real OFAC-listed Ethereum address scores severe/100 directly, citing OFAC", async () => {
  const ofac = await firstTagged("ofac-sdn.json", "sanctioned", "ethereum");
  const adapter = new MapChainAdapter("ethereum", new Map());
  const result = await assessRisk(ofac.address, adapter, realStore(), OPTS);
  assert.equal(result.tier, "severe");
  assert.equal(result.score, 100);
  assert.ok(result.directTags.every((t) => t.tag === "sanctioned"));
  assert.ok(result.directTags.some((t) => t.source.url.includes("ofac.treas.gov")));
  assert.deepEqual(adapter.calls, []);
});

test("real seed labelset: a real OFAC-listed Solana address scores severe directly (case preserved)", async () => {
  const ofac = await firstTagged("ofac-sdn.json", "sanctioned", "solana");
  const result = await assessRisk(ofac.address, new MapChainAdapter("solana", new Map()), realStore(), OPTS);
  assert.equal(result.tier, "severe");
});

test("real seed labelset: a real Safe protocol contract is not a risk signal by itself", async () => {
  const safe = await firstTagged("safe-deployments.json", "protocol-contract", "ethereum");
  const adapter = new MapChainAdapter("ethereum", new Map([[safe.address.value, ok([])]]));
  const result = await assessRisk(safe.address, adapter, realStore(), OPTS);
  assert.equal(result.tier, "none");
  assert.equal(result.score, 0);
});

test("real seed labelset: one hop from a real OFAC-listed address scores high, with OFAC's real citation as the evidence", async () => {
  const ofac = await firstTagged("ofac-sdn.json", "sanctioned", "ethereum");
  const sanctioned = ofac.address.value;
  // The transfer itself is a test fixture; the sanctioned address and its tag are real ingested data.
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([
      [CENTER, ok([tx("h-real", sanctioned, CENTER, "in", "2026-01-01T00:00:00Z")])],
      [sanctioned, ok([tx("h-real", sanctioned, CENTER, "out", "2026-01-01T00:00:00Z")])],
    ]),
  );
  const result = await assessRisk(center, adapter, realStore(), OPTS);
  assert.equal(result.tier, "high");
  assert.equal(result.score, 75);
  assert.equal(result.nearest?.id, sanctioned);
  assert.ok(result.nearest?.label, "the real OFAC label is attached to the nearest exposure");
  assert.ok(result.nearest?.riskTags.some((t) => t.source.url.includes("ofac.treas.gov")));
  assert.equal(result.searchIncomplete, false);
});
