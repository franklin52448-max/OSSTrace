import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalAddress, isChainId, isRealAddress, SUPPORTED_CHAINS } from "../src/addressFormat.ts";

// Same real addresses used throughout the repo's other tests (e.g. private-labels/tests/helpers.ts).
const ETH_ADDR = "0x00000000219ab540356cbb839cbe05303d7705fa";
const SOL_ADDR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

test("isChainId accepts only the two supported chains", () => {
  assert.equal(isChainId("ethereum"), true);
  assert.equal(isChainId("solana"), true);
  assert.equal(isChainId("bitcoin"), false);
  assert.equal(isChainId(42), false);
  assert.deepEqual(SUPPORTED_CHAINS, ["ethereum", "solana"]);
});

test("canonicalAddress lowercases Ethereum (checksum case is not identity) and leaves Solana exact", () => {
  assert.equal(canonicalAddress("ethereum", "0x00000000219AB540356cBB839Cbe05303d7705Fa"), ETH_ADDR);
  assert.equal(canonicalAddress("solana", SOL_ADDR), SOL_ADDR);
  // Lowercasing a base58 address names a different account, so canonicalAddress must not do it.
  assert.notEqual(canonicalAddress("solana", SOL_ADDR.toLowerCase()), SOL_ADDR);
});

test("isRealAddress: Ethereum is 0x + 40 hex chars, any case", () => {
  assert.equal(isRealAddress("ethereum", ETH_ADDR), true);
  assert.equal(isRealAddress("ethereum", "0x00000000219AB540356cBB839Cbe05303d7705Fa"), true);
  assert.equal(isRealAddress("ethereum", "0x1234"), false, "too short");
  assert.equal(isRealAddress("ethereum", "0xzz000000219ab540356cbb839cbe05303d7705fa"), false, "not hex");
  assert.equal(isRealAddress("ethereum", SOL_ADDR), false, "not 0x-prefixed");
  assert.equal(isRealAddress("ethereum", null), false);
});

test("isRealAddress: Solana is 32–44 base58 characters (no 0, O, I, l)", () => {
  assert.equal(isRealAddress("solana", SOL_ADDR), true);
  assert.equal(isRealAddress("solana", "0OIl" + SOL_ADDR.slice(4)), false, "contains non-base58 characters");
  assert.equal(isRealAddress("solana", ETH_ADDR), false, "not base58-shaped");
  assert.equal(isRealAddress("solana", null), false);
});
