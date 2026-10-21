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
 */
export function extractAddressesFromRow(fields: string[]): Array<{ chain: ChainId; address: string }> {
  const remarks = fields[fields.length - 1] ?? "";
  const results: Array<{ chain: ChainId; address: string }> = [];
  for (const match of remarks.matchAll(DIGITAL_CURRENCY_RE)) {
    const code = match[1];
    const address = match[2];
    if (!code || !address) continue;
    const chain = SUPPORTED_CURRENCY_CODES[code];
    if (!chain) continue;
    results.push({ chain, address: chain === "ethereum" ? address.toLowerCase() : address });
  }
  return results;
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

  const addedAt = new Date().toISOString().slice(0, 10);
  const labels: Label[] = [];
  const seenTags = new Set<string>();
  const tags: Tag[] = [];

  for (const row of rows) {
    const fields = parseCsvLine(row);
    const entName = fields[1]?.trim();
    if (!entName || entName === "-0-") continue;

    for (const { chain, address: normalizedAddress } of extractAddressesFromRow(fields)) {
      const source = {
        description: "U.S. Treasury OFAC Specially Designated Nationals (SDN) List — sanctioned digital currency address",
        url: SOURCE_URL,
        addedAt,
      };

      labels.push({
        address: { chain, value: normalizedAddress },
        name: entName,
        confidence: "verified",
        source,
      });

      const tagKey = `${chain}:${normalizedAddress}:sanctioned`;
      if (!seenTags.has(tagKey)) {
        seenTags.add(tagKey);
        tags.push({ address: { chain, value: normalizedAddress }, tag: "sanctioned", source });
      }
    }
  }

  const output = { labels, tags, entities: [] };
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
