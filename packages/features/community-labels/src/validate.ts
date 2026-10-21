import { canonicalAddress, isChainId, isRealAddress, SUPPORTED_CHAINS, type Address, type Confidence } from "@osstrace/core";

export const NAME_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 500;
export const URL_MAX_LENGTH = 2048;
export const REASON_MAX_LENGTH = 500;

/** A submission's fields after validation — everything except who/when, which the server sets. */
export interface SubmissionInput {
  address: Address;
  name: string;
  confidence: Confidence;
  source: { url: string; description: string };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function text(value: unknown, field: string, max: number): Parsed<string> {
  if (typeof value !== "string") return { ok: false, message: `${field} is required` };
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return { ok: false, message: `${field} is required` };
  if ([...trimmed].length > max) return { ok: false, message: `${field} must be at most ${max} characters` };
  return { ok: true, value: trimmed };
}

/**
 * A source URL must be an absolute http(s) URL with a real-looking host. This checks shape only —
 * the server never fetches it (fetching a user-supplied URL from the server is an SSRF hole), so
 * whether it actually supports the claim is exactly what a moderator checks before confirming.
 */
export function parseSourceUrl(value: unknown): Parsed<string> {
  if (typeof value !== "string" || !value.trim()) return { ok: false, message: "source.url is required" };
  const raw = value.trim();
  if (raw.length > URL_MAX_LENGTH) return { ok: false, message: `source.url must be at most ${URL_MAX_LENGTH} characters` };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: "source.url must be an absolute URL (https://…)" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "source.url must be an http or https URL" };
  }
  if (!url.hostname.includes(".") && url.hostname !== "localhost") {
    return { ok: false, message: "source.url must point at a real host" };
  }
  if (url.username || url.password) return { ok: false, message: "source.url must not contain credentials" };
  return { ok: true, value: url.toString() };
}

/**
 * Validates an untrusted submission body. The source is mandatory and can't be blank — ADR 0002
 * applies to community submissions exactly as it does to ingested data.
 */
export function parseSubmissionInput(body: Record<string, unknown>): Parsed<SubmissionInput> {
  const chain = body["chain"];
  if (!isChainId(chain)) return { ok: false, message: `chain must be one of: ${SUPPORTED_CHAINS.join(", ")}` };
  const rawAddress = typeof body["address"] === "string" ? body["address"].trim() : null;
  if (!isRealAddress(chain, rawAddress)) return { ok: false, message: `address is not a valid ${chain} address` };

  const name = text(body["name"], "name", NAME_MAX_LENGTH);
  if (!name.ok) return name;

  const confidence = body["confidence"];
  if (confidence !== "verified" && confidence !== "predicted") {
    return { ok: false, message: 'confidence must be "verified" (the source states it outright) or "predicted" (inferred from the source)' };
  }

  const source = body["source"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return { ok: false, message: "source is required: { url, description } — every label needs a cited source (ADR 0002)" };
  }
  const url = parseSourceUrl((source as Record<string, unknown>)["url"]);
  if (!url.ok) return url;
  const description = text((source as Record<string, unknown>)["description"], "source.description", DESCRIPTION_MAX_LENGTH);
  if (!description.ok) return description;

  return {
    ok: true,
    value: {
      address: { chain, value: canonicalAddress(chain, rawAddress) },
      name: name.value,
      confidence,
      source: { url: url.value, description: description.value },
    },
  };
}

export function parseRejectionReason(value: unknown): Parsed<string> {
  return text(value, "reason", REASON_MAX_LENGTH);
}
