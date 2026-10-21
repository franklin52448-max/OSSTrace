import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTokenAmount, lamportsToSol } from "../src/units.ts";

test("formatTokenAmount scales by the token's decimals, trimming trailing zeros", () => {
  assert.equal(formatTokenAmount("85437459163", 6), "85437.459163");
  assert.equal(formatTokenAmount("4266496830", 6), "4266.49683");
  assert.equal(formatTokenAmount("1000000", 6), "1");
  assert.equal(formatTokenAmount("106", 6), "0.000106");
});

test("formatTokenAmount handles zero-decimal tokens and zero amounts", () => {
  assert.equal(formatTokenAmount("42", 0), "42");
  assert.equal(formatTokenAmount("0", 9), "0");
});

test("formatTokenAmount is exact above Number.MAX_SAFE_INTEGER (u64 token amounts)", () => {
  assert.equal(formatTokenAmount("18446744073709551615", 9), "18446744073.709551615");
});

test("formatTokenAmount rejects anything that isn't an unsigned integer string", () => {
  assert.throws(() => formatTokenAmount("-5", 6));
  assert.throws(() => formatTokenAmount("1.5", 6));
});

test("lamportsToSol renders one whole SOL with no decimal point", () => {
  assert.equal(lamportsToSol(1_000_000_000), "1");
});

test("lamportsToSol renders fractional amounts, trimming trailing zeros", () => {
  assert.equal(lamportsToSol(1_500_000_000), "1.5");
});

test("lamportsToSol handles zero", () => {
  assert.equal(lamportsToSol(0), "0");
});

test("lamportsToSol handles amounts smaller than one lamport-whole unit", () => {
  assert.equal(lamportsToSol(1), "0.000000001");
});
