import { test } from "node:test";
import assert from "node:assert/strict";
import { lamportsToSol } from "../src/units.ts";

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
