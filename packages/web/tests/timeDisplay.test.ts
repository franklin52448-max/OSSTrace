import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp, UNKNOWN_TIME } from "../src/timeDisplay.ts";

test("a null timestamp is shown as unknown, never as the 1970 epoch new Date(null) would give", () => {
  assert.equal(formatTimestamp(null), UNKNOWN_TIME);
  assert.notEqual(formatTimestamp(null), new Date(0).toLocaleString());
});

test("a real timestamp is shown as that date", () => {
  const iso = "2026-10-21T18:07:37.000Z";
  assert.equal(formatTimestamp(iso), new Date(iso).toLocaleString());
});

test("a string that isn't a date is shown as unknown, not 'Invalid Date'", () => {
  assert.equal(formatTimestamp("not a date"), UNKNOWN_TIME);
});
