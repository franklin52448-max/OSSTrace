import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EthereumAdapter } from "../src/adapter.ts";

// Real network test against a public RPC — no mocking, since this adapter's whole job is
// talking to a real chain correctly. Skips (not fails) if the public endpoint is unreachable,
// same pattern as this workspace's Postgres conformance suites.
const RPC_URL = process.env["ETH_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com";
// A long-known, high-activity public address (a major exchange cold wallet) — stable choice
// for a "does this return a well-formed, real balance" check.
const KNOWN_ADDRESS = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

async function rpcReachable(): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

test("getBalance returns a well-formed, real balance from a public RPC", async (t) => {
  if (!(await rpcReachable())) {
    t.skip(`${RPC_URL} unreachable from this environment — skipping live network test`);
    return;
  }
  const adapter = new EthereumAdapter({ rpcUrl: RPC_URL });
  const balance = await adapter.getBalance(KNOWN_ADDRESS);
  assert.equal(balance.chain, "ethereum");
  assert.equal(balance.address, KNOWN_ADDRESS);
  assert.equal(balance.native.symbol, "ETH");
  assert.equal(balance.native.decimals, 18);
  assert.match(balance.native.amount, /^\d+(\.\d+)?$/);
  assert.doesNotThrow(() => new Date(balance.asOf).toISOString());
});

test("a failing RPC's error message never contains the RPC URL (hosted providers put the API key in it)", async () => {
  // A real local HTTP server standing in for an RPC provider that rejects the request (e.g. a
  // revoked key). The Explorer sends this error message back to the browser in its 502 body.
  const server: Server = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const secret = "SECRET-PROVIDER-KEY-123";
  try {
    const adapter = new EthereumAdapter({ rpcUrl: `http://127.0.0.1:${port}/v2/${secret}?api-key=${secret}` });
    await assert.rejects(adapter.getBalance(KNOWN_ADDRESS), (err: Error) => {
      assert.match(err.message, /HTTP 401/);
      assert.ok(!err.message.includes(secret), `error message leaks the key: ${err.message}`);
      assert.ok(!err.message.includes(String(port)), `error message leaks the RPC URL: ${err.message}`);
      return true;
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("getRecentTransactions reports unavailable, with a reason, when no API key is configured", async () => {
  const adapter = new EthereumAdapter({ rpcUrl: RPC_URL });
  const result = await adapter.getRecentTransactions(KNOWN_ADDRESS, 5);
  assert.equal(result.available, false);
  if (!result.available) {
    assert.match(result.reason, /ETHERSCAN_API_KEY/);
  }
});
