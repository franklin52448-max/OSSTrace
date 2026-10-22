import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupportedChain, normalizeAddress } from "../src/address.ts";

/** Direct cases for the one normalization rule shared by HTTP lookup and websocket subscribe. */

test("normalizeAddress: Ethereum addresses are lowercased (checksum casing is cosmetic)", () => {
  assert.deepEqual(normalizeAddress("ethereum", "0xABCDEF0000000000000000000000000000000001"), {
    chain: "ethereum",
    value: "0xabcdef0000000000000000000000000000000001",
  });
  assert.deepEqual(
    normalizeAddress("ethereum", "0xAbCdEf0000000000000000000000000000000001"),
    normalizeAddress("ethereum", "0xabcdef0000000000000000000000000000000001"),
  );
});

test("normalizeAddress: surrounding whitespace is trimmed on both chains", () => {
  assert.equal(normalizeAddress("ethereum", "  0xAbC\t\n").value, "0xabc");
  assert.equal(
    normalizeAddress("solana", " So11111111111111111111111111111111111111112 \n").value,
    "So11111111111111111111111111111111111111112",
  );
});

test("normalizeAddress: Solana base58 is case-sensitive and kept exactly as given", () => {
  const mixed = "So11111111111111111111111111111111111111112";
  assert.deepEqual(normalizeAddress("solana", mixed), { chain: "solana", value: mixed });
  assert.notEqual(normalizeAddress("solana", mixed).value, normalizeAddress("solana", mixed.toLowerCase()).value);
});

test("normalizeAddress: inner whitespace is not touched", () => {
  assert.equal(normalizeAddress("ethereum", " 0xA B ").value, "0xa b");
});

test("isSupportedChain: only the registered chains", () => {
  assert.equal(isSupportedChain("ethereum"), true);
  assert.equal(isSupportedChain("solana"), true);
  assert.equal(isSupportedChain("Ethereum"), false);
  assert.equal(isSupportedChain("dogecoin"), false);
  assert.equal(isSupportedChain(""), false);
});
