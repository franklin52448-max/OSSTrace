import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUnits } from "../src/units.ts";

test("formatUnits renders whole numbers with no decimal point", () => {
  assert.equal(formatUnits(1_000_000_000_000_000_000n, 18), "1");
});

test("formatUnits renders fractional amounts, trimming trailing zeros", () => {
  assert.equal(formatUnits(1_500_000_000_000_000_000n, 18), "1.5");
});

test("formatUnits handles zero", () => {
  assert.equal(formatUnits(0n, 18), "0");
});

test("formatUnits handles amounts smaller than one whole unit", () => {
  assert.equal(formatUnits(1n, 18), "0.000000000000000001");
});

test("formatUnits handles negative amounts", () => {
  assert.equal(formatUnits(-2_500_000_000_000_000_000n, 18), "-2.5");
});
