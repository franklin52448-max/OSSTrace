import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine, splitCsvRows, extractAddressesFromRow } from "../ingest-ofac-sdn.ts";

test("parseCsvLine handles quoted fields containing commas", () => {
  const fields = parseCsvLine('4632,"BANK MARKAZI, SOME BANK",-0- ,"remarks text"');
  assert.deepEqual(fields, ["4632", "BANK MARKAZI, SOME BANK", "-0- ", "remarks text"]);
});

test("parseCsvLine handles escaped double-quotes inside a quoted field", () => {
  const fields = parseCsvLine('1,"say ""hi"" ok",3');
  assert.deepEqual(fields, ["1", 'say "hi" ok', "3"]);
});

test("splitCsvRows splits on real newlines but not newlines inside quotes", () => {
  const rows = splitCsvRows('a,"b\nc",d\ne,f,g');
  assert.deepEqual(rows, ['a,"b\nc",d', "e,f,g"]);
});

test("extractAddressesFromRow finds a single ETH address in remarks", () => {
  const row = ["1", "SOME ENTITY", "Digital Currency Address - ETH 0xABCDEF1234567890abcdef1234567890ABCDEF12;"];
  const found = extractAddressesFromRow(row);
  assert.deepEqual(found, [{ chain: "ethereum", address: "0xabcdef1234567890abcdef1234567890abcdef12" }]);
});

test("extractAddressesFromRow finds multiple addresses across chains, skipping unsupported ones", () => {
  const row = [
    "1",
    "SOME ENTITY",
    "Digital Currency Address - ETH 0xAAA; alt. Digital Currency Address - XBT 1abc123; Digital Currency Address - SOL 9wQdef456;",
  ];
  const found = extractAddressesFromRow(row);
  assert.deepEqual(found, [
    { chain: "ethereum", address: "0xaaa" },
    { chain: "solana", address: "9wQdef456" },
  ]);
});

test("extractAddressesFromRow returns nothing for remarks with no digital currency addresses", () => {
  const row = ["1", "SOME ENTITY", "Additional Sanctions Information - Subject to Secondary Sanctions"];
  assert.deepEqual(extractAddressesFromRow(row), []);
});

test("extractAddressesFromRow preserves Solana address case (base58 is case-sensitive)", () => {
  const row = ["1", "SOME ENTITY", "Digital Currency Address - SOL 9wQAbCdEfGhIjKlMnOp;"];
  const found = extractAddressesFromRow(row);
  assert.equal(found[0]?.address, "9wQAbCdEfGhIjKlMnOp");
});
