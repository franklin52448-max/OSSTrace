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

/** Same SSRF-safe shape check `@osstrace/community-labels` uses for a source URL — never fetched server-side. */
export function parsePrUrl(value: unknown): Parsed<string> {
  if (typeof value !== "string" || !value.trim()) return { ok: false, message: "prUrl is required" };
  const raw = value.trim();
  if (raw.length > PR_URL_MAX_LENGTH) return { ok: false, message: `prUrl must be at most ${PR_URL_MAX_LENGTH} characters` };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: "prUrl must be an absolute URL (https://…)" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, message: "prUrl must be an http or https URL" };
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return { ok: false, message: "prUrl must point at a real host" };
  if (url.username || url.password) return { ok: false, message: "prUrl must not contain credentials" };
  return { ok: true, value: url.toString() };
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
