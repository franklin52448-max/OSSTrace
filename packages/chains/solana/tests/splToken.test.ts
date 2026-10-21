import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { TokenTransfer } from "@opentrace/core";
import { SolanaAdapter, summarizeTransaction } from "../src/adapter.ts";
import { decodeSplTransfers } from "../src/splToken.ts";
import { liveHistoryOrSkip, liveOrSkip, RPC_URL, rpcReachable } from "./liveRpc.ts";

// The fixtures are two real mainnet transactions, captured verbatim as raw JSON-RPC
// `getTransaction` (`jsonParsed`) responses — the exact data getParsedTransactions decodes from.
// The live tests at the bottom re-fetch them from the chain and check they decode identically.
const RAYDIUM_SWAP = "raydium-v4-swap-transfer.json";
const JUPITER_ROUTE = "jupiter-route-transferChecked.json";
const RAYDIUM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const RAYDIUM_SWAPPER = "6MtUE8BGGvThA9SvBP6jNoqzuV87G9yC4WsLRvVoS173";
const JUPITER_SWAPPER = "GjKjqQc5MVw81TGKNZFhLtjhg9BpsSeDoESPtdH8KXHi";

async function loadTx(name: string): Promise<ParsedTransactionWithMeta & { signature: string }> {
  const body = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    result: ParsedTransactionWithMeta;
  };
  return { ...body.result, signature: body.result.transaction.signatures[0]! };
}

const brief = (t: TokenTransfer) => [t.token, t.amount, t.from, t.to, t.direction];

test("plain `transfer` (no mint/decimals in the instruction) resolves both from the tx's own token balances", async () => {
  const tx = await loadTx(RAYDIUM_SWAP);
  const [sold] = decodeSplTransfers(tx, RAYDIUM_SWAPPER);
  assert.deepEqual(sold, {
    token: "8Lqgcs9hhbu49iwwFReDhNWQVJfnENpG4JGx9Afvpump",
    symbol: null,
    name: null,
    decimals: 6,
    rawAmount: "85437459163",
    amount: "85437.459163",
    from: RAYDIUM_SWAPPER,
    to: RAYDIUM_AUTHORITY,
    fromTokenAccount: "HujqQtd1VjuEPmu2QWvy1LdT2rhJX5nWMVPeiTN22aHp",
    toTokenAccount: "GFheF3WyBKR6jS5kw7LqZMhkcZqMMniRDXCkC8N5twML",
    direction: "out",
  });
});

test("a temporary token account (created and closed in the same tx) gets its owner from initializeAccount3", async () => {
  const tx = await loadTx(RAYDIUM_SWAP);
  // Hg9t... is a WSOL account opened and closed inside this swap: absent from both token-balance
  // lists, so its owner only comes from the decoded initializeAccount3 instruction.
  const received = decodeSplTransfers(tx, RAYDIUM_SWAPPER)[1];
  assert.deepEqual(brief(received!), [
    "So11111111111111111111111111111111111111112",
    "0.101843126",
    RAYDIUM_AUTHORITY,
    RAYDIUM_SWAPPER,
    "in",
  ]);
  assert.equal(received?.toTokenAccount, "Hg9tdnz9pmS26pm6pMrDYLyNPfHBvxeEU36y7xq62uh1");
});

test("direction is relative to the queried address: the pool side of the same swap is mirrored", async () => {
  const tx = await loadTx(RAYDIUM_SWAP);
  assert.deepEqual(
    decodeSplTransfers(tx, RAYDIUM_AUTHORITY).map((t) => t.direction),
    ["in", "out"],
  );
});

test("querying a token account directly matches transfers on that account", async () => {
  const tx = await loadTx(RAYDIUM_SWAP);
  const onVault = decodeSplTransfers(tx, "GFheF3WyBKR6jS5kw7LqZMhkcZqMMniRDXCkC8N5twML");
  assert.deepEqual(onVault.map(brief), [
    ["8Lqgcs9hhbu49iwwFReDhNWQVJfnENpG4JGx9Afvpump", "85437.459163", RAYDIUM_SWAPPER, RAYDIUM_AUTHORITY, "in"],
  ]);
});

test("an address no transfer touches gets no token transfers", async () => {
  const tx = await loadTx(RAYDIUM_SWAP);
  assert.deepEqual(decodeSplTransfers(tx, "11111111111111111111111111111111"), []);
});

test("transferChecked (incl. Token-2022 and inner instructions) uses its own mint + decimals; amounts reconcile", async () => {
  const tx = await loadTx(JUPITER_ROUTE);
  const transfers = decodeSplTransfers(tx, JUPITER_SWAPPER);
  assert.deepEqual(transfers.map(brief), [
    ["So11111111111111111111111111111111111111112", "0.007356395", JUPITER_SWAPPER, "9nnLbotNTcUhvbrsA6Mdkx45Sm82G35zo28AqUvjExn8", "out"],
    ["6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", "0.426655", "9nnLbotNTcUhvbrsA6Mdkx45Sm82G35zo28AqUvjExn8", JUPITER_SWAPPER, "in"],
    // A Token-2022 mint (program TokenzQd...) — parsed by the RPC under the same "spl-token" shape.
    ["2bCCHQadi4QeHWPKG3w13siCyWWQPgkFtniouTqVpump", "4266.49683", "AQN7UkKYSnaZns61dVW2Q6hQmm7WiFSAyjBon6FVwhGf", JUPITER_SWAPPER, "in"],
    ["6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", "0.426549", JUPITER_SWAPPER, "AQN7UkKYSnaZns61dVW2Q6hQmm7WiFSAyjBon6FVwhGf", "out"],
    ["6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", "0.000106", JUPITER_SWAPPER, "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD", "out"],
  ]);
  // Cross-check against the chain's own accounting: the swapper's 6p6x token account (4DBP...)
  // starts and ends this tx at 0, so what came in must equal what went out.
  const sum = (dir: string) =>
    transfers.filter((t) => t.token === "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN" && t.direction === dir).reduce((acc, t) => acc + BigInt(t.rawAmount), 0n);
  assert.equal(sum("in"), sum("out"));
  // And its Token-2022 account's balance rose by exactly the decoded amount.
  const pre = tx.meta?.preTokenBalances?.find((b) => b.accountIndex === 7)?.uiTokenAmount.amount;
  const post = tx.meta?.postTokenBalances?.find((b) => b.accountIndex === 7)?.uiTokenAmount.amount;
  assert.equal(BigInt(post!) - BigInt(pre!), 4266496830n);
});

test("summarizeTransaction keeps the native-SOL view at the top level and attaches tokenTransfers", async () => {
  const tx = await loadTx(RAYDIUM_SWAP);
  const summary = summarizeTransaction({ signature: tx.signature, blockTime: tx.blockTime ?? null }, tx, RAYDIUM_SWAPPER);
  assert.equal(summary.hash, tx.signature);
  // No system transfer involves the swapper, so the top level is still the honest balance-delta
  // fallback: +0.103275788 SOL (the unwrapped WSOL plus closed-account rent, minus the fee).
  assert.equal(summary.from, "unresolved (non-transfer instruction)");
  assert.equal(summary.to, RAYDIUM_SWAPPER);
  assert.equal(summary.valueNative, "0.103275788");
  assert.equal(summary.direction, "in");
  assert.equal(summary.tokenTransfers?.length, 2);
});

test("a transaction with no SPL transfer for the address has no tokenTransfers key (old shape, unchanged)", async () => {
  const tx = await loadTx(RAYDIUM_SWAP);
  const summary = summarizeTransaction({ signature: tx.signature, blockTime: tx.blockTime ?? null }, tx, "ComputeBudget111111111111111111111111111111");
  assert.equal("tokenTransfers" in summary, false);
});

// --- live: the same transactions, fetched from the real chain right now ---

for (const name of [RAYDIUM_SWAP, JUPITER_ROUTE]) {
  test(`live: ${name} re-fetched from the chain decodes identically to the recorded fixture`, async (t) => {
    if (!(await rpcReachable())) {
      t.skip(`${RPC_URL} unreachable from this environment — skipping live network test`);
      return;
    }
    const recorded = await loadTx(name);
    const conn = new Connection(RPC_URL, "confirmed");
    const live = await liveOrSkip(t, () => conn.getParsedTransaction(recorded.signature, { maxSupportedTransactionVersion: 255 }));
    if (live === undefined) return;
    assert.ok(live, `${recorded.signature} not returned by ${RPC_URL}`);
    for (const address of [RAYDIUM_AUTHORITY, RAYDIUM_SWAPPER, JUPITER_SWAPPER]) {
      assert.deepEqual(decodeSplTransfers(live, address), decodeSplTransfers(recorded, address));
    }
  });
}

test("live: recent Raydium AMM authority activity yields well-formed decoded SPL transfers", async (t) => {
  if (!(await rpcReachable())) {
    t.skip(`${RPC_URL} unreachable from this environment — skipping live network test`);
    return;
  }
  // Raydium AMM v4's pool authority owns every v4 pool vault, so it's in a constant stream of
  // swaps. Not *every* recent tx moves tokens, though — arbitrage bots routinely land
  // transactions that read the pool and exit without a transfer (seen live while building this)
  // — so this checks that whatever is decoded is well-formed and genuinely involves the
  // authority, not that a specific count appears. The fixture tests above pin exact values.
  const adapter = new SolanaAdapter({ rpcUrl: RPC_URL });
  const result = await liveHistoryOrSkip(t, () => adapter.getRecentTransactions(RAYDIUM_AUTHORITY, 3));
  if (!result) return;
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.ok(result.transactions.length > 0);
  const transfers = result.transactions.flatMap((tx) => tx.tokenTransfers ?? []);
  for (const tx of result.transactions) {
    if (tx.tokenTransfers) assert.ok(tx.tokenTransfers.length > 0, "tokenTransfers is absent, never an empty array");
  }
  for (const transfer of transfers) {
    assert.match(transfer.rawAmount, /^\d+$/);
    if (transfer.amount !== null) assert.match(transfer.amount, /^\d+(\.\d+)?$/);
    assert.ok(transfer.fromTokenAccount && transfer.toTokenAccount);
    assert.ok(
      transfer.from === RAYDIUM_AUTHORITY || transfer.to === RAYDIUM_AUTHORITY,
      "every reported transfer involves an account the authority owns",
    );
  }
});
