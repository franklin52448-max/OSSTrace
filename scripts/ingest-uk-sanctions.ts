/**
 * Pulls the real, current UK Sanctions List (the UK government's single list of sanctions
 * designations, published by the FCDO) and extracts every digital-currency address for a chain
 * this project actually supports, writing data/labels/uk-sanctions-list.json. See
 * data/labels/README.md for the sourcing rules this follows.
 *
 * Why this list and not "the OFSI Consolidated List": OFSI's Consolidated List of Asset Freeze
 * Targets (ConList.csv) closed on 28 January 2026 and is no longer updated — confirmed on
 * https://www.gov.uk/government/publications/the-uk-sanctions-list and
 * https://www.gov.uk/guidance/moving-to-a-single-list-for-uk-sanctions-designations-28-january-2026.
 * Since then the UK Sanctions List is the only source for all UK designations, OFSI asset freezes
 * included. The old ConList.csv URL still serves a frozen copy, which is exactly why this script
 * must not use it.
 *
 * Source confirmed live before writing this script: the CSV link on the gov.uk publication page,
 * https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv (~50MB, first line
 * "Report Date: <date>", second line the column header). Like OFAC's flat file, there is no
 * structured column for crypto addresses — they appear as free text inside "Other Information",
 * in several inconsistent shapes, all seen in the real file:
 *   "Digital Currency Address: ETH 0x7FF9...; Digital Currency Address: USDT 3E6Z..."
 *   "(1) ETH: 0x175d... (2) BNB: 0x175d... (3) USDT: TGJV..."
 *   "Byex is associated with the following Ethereum crypto addresses: 0xD599... 0xAE05...181"
 *     — with two addresses run together with no separator ("...Bc1810xAE05...") in the source.
 *   "Xinbi is associated with the following crypto addresses: TW5t...; TBKp..." — no chain named.
 * So this parser only takes an address when the text itself names a supported chain for it.
 * An 0x address listed under BNB, or under no chain at all, is skipped rather than guessed onto
 * Ethereum: the same 0x format is valid on many EVM chains this project has no adapter for.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ChainId, Label, Source, Tag } from "../packages/core/src/types.ts";
import { parseCsvLine, splitCsvRows } from "./ingest-ofac-sdn.ts";

const UKSL_CSV_URL = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv";
/** The FCDO's public search tool — any entry can be checked there by its UK Sanctions List reference (e.g. RUS1421). */
const SOURCE_URL = "https://search-uk-sanctions-list.service.gov.uk/";
const OUTPUT_PATH = fileURLToPath(new URL("../data/labels/uk-sanctions-list.json", import.meta.url));

/**
 * Words the list uses to say which chain/asset an address belongs to. A supported chain maps to
 * its ChainId; everything else maps to null, meaning "an address after this is for some chain we
 * don't support — skip it". Tickers are matched case-sensitively, names allow a capitalised first
 * letter. Stablecoin tickers (USDT/USDC) map to null: they exist on many chains and the list
 * doesn't say which (same rule as the OFAC script).
 */
const CHAIN_KEYWORDS: Record<string, ChainId | null> = {
  ETH: "ethereum",
  Ethereum: "ethereum",
  ethereum: "ethereum",
  ERC20: "ethereum",
  "ERC-20": "ethereum",
  SOL: "solana",
  Solana: "solana",
  solana: "solana",
  BTC: null,
  XBT: null,
  Bitcoin: null,
  bitcoin: null,
  BNB: null,
  BSC: null,
  BEP20: null,
  "BEP-20": null,
  USDT: null,
  USDC: null,
  TRX: null,
  Tron: null,
  TRON: null,
  TRC20: null,
  "TRC-20": null,
  LTC: null,
  XMR: null,
  Monero: null,
  DASH: null,
  ZEC: null,
  XRP: null,
  BCH: null,
  ETC: null,
  MATIC: null,
  Polygon: null,
  ARB: null,
  Arbitrum: null,
};

const KEYWORD_ALTERNATION = Object.keys(CHAIN_KEYWORDS)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[-]/g, "\\-"))
  .join("|");

/**
 * One left-to-right scan over: a chain keyword, a run of 0x-hex (possibly several addresses
 * glued together), a base58 run (Solana-shaped), or a sentence break (resets the chain context).
 */
const TOKEN_RE = new RegExp(
  `(?<keyword>\\b(?:${KEYWORD_ALTERNATION})\\b)|(?<evm>0x[0-9a-fA-Fx]+)|(?<base58>\\b[1-9A-HJ-NP-Za-km-z]{32,44}\\b)|(?<stop>\\.\\s)`,
  "g",
);

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Splits a run like "0xAAA...(40 hex)0xBBB...(40 hex)" — two addresses the source text ran
 * together — into its addresses. "x" is never a hex digit, so every "0x" inside a run is a real
 * boundary. Any piece that isn't exactly 40 hex digits is dropped on its own (a 64-hex transaction
 * hash, or an address with the next word glued onto it, e.g. "...Bc181Byex" in the real file,
 * where "B" is a valid hex digit) — never truncated into an address the list didn't name.
 */
export function splitEvmRun(run: string): string[] {
  return run.split(/(?=0x)/).filter((p) => EVM_ADDRESS_RE.test(p));
}

/**
 * Pure: given one designation's free text, returns every address the text explicitly ties to a
 * supported chain, in order, deduplicated (Ethereum addresses lower-cased, matching how the
 * explorer looks them up; Solana's case-sensitive base58 left as-is).
 */
export function extractAddressesFromText(text: string): Array<{ chain: ChainId; address: string }> {
  const results: Array<{ chain: ChainId; address: string }> = [];
  const seen = new Set<string>();
  let context: ChainId | null = null;
  const push = (chain: ChainId, address: string): void => {
    const key = `${chain}:${address}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ chain, address });
  };

  for (const match of text.matchAll(TOKEN_RE)) {
    const groups = match.groups ?? {};
    if (groups["keyword"] !== undefined) {
      context = CHAIN_KEYWORDS[groups["keyword"]] ?? null;
    } else if (groups["stop"] !== undefined) {
      context = null;
    } else if (groups["evm"] !== undefined) {
      if (context !== "ethereum") continue;
      for (const address of splitEvmRun(groups["evm"])) push("ethereum", address.toLowerCase());
    } else if (groups["base58"] !== undefined) {
      if (context !== "solana" || !SOLANA_ADDRESS_RE.test(groups["base58"])) continue;
      push("solana", groups["base58"]);
    }
  }
  return results;
}

/** "Name 1".."Name 5" are given/other names, "Name 6" the surname or the entity's full name. */
export function formatName(row: Record<string, string>): string {
  const parts = ["Name 1", "Name 2", "Name 3", "Name 4", "Name 5", "Name 6"].map((k) => (row[k] ?? "").trim());
  return parts.filter((p) => p.length > 0).join(" ").replace(/\s+/g, " ");
}

export interface Designation {
  uniqueId: string;
  name: string;
  regime: string;
  addresses: Array<{ chain: ChainId; address: string }>;
}

/**
 * Pure: turns the raw CSV text into one Designation per UK Sanctions List reference that names at
 * least one supported-chain address. The file has one row per name variant (aliases repeat the
 * designation's other columns), so rows are grouped by "Unique ID" and the "Primary Name" row
 * provides the name.
 */
export function parseUkSanctionsCsv(csvText: string): Designation[] {
  const rows = splitCsvRows(csvText.replace(/^﻿/, ""));
  const headerIndex = rows.findIndex((r) => r.startsWith("Last Updated,Unique ID,"));
  if (headerIndex === -1) throw new Error("UK Sanctions List CSV: header row not found — the format has changed, re-inspect the real file");
  const header = parseCsvLine(rows[headerIndex] ?? "");

  const byId = new Map<string, { name: string | null; fallbackName: string; regime: string; addresses: Map<string, { chain: ChainId; address: string }> }>();
  for (const line of rows.slice(headerIndex + 1)) {
    if (line.trim().length === 0) continue;
    const fields = parseCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((col, i) => {
      row[col] = fields[i] ?? "";
    });
    const uniqueId = row["Unique ID"]?.trim();
    if (!uniqueId) continue;

    let entry = byId.get(uniqueId);
    if (!entry) {
      entry = { name: null, fallbackName: formatName(row), regime: (row["Regime Name"] ?? "").trim(), addresses: new Map() };
      byId.set(uniqueId, entry);
    }
    if (entry.name === null && row["Name type"]?.trim() === "Primary Name") entry.name = formatName(row);

    const text = [row["Other Information"] ?? "", row["UK Statement of Reasons"] ?? ""].join(" ");
    for (const found of extractAddressesFromText(text)) entry.addresses.set(`${found.chain}:${found.address}`, found);
  }

  const designations: Designation[] = [];
  for (const [uniqueId, entry] of byId) {
    if (entry.addresses.size === 0) continue;
    designations.push({ uniqueId, name: entry.name ?? entry.fallbackName, regime: entry.regime, addresses: [...entry.addresses.values()] });
  }
  return designations;
}

/**
 * Pure: builds the Label/Tag output. One Label per address (the store holds at most one); if the
 * list ties the same address to more than one designation, the names are joined and every
 * reference is cited, rather than silently keeping only one.
 */
export function buildLabelSet(designations: Designation[], addedAt: string): { labels: Label[]; tags: Tag[]; entities: [] } {
  const byAddress = new Map<string, { chain: ChainId; address: string; names: string[]; refs: string[]; regimes: string[] }>();
  for (const d of designations) {
    for (const { chain, address } of d.addresses) {
      const key = `${chain}:${address}`;
      const entry = byAddress.get(key) ?? { chain, address, names: [], refs: [], regimes: [] };
      if (!entry.names.includes(d.name)) entry.names.push(d.name);
      entry.refs.push(d.uniqueId);
      if (d.regime && !entry.regimes.includes(d.regime)) entry.regimes.push(d.regime);
      byAddress.set(key, entry);
    }
  }

  const labels: Label[] = [];
  const tags: Tag[] = [];
  for (const entry of byAddress.values()) {
    const source: Source = {
      description: `UK Sanctions List (FCDO) — sanctioned digital currency address, designation ${entry.refs.join(", ")}${entry.regimes.length ? ` under ${entry.regimes.join("; ")}` : ""}`,
      url: SOURCE_URL,
      addedAt,
    };
    const address = { chain: entry.chain, value: entry.address };
    labels.push({ address, name: entry.names.join(" / "), confidence: "verified", source });
    tags.push({ address, tag: "sanctioned", source });
  }
  return { labels, tags, entities: [] };
}

async function main(): Promise<void> {
  console.log(`Fetching ${UKSL_CSV_URL} ...`);
  const response = await fetch(UKSL_CSV_URL, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch UK Sanctions List: HTTP ${response.status}`);
  }
  const csvText = await response.text();
  const reportDate = csvText.slice(0, 200).match(/^Report Date:\s*([^\r\n,]+)/)?.[1] ?? "unknown";
  console.log(`Downloaded ${csvText.length} bytes (list report date: ${reportDate}).`);

  const designations = parseUkSanctionsCsv(csvText);
  const addedAt = new Date().toISOString().slice(0, 10);
  const output = buildLabelSet(designations, addedAt);

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${output.labels.length} labels from ${designations.length} designations to ${OUTPUT_PATH}`);
  for (const d of designations) console.log(`  ${d.uniqueId} ${d.name}: ${d.addresses.map((a) => `${a.chain}:${a.address}`).join(", ")}`);
}

// Only run when executed directly (`npm run ingest:uk`) — not when imported for its pure
// functions by scripts/tests/ingest-uk-sanctions.test.ts, which must not hit the network.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
