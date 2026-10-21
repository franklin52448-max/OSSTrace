import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLabelSet, extractAddressesFromText, formatName, parseUkSanctionsCsv, splitEvmRun } from "../ingest-uk-sanctions.ts";

const A = "0x175d44451403Edf28469dF03A9280c1197ADb92c";
const B = "0xE950DC316b836e4EeFb8308bf32Bf7C72a1358FF";

test("extractAddressesFromText reads the 'Digital Currency Address: ETH 0x...' shape, skipping XBT/USDT", () => {
  const text = `Digital Currency Address: XBT 3Lpoy53K625zVeE47ZasiG5jGkAxJ27kh1\t \t Digital Currency Address: ETH ${A}\t Digital Currency Address: USDT 3E6ZCKRrsdPc35chA9Eftp1h3DLW18NFNV`;
  assert.deepEqual(extractAddressesFromText(text), [{ chain: "ethereum", address: A.toLowerCase() }]);
});

test("extractAddressesFromText reads the numbered '(1) ETH: 0x...' shape and never puts a BNB-listed address on Ethereum", () => {
  const text = `wallets: (1) ETH: ${A} (2) BNB:  ${A} (3) USDT:  TGJVc32ig2u8tQsYMLE7KXHT5NDQroaVNU (7) BNB: ${B} (10) BTC: 3Q8H2ZWMtc4R1M3mkmhnTjCoYKTeCFigDP`;
  assert.deepEqual(extractAddressesFromText(text), [{ chain: "ethereum", address: A.toLowerCase() }]);
});

test("extractAddressesFromText applies a sentence-level chain ('the following Ethereum crypto addresses: ...') to every address in the list", () => {
  const text = `Byex is associated with the following Ethereum crypto addresses: ${A} ${B}`;
  assert.deepEqual(extractAddressesFromText(text), [
    { chain: "ethereum", address: A.toLowerCase() },
    { chain: "ethereum", address: B.toLowerCase() },
  ]);
});

test("extractAddressesFromText handles two addresses run together, and an address with the next word glued on (both seen in the real file)", () => {
  const C = "0xAE05eB856CB28c156d9722094F5eEfD5693Bc181";
  const text = `following Ethereum crypto addresses: ${A}${B}${C}Byex is associated with the following Tron crypto addresses:TDpwBeBt6KPz2HJRzNNXy62gT1yU1MFLTS`;
  // A and B are clean 40-hex pieces; the last piece is C + "B" from "Byex" (41 hex digits) and is dropped, not truncated to C.
  assert.deepEqual(extractAddressesFromText(text), [
    { chain: "ethereum", address: A.toLowerCase() },
    { chain: "ethereum", address: B.toLowerCase() },
  ]);
});

test("extractAddressesFromText skips an 0x address when no chain is named", () => {
  assert.deepEqual(extractAddressesFromText(`is associated with the following crypto addresses: ${A}`), []);
});

test("extractAddressesFromText doesn't carry a chain across a sentence break", () => {
  assert.deepEqual(extractAddressesFromText(`Trades on ETH markets. Associated address: ${A}`), []);
});

test("extractAddressesFromText takes Solana addresses only when labelled SOL/Solana, preserving case", () => {
  const sol = "9wQAbCdEfGhJkLmNpQrStUvWxYz123456789AbCd";
  assert.deepEqual(extractAddressesFromText(`Digital Currency Address: SOL ${sol}`), [{ chain: "solana", address: sol }]);
  assert.deepEqual(extractAddressesFromText(`Digital Currency Address: TRX ${sol}`), []);
});

test("splitEvmRun drops a 64-hex transaction hash instead of truncating it into an address", () => {
  assert.deepEqual(splitEvmRun(`0x${"a".repeat(64)}`), []);
  assert.deepEqual(splitEvmRun(`${A}${B}`), [A, B]);
});

test("formatName puts given names before the surname/entity name and collapses whitespace", () => {
  assert.equal(formatName({ "Name 6": "AYASH", "Name 1": "Mustafa" }), "Mustafa AYASH");
  assert.equal(formatName({ "Name 6": "Byex Exchange Company Limited   " }), "Byex Exchange Company Limited");
});

const CSV = [
  "Report Date: 16-Oct-2026",
  "Last Updated,Unique ID,OFSI Group ID,Name 6,Name 1,Name type,Regime Name,Other Information,UK Statement of Reasons",
  `01/01/2026,CTD0004,1,AYASH,Mustafa,Primary Name,Counter-Terrorism,"(1) ETH: ${A} (2) BNB: ${B}",reasons`,
  `01/01/2026,CTD0004,1,AYASH,Mustafa Abu,Alias,Counter-Terrorism,"(1) ETH: ${A} (2) BNB: ${B}",reasons`,
  `01/01/2026,RUS0001,2,"SOME, BANK",,Primary Name,Russia,"No crypto here",reasons`,
].join("\n");

test("parseUkSanctionsCsv groups alias rows by Unique ID, uses the Primary Name, and drops designations with no supported address", () => {
  assert.deepEqual(parseUkSanctionsCsv(CSV), [
    { uniqueId: "CTD0004", name: "Mustafa AYASH", regime: "Counter-Terrorism", addresses: [{ chain: "ethereum", address: A.toLowerCase() }] },
  ]);
});

test("parseUkSanctionsCsv refuses a file whose header it doesn't recognise rather than guessing columns", () => {
  assert.throws(() => parseUkSanctionsCsv("Name,Address\nx,y"), /header row not found/);
});

test("buildLabelSet produces one verified label + one sanctioned tag per address, citing every designation that lists it", () => {
  const out = buildLabelSet(
    [
      { uniqueId: "X1", name: "One", regime: "R", addresses: [{ chain: "ethereum", address: "0xaa" }] },
      { uniqueId: "X2", name: "Two", regime: "R", addresses: [{ chain: "ethereum", address: "0xaa" }] },
    ],
    "2026-10-21",
  );
  assert.equal(out.labels.length, 1);
  assert.equal(out.tags.length, 1);
  assert.equal(out.labels[0]?.name, "One / Two");
  assert.equal(out.labels[0]?.confidence, "verified");
  assert.match(out.labels[0]?.source.description ?? "", /X1, X2/);
  assert.equal(out.tags[0]?.tag, "sanctioned");
  assert.ok(out.labels[0]?.source.url.startsWith("https://"));
});
