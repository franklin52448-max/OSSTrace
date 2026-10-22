import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOfacLabelSet, parseCsvLine, splitCsvRows, extractAddressesFromRow } from "../ingest-ofac-sdn.ts";

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

// Real addresses from the current SDN list (data/labels/ofac-sdn.json), so the shape checks below
// are exercised against what OFAC actually publishes.
const REAL_ETH = "0x252A8bd2319D8a555B872990601221B3A2053bcE";
const REAL_SOL = "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi";

test("extractAddressesFromRow finds multiple addresses across chains, skipping unsupported ones", () => {
  const row = [
    "1",
    "SOME ENTITY",
    `Digital Currency Address - ETH ${REAL_ETH}; alt. Digital Currency Address - XBT 1abc123; Digital Currency Address - SOL ${REAL_SOL};`,
  ];
  const found = extractAddressesFromRow(row);
  assert.deepEqual(found, [
    { chain: "ethereum", address: REAL_ETH.toLowerCase() },
    { chain: "solana", address: REAL_SOL },
  ]);
});

test("extractAddressesFromRow drops a token that isn't a well-formed address for its chain", () => {
  // Before: "0xAAA" was ingested as a sanctioned Ethereum address, and so was a real address with
  // the next word glued on (the shape the UK list's free text has shown) — labels on addresses
  // that don't exist, which no lookup will ever find.
  const row = [
    "1",
    "SOME ENTITY",
    `Digital Currency Address - ETH 0xAAA; Digital Currency Address - ETH ${REAL_ETH}Byex; ` +
      `Digital Currency Address - SOL 9wQdef456; Digital Currency Address - SOL ${REAL_SOL}0OIl;`,
  ];
  assert.deepEqual(extractAddressesFromRow(row), []);
});

test("buildOfacLabelSet keeps one label per address, joining the names when two SDN entries list it", () => {
  const rows = [
    `1,"FIRST ENTITY",-0- ,"Digital Currency Address - ETH ${REAL_ETH};"`,
    `2,"SECOND ENTITY",-0- ,"Digital Currency Address - ETH ${REAL_ETH.toLowerCase()}; Digital Currency Address - SOL ${REAL_SOL};"`,
    `3,"-0-",-0- ,"Digital Currency Address - ETH 0x1cab8177ace78b1b6b1c393371f4f2dcae40cbeb;"`,
  ];
  const { labels, tags } = buildOfacLabelSet(rows, "2026-10-22");
  // Before, the same address got two labels; the store only ever returns the first, so the second
  // designation's name silently never appeared anywhere.
  assert.deepEqual(
    labels.map((l) => [l.address.chain, l.address.value, l.name]),
    [
      ["ethereum", REAL_ETH.toLowerCase(), "FIRST ENTITY / SECOND ENTITY"],
      ["solana", REAL_SOL, "SECOND ENTITY"],
    ],
  );
  assert.deepEqual(
    tags.map((t) => [t.address.value, t.tag]),
    [
      [REAL_ETH.toLowerCase(), "sanctioned"],
      [REAL_SOL, "sanctioned"],
    ],
  );
  for (const entry of [...labels, ...tags]) {
    assert.equal(entry.source.url, "https://sanctionssearch.ofac.treas.gov/");
    assert.equal(entry.source.addedAt, "2026-10-22");
  }
});

test("extractAddressesFromRow returns nothing for remarks with no digital currency addresses", () => {
  const row = ["1", "SOME ENTITY", "Additional Sanctions Information - Subject to Secondary Sanctions"];
  assert.deepEqual(extractAddressesFromRow(row), []);
});

test("extractAddressesFromRow preserves Solana address case (base58 is case-sensitive)", () => {
  const row = ["1", "SOME ENTITY", `Digital Currency Address - SOL ${REAL_SOL};`];
  const found = extractAddressesFromRow(row);
  assert.equal(found[0]?.address, REAL_SOL);
});
