import { canonicalAddress, isChainId, isRealAddress, SUPPORTED_CHAINS, type ChainId } from "@osstrace/core";

export const TITLE_MAX_LENGTH = 140;
export const DESCRIPTION_MAX_LENGTH = 8000;
export const NOTE_MAX_LENGTH = 2000;

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Control characters other than newline and tab. A multi-line field may keep line breaks; nothing else. */
// \p{Cc} (U+0000–001F, U+007F–009F) minus \t (U+0009) and \n (U+000A).
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;
const ANY_CONTROL = /\p{Cc}/u;

const length = (s: string): number => [...s].length;

/** One line: whitespace runs collapse to a single space. 1..max code points. */
function singleLine(value: unknown, field: string, max: number): Parsed<string> {
  if (typeof value !== "string") return { ok: false, message: `${field} is required` };
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return { ok: false, message: `${field} is required` };
  if (length(collapsed) > max) return { ok: false, message: `${field} must be at most ${max} characters` };
  if (ANY_CONTROL.test(collapsed)) return { ok: false, message: `${field} must be a single line of plain text` };
  return { ok: true, value: collapsed };
}

/** Free text that may be empty and may span lines. `undefined`/`null` mean empty. 0..max code points. */
function multiLine(value: unknown, field: string, max: number): Parsed<string> {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, message: `${field} must be a string` };
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (length(normalized) > max) return { ok: false, message: `${field} must be at most ${max} characters` };
  if (CONTROL_EXCEPT_NEWLINE_TAB.test(normalized)) return { ok: false, message: `${field} must be plain text (no control characters)` };
  return { ok: true, value: normalized };
}

export interface CaseInput {
  title: string;
  description: string;
}

/** A new case: `title` required, `description` optional. Unknown fields (an `ownedBy`, a `status`) are ignored. */
export function parseCaseInput(body: Record<string, unknown>): Parsed<CaseInput> {
  const title = singleLine(body["title"], "title", TITLE_MAX_LENGTH);
  if (!title.ok) return title;
  const description = multiLine(body["description"], "description", DESCRIPTION_MAX_LENGTH);
  if (!description.ok) return description;
  return { ok: true, value: { title: title.value, description: description.value } };
}

export interface CaseDetailsPatch {
  title?: string;
  description?: string;
}

/** An edit: at least one of `title` / `description`, each validated exactly as on create. */
export function parseCaseDetailsPatch(body: Record<string, unknown>): Parsed<CaseDetailsPatch> {
  const patch: CaseDetailsPatch = {};
  if (body["title"] !== undefined) {
    const title = singleLine(body["title"], "title", TITLE_MAX_LENGTH);
    if (!title.ok) return title;
    patch.title = title.value;
  }
  if (body["description"] !== undefined) {
    const description = multiLine(body["description"], "description", DESCRIPTION_MAX_LENGTH);
    if (!description.ok) return description;
    patch.description = description.value;
  }
  if (patch.title === undefined && patch.description === undefined) {
    return { ok: false, message: "nothing to change: send title and/or description" };
  }
  return { ok: true, value: patch };
}

export function parseNote(value: unknown): Parsed<string> {
  return multiLine(value, "note", NOTE_MAX_LENGTH);
}

export type ParsedAddress =
  | { ok: true; chain: ChainId; address: string }
  | { ok: false; error: "invalid_chain" | "invalid_address"; message: string };

/**
 * The same shape checks community-labels and Tracer use (`isRealAddress` + `canonicalAddress` from
 * `@osstrace/core`), so a case can only hold an address that is well-formed for its chain, stored
 * in the one form every other feature looks it up by. The raw input is trimmed first (a pasted
 * address often carries a trailing space); it is never echoed back in the error message.
 */
export function parseChainAddress(chain: unknown, address: unknown): ParsedAddress {
  if (!isChainId(chain)) {
    return { ok: false, error: "invalid_chain", message: `chain must be one of: ${SUPPORTED_CHAINS.join(", ")}` };
  }
  const trimmed = typeof address === "string" ? address.trim() : null;
  if (!isRealAddress(chain, trimmed)) return { ok: false, error: "invalid_address", message: `not a valid ${chain} address` };
  return { ok: true, chain, address: canonicalAddress(chain, trimmed) };
}
