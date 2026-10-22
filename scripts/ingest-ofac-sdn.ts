/**
 * Pulls the real, current U.S. Treasury OFAC Specially Designated Nationals (SDN) list and
 * extracts every digital-currency address for a chain this project actually supports, writing
 * data/labels/ofac-sdn.json. See data/labels/README.md for the sourcing rules this follows.
 *
 * Source confirmed live before writing this script: https://www.treasury.gov/ofac/downloads/sdn.csv
 * redirects to OFAC's own S3-hosted current publication. Digital currency addresses aren't a
 * structured CSV column in this flat-file format — OFAC embeds them as semi-structured text in
 * the free-text Remarks column, e.g. "Digital Currency Address - ETH 0xabc...; alt. Digital
 * Currency Address - ETH 0xdef...;" — confirmed by downloading and inspecting the real file,
 * not assumed from documentation.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ChainId, Label, Tag } from "../packages/core/src/types.ts";
import { canonicalAddress, isRealAddress } from "../packages/core/src/addressFormat.ts";

const SDN_CSV_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";
const SOURCE_URL = "https://sanctionssearch.ofac.treas.gov/";
const OUTPUT_PATH = fileURLToPath(new URL("../data/labels/ofac-sdn.json", import.meta.url));

/** Only currency codes this project has a ChainAdapter for. Extend as chains are added. */
const SUPPORTED_CURRENCY_CODES: Record<string, ChainId> = {
  ETH: "ethereum",
  SOL: "solana",
};

/** Minimal quoted-field-aware CSV line splitter — correct for this file's actual format, not a general-purpose CSV library. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** Splits the raw CSV text into logical rows, respecting quoted newlines (OFAC's remarks field can contain none here, but some SDN rows do in general). */
export function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') inQuotes = !inQuotes;
    if (char === "\n" && !inQuotes) {
      rows.push(current);
      current = "";
    } else if (char !== "\r") {
      current += char;
    }
  }
  if (current.trim().length > 0) rows.push(current);
  return rows;
}

const DIGITAL_CURRENCY_RE = /Digital Currency Address - ([A-Z]+)\s+([A-Za-z0-9]+)/g;

/**
 * Pure: given one already-split SDN CSV row, returns every digital-currency address it names
 * for a supported chain, as [chain, address] pairs (address case-normalized for Ethereum).
 * Separated out from `main` so it's unit-testable without a network call.
 *
 * An address is only taken if it has the real shape of an address on its chain (0x + 40 hex for
 * Ethereum, 32–44 base58 characters for Solana). The UK list's free text has been seen gluing a
 * word onto an address (`...Bc181Byex`) and running two together; OFAC's Remarks is free text too.
 * A malformed token is dropped, never ingested as a "sanctioned address" nobody can look up.
 */
export function extractAddressesFromRow(fields: string[]): Array<{ chain: ChainId; address: string }> {
  const remarks = fields[fields.length - 1] ?? "";
  const results: Array<{ chain: ChainId; address: string }> = [];
  for (const match of remarks.matchAll(DIGITAL_CURRENCY_RE)) {
    const code = match[1];
    const address = match[2];
    if (!code || !address) continue;
    const chain = SUPPORTED_CURRENCY_CODES[code];
    if (!chain || !isRealAddress(chain, address)) continue;
    results.push({ chain, address: canonicalAddress(chain, address) });
  }
  return results;
}

/**
 * Pure: turns the split SDN rows into the label dataset. **One Label per address** — the label
 * store holds at most one, and returns the first match — so when OFAC lists the same address under
 * more than one SDN entry, their names are joined rather than one silently shadowing the other.
 * One `sanctioned` tag per address.
 */
export function buildOfacLabelSet(rows: readonly string[], addedAt: string): { labels: Label[]; tags: Tag[]; entities: [] } {
  const source = {
    description: "U.S. Treasury OFAC Specially Designated Nationals (SDN) List — sanctioned digital currency address",
    url: SOURCE_URL,
    addedAt,
  };
  const byAddress = new Map<string, { chain: ChainId; address: string; names: string[] }>();
  for (const row of rows) {
    const fields = parseCsvLine(row);
    const entName = fields[1]?.trim();
    if (!entName || entName === "-0-") continue;
    for (const { chain, address } of extractAddressesFromRow(fields)) {
      const key = `${chain}:${address}`;
      const entry = byAddress.get(key) ?? { chain, address, names: [] };
      if (!entry.names.includes(entName)) entry.names.push(entName);
      byAddress.set(key, entry);
    }
  }

  const labels: Label[] = [];
  const tags: Tag[] = [];
  for (const { chain, address, names } of byAddress.values()) {
    labels.push({ address: { chain, value: address }, name: names.join(" / "), confidence: "verified", source });
    tags.push({ address: { chain, value: address }, tag: "sanctioned", source });
  }
  return { labels, tags, entities: [] };
}

async function main(): Promise<void> {
  console.log(`Fetching ${SDN_CSV_URL} ...`);
  const response = await fetch(SDN_CSV_URL, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch SDN list: HTTP ${response.status}`);
  }
  const csvText = await response.text();
  const rows = splitCsvRows(csvText);
  console.log(`Downloaded ${rows.length} SDN rows.`);

  const output = buildOfacLabelSet(rows, new Date().toISOString().slice(0, 10));
  const { labels, tags } = output;
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${labels.length} labels (${tags.length} unique sanctioned addresses) to ${OUTPUT_PATH}`);
  const byChain = labels.reduce<Record<string, number>>((acc, l) => {
    acc[l.address.chain] = (acc[l.address.chain] ?? 0) + 1;
    return acc;
  }, {});
  console.log("By chain:", byChain);
}

// Only run when executed directly (`npm run ingest:ofac`) — not when imported for its pure
// functions, e.g. by scripts/tests/ingest-ofac-sdn.test.ts, which must not trigger a real
// network fetch and file write as a side effect of importing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
