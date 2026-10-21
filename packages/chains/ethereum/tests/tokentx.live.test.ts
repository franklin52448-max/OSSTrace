import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EthereumAdapter } from "../src/adapter.ts";
import type { EtherscanTokenTx } from "../src/etherscan.ts";

// Real network tests — no mocking. Each one skips (not fails) when the endpoint it needs is
// unreachable, or when it needs an Etherscan key and none is configured.
const RPC_URL = process.env["ETH_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com";
const ETHERSCAN_API_KEY = process.env["ETHERSCAN_API_KEY"];
/** keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event topic. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? "no result"}`);
  return body.result;
}

async function rpcReachable(): Promise<boolean> {
  try {
    await rpc("eth_chainId", []);
    return true;
  } catch {
    return false;
  }
}

async function etherscanReachable(): Promise<boolean> {
  try {
    const res = await fetch("https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethprice", {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const topicAddress = (address: string): string => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

async function checkRowsAgainstChain(t: TestContext, fixtureName: string): Promise<void> {
  if (!(await rpcReachable())) {
    t.skip(`${RPC_URL} unreachable from this environment — skipping live network test`);
    return;
  }
  const fx = JSON.parse(await readFile(new URL(`./fixtures/${fixtureName}`, import.meta.url), "utf8")) as {
    tokentx: EtherscanTokenTx[];
  };
  for (const row of fx.tokentx) {
    const receipt = await rpc<{ blockNumber: string; logs: { address: string; topics: string[]; data: string }[] }>(
      "eth_getTransactionReceipt",
      [row.hash],
    );
    assert.equal(BigInt(receipt.blockNumber), BigInt(row.blockNumber), `${row.hash}: block`);
    const matching = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() === row.contractAddress &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics[1] === topicAddress(row.from) &&
        log.topics[2] === topicAddress(row.to) &&
        BigInt(log.data) === BigInt(row.value),
    );
    assert.ok(matching, `${row.hash}: no on-chain Transfer log matching from/to/value/contract of the tokentx row`);
    const decimals = await rpc<string>("eth_call", [{ to: row.contractAddress, data: "0x313ce567" }, "latest"]);
    assert.equal(String(Number(BigInt(decimals))), row.tokenDecimal, `${row.contractAddress}: decimals()`);
  }
}

test("Etherscan's documented tokentx example matches the real chain: from/to are the Transfer event's, not the tx's", async (t) => {
  await checkRowsAgainstChain(t, "mkr-redeem-0xe8c2.json");
});

test("the recorded Universal Router token rows match the real chain", async (t) => {
  await checkRowsAgainstChain(t, "universal-router-2-blocks.json");
});

test("an invalid Etherscan key surfaces Etherscan's real error reason, not a generic NOTOK", async (t) => {
  if (!(await etherscanReachable())) {
    t.skip("api.etherscan.io unreachable from this environment — skipping live network test");
    return;
  }
  const adapter = new EthereumAdapter({ rpcUrl: RPC_URL, etherscanApiKey: "not-a-real-key" });
  const result = await adapter.getRecentTransactions("0x4e83362442b8d1bec281594cea3050c8eb01311c", 2);
  assert.equal(result.available, false);
  if (!result.available) {
    assert.match(result.reason, /^Etherscan (txlist|tokentx): /);
    assert.match(result.reason, /api key/i);
  }
});

test("with a real ETHERSCAN_API_KEY: merged native + ERC-20 history is well-formed", async (t) => {
  if (!ETHERSCAN_API_KEY) {
    t.skip("ETHERSCAN_API_KEY not set — skipping live Etherscan history test");
    return;
  }
  if (!(await etherscanReachable())) {
    t.skip("api.etherscan.io unreachable from this environment — skipping live network test");
    return;
  }
  // Etherscan's own documentation example address: has both normal txs and ERC-20 transfers.
  const address = "0x4e83362442b8d1bec281594cea3050c8eb01311c";
  const adapter = new EthereumAdapter({ rpcUrl: RPC_URL, etherscanApiKey: ETHERSCAN_API_KEY });
  const result = await adapter.getRecentTransactions(address, 10);
  assert.equal(result.available, true, result.available ? "" : result.reason);
  if (!result.available) return;
  assert.ok(result.transactions.length > 0);
  assert.ok(result.transactions.length <= 10);
  assert.equal(new Set(result.transactions.map((tx) => tx.hash)).size, result.transactions.length);
  for (const tx of result.transactions) {
    assert.match(tx.hash, /^0x[0-9a-f]{64}$/);
    assert.match(tx.valueNative, /^\d+(\.\d+)?$/);
    for (const transfer of tx.tokenTransfers ?? []) {
      assert.match(transfer.rawAmount, /^\d+$/);
      if (transfer.amount !== null) assert.match(transfer.amount, /^\d+(\.\d+)?$/);
      assert.ok(transfer.from === address || transfer.to === address, "every token transfer involves the address");
    }
  }
});
