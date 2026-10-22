import { parsePublicUrl } from "@osstrace/core";

export const TITLE_MAX_LENGTH = 140;
export const DESCRIPTION_MAX_LENGTH = 8000;
export const REWARD_MAX_LENGTH = 200;
export const PR_URL_MAX_LENGTH = 2048;
export const NOTE_MAX_LENGTH = 1000;
export const CANCELLATION_REASON_MAX_LENGTH = 500;

export interface BountyInput {
  title: string;
  description: string;
  reward: string;
}

export interface SubmissionInput {
  prUrl: string;
  note: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function text(value: unknown, field: string, max: number, min = 1): Parsed<string> {
  if (typeof value !== "string") return { ok: false, message: `${field} is required` };
  const trimmed = value.trim().replace(/\s+/g, " ");
  if ([...trimmed].length < min) return { ok: false, message: `${field} is required` };
  if ([...trimmed].length > max) return { ok: false, message: `${field} must be at most ${max} characters` };
  return { ok: true, value: trimmed };
}

/**
 * The shared "is this host checkable by anyone but the submitter" check in `@osstrace/core`'s
 * `urlSafety.ts` — the same one `@osstrace/community-labels` uses for a source URL. Never fetched
 * server-side. A `prUrl` pointing at `localhost` or a private IP would resolve, for whoever
 * actually opens it (a moderator deciding whether to claim the bounty), into *their own* machine
 * or network — not the submitter's — so it gets the same real-public-host check a source URL does.
 */
export function parsePrUrl(value: unknown): Parsed<string> {
  return parsePublicUrl(value, "prUrl", PR_URL_MAX_LENGTH);
}

/**
 * The spec (title + description) and the poster's own reward claim. `reward` is deliberately
 * free text — never parsed as a currency amount or checked against a real asset. See ADR 0009.
 */
export function parseBountyInput(body: Record<string, unknown>): Parsed<BountyInput> {
  const title = text(body["title"], "title", TITLE_MAX_LENGTH);
  if (!title.ok) return title;
  // "in depth" per the feature's own premise — a real minimum so a one-line bounty can't pass as a spec.
  const description = text(body["description"], "description", DESCRIPTION_MAX_LENGTH, 40);
  if (!description.ok) return description;
  const reward = text(body["reward"], "reward", REWARD_MAX_LENGTH);
  if (!reward.ok) return reward;
  return { ok: true, value: { title: title.value, description: description.value, reward: reward.value } };
}

export function parseSubmissionInput(body: Record<string, unknown>): Parsed<SubmissionInput> {
  const prUrl = parsePrUrl(body["prUrl"]);
  if (!prUrl.ok) return prUrl;
  const rawNote = body["note"];
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") {
    return { ok: false, message: "note must be a string" };
  }
  const note = typeof rawNote === "string" ? rawNote.trim().replace(/\s+/g, " ") : "";
  if ([...note].length > NOTE_MAX_LENGTH) return { ok: false, message: `note must be at most ${NOTE_MAX_LENGTH} characters` };
  return { ok: true, value: { prUrl: prUrl.value, note } };
}

export function parseCancellationReason(value: unknown): Parsed<string> {
  return text(value, "reason", CANCELLATION_REASON_MAX_LENGTH);
}

export interface DepositInput {
  chain: "ethereum" | "solana";
  /** A real signature (Solana) or transaction hash (Ethereum) — shape-checked only here; the real check is the chain itself (ADR 0020). */
  txRef: string;
}

/** Max real-world length of either: a base58 Solana signature is at most 88 chars; an Ethereum tx hash is always exactly 66 ("0x" + 64 hex). */
export const TX_REF_MAX_LENGTH = 128;

export function parseDepositInput(body: Record<string, unknown>): Parsed<DepositInput> {
  const chain = body["chain"];
  if (chain !== "ethereum" && chain !== "solana") return { ok: false, message: 'chain must be "ethereum" or "solana"' };
  const txRef = text(body["txRef"], "txRef", TX_REF_MAX_LENGTH);
  if (!txRef.ok) return txRef;
  return { ok: true, value: { chain, txRef: txRef.value } };
}
