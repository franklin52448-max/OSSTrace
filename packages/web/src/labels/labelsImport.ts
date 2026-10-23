import type { Chain } from "@osstrace/contract";
import { CHAINS, isChain, normalizeAddress } from "@osstrace/contract";
import { validateAddress } from "../kit/validation.ts";

export type ImportFormat = "csv" | "json";
export type ImportRow = {
  /** Row number as the server reports it in ImportResult.skipped: CSV line (header = 1), JSON array index + 1. */
  row: number;
  chain: string;
  address: string;
  name: string;
  note: string;
  entity: string;
  tags: string[];
  errors: string[];
};
export type ImportPreview = { format: ImportFormat; rows: ImportRow[]; fatal?: string };

export const IMPORT_COLUMNS = ["chain", "address", "name", "note", "entity", "tags"] as const;
const REQUIRED = ["chain", "address", "name"] as const;
export const NAME_MAX = 120;

/** Detects JSON by its first non-space character; everything else is treated as CSV. */
export function detectFormat(text: string): ImportFormat {
  const c = text.trimStart()[0];
  return c === "[" || c === "{" ? "json" : "csv";
}

/** RFC 4180 CSV: quoted fields, "" escapes, CRLF/LF, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

const splitTags = (v: unknown): string[] => {
  const parts = Array.isArray(v) ? v.map((x) => String(x)) : typeof v === "string" ? v.split(";") : [];
  return [...new Set(parts.map((t) => t.trim()).filter(Boolean))];
};
const str = (v: unknown) => (v == null ? "" : String(v)).trim();

function validateRows(rows: Omit<ImportRow, "errors">[]): ImportRow[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const errors: string[] = [];
    const chain = r.chain.toLowerCase();
    if (!isChain(chain)) {
      errors.push(r.chain ? `Unknown chain "${r.chain}" (use ${CHAINS.join(", ")}).` : "Chain is missing.");
    } else {
      const addrErr = validateAddress(chain as Chain, r.address);
      if (addrErr) errors.push(addrErr);
      else {
        const key = `${chain}:${normalizeAddress(chain as Chain, r.address)}`;
        const first = seen.get(key);
        if (first !== undefined) errors.push(`Duplicate of row ${first} in this file.`);
        else seen.set(key, r.row);
      }
    }
    if (!r.name) errors.push("Name is missing.");
    else if (r.name.length > NAME_MAX) errors.push(`Name is longer than ${NAME_MAX} characters.`);
    return { ...r, chain, errors };
  });
}

/** Parses pasted/uploaded label data into preview rows with per-row validation. Never throws. */
export function parseLabelsImport(text: string, format?: ImportFormat): ImportPreview {
  const fmt = format ?? detectFormat(text);
  if (!text.trim()) return { format: fmt, rows: [], fatal: "Nothing to import yet." };
  if (fmt === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { format: fmt, rows: [], fatal: `Not valid JSON: ${(e as Error).message}` };
    }
    if (data && !Array.isArray(data) && typeof data === "object" && Array.isArray((data as { labels?: unknown }).labels)) {
      data = (data as { labels: unknown[] }).labels;
    }
    if (!Array.isArray(data)) return { format: fmt, rows: [], fatal: "JSON must be an array of label objects." };
    const rows = data.map((o, idx) => {
      const rec = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
      const lower: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) lower[k.toLowerCase()] = v;
      return {
        row: idx + 1,
        chain: str(lower.chain),
        address: str(lower.address),
        name: str(lower.name),
        note: str(lower.note),
        entity: str(lower.entity),
        tags: splitTags(lower.tags),
      };
    });
    return { format: fmt, rows: validateRows(rows) };
  }
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    return { format: fmt, rows: [], fatal: `The first row must be a header with columns ${IMPORT_COLUMNS.join(",")}. Missing: ${missing.join(", ")}.` };
  }
  const col = (r: string[], name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? str(r[i]) : "";
  };
  const rows = table.slice(1).map((r, idx) => ({
    row: idx + 2, // CSV rows are numbered like the server: the header is row 1
    chain: col(r, "chain"),
    address: col(r, "address"),
    name: col(r, "name"),
    note: col(r, "note"),
    entity: col(r, "entity"),
    tags: splitTags(col(r, "tags")),
  }));
  return { format: fmt, rows: validateRows(rows) };
}
