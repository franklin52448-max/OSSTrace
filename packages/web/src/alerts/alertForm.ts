import type { AlertLimits, AlertRule, AlertTarget, Chain, CreateAlertRule, Entity, NotificationMethod } from "@osstrace/contract";
import { CHAIN_NAMES, normalizeAddress } from "@osstrace/contract";
import { formatUsd } from "../kit/format.ts";
import { validateAddress } from "../kit/validation.ts";

export const ALERT_NAME_MAX = 80;

export type AlertFormState = {
  name: string;
  enabled: boolean;
  targets: AlertTarget[];
  direction: AlertRule["direction"];
  /** Raw text from the input; "" means no floor. */
  minUsd: string;
  anyToken: boolean;
  /** Token ids: contract address (EVM), mint (Solana) or "native". */
  tokens: string[];
  /** Webhook method ids; in_app is implied and never stored here. */
  methodIds: string[];
};

export type AlertFormErrors = Partial<Record<"name" | "targets" | "minUsd" | "tokens", string>>;

export function emptyAlertForm(prefill?: { chain?: Chain | null; address?: string | null; entityId?: string | null; name?: string; minUsd?: number | null }): AlertFormState {
  const targets: AlertTarget[] = [];
  if (prefill?.chain && prefill.address) targets.push({ type: "address", chain: prefill.chain, address: prefill.address.trim() });
  if (prefill?.entityId) targets.push({ type: "entity", entityId: prefill.entityId });
  return { name: prefill?.name ?? "", enabled: true, targets, direction: "both", minUsd: prefill?.minUsd != null ? String(prefill.minUsd) : "", anyToken: true, tokens: [], methodIds: [] };
}

export function ruleToForm(rule: AlertRule): AlertFormState {
  return {
    name: rule.name,
    enabled: rule.enabled,
    targets: rule.targets.map((t) => ({ ...t })),
    direction: rule.direction,
    minUsd: rule.minUsd == null ? "" : String(rule.minUsd),
    anyToken: rule.tokens == null || rule.tokens.length === 0,
    tokens: rule.tokens ? [...rule.tokens] : [],
    methodIds: [...rule.methodIds],
  };
}

export function targetKey(t: AlertTarget): string {
  return t.type === "entity" ? `entity:${t.entityId}` : `address:${t.chain}:${normalizeAddress(t.chain, t.address)}`;
}

export function dedupeTargets(targets: AlertTarget[]): AlertTarget[] {
  const seen = new Set<string>();
  const out: AlertTarget[] = [];
  for (const t of targets) {
    const k = targetKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function parseMinUsd(raw: string): number | null | "invalid" {
  const v = raw.trim().replace(/,/g, "");
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return n;
}

export function validateAlertForm(form: AlertFormState, limits?: AlertLimits | null): AlertFormErrors {
  const e: AlertFormErrors = {};
  const name = form.name.trim();
  if (!name) e.name = "Give the alert a name.";
  else if (name.length > ALERT_NAME_MAX) e.name = `Name must be at most ${ALERT_NAME_MAX} characters.`;

  const targets = dedupeTargets(form.targets);
  if (targets.length === 0) e.targets = "Add at least one address or entity to watch.";
  else if (limits && targets.length > limits.maxTargetsPerRule) e.targets = `A rule can watch at most ${limits.maxTargetsPerRule} targets.`;
  else {
    const bad = targets.find((t) => t.type === "address" && validateAddress(t.chain, t.address));
    if (bad && bad.type === "address") e.targets = `${bad.address.trim() || "An address"}: ${validateAddress(bad.chain, bad.address)}`;
  }

  if (parseMinUsd(form.minUsd) === "invalid") e.minUsd = "Enter a dollar amount of 0 or more, or leave it empty.";
  if (!form.anyToken && form.tokens.filter((t) => t.trim()).length === 0) e.tokens = "Add at least one token, or choose any token.";
  return e;
}

/** Form → API payload. Assumes validateAlertForm passed. */
export function formToPayload(form: AlertFormState): CreateAlertRule {
  const min = parseMinUsd(form.minUsd);
  const tokens = form.anyToken ? [] : Array.from(new Set(form.tokens.map((t) => t.trim()).filter(Boolean)));
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    targets: dedupeTargets(form.targets).map((t) => (t.type === "entity" ? { type: "entity", entityId: t.entityId } : { type: "address", chain: t.chain, address: t.address.trim() })),
    direction: form.direction,
    minUsd: min === "invalid" ? null : min,
    tokens: tokens.length ? tokens : null,
    methodIds: Array.from(new Set(form.methodIds.filter((id) => id && id !== "in_app"))),
  };
}

const VERB: Record<AlertRule["direction"], string> = { in: "receives", out: "sends", both: "sends or receives" };

type RuleLike = Pick<AlertFormState, "targets" | "direction" | "methodIds"> & { minUsd: string | number | null; tokens: string[] | null; anyToken?: boolean };

/** Plain-language summary of what will fire. */
export function describeRule(rule: RuleLike, entities: Pick<Entity, "id" | "name">[] = [], methods: NotificationMethod[] = []): string {
  const targets = dedupeTargets(rule.targets);
  let subject: string;
  if (targets.length === 0) subject = "a watched target";
  else if (targets.length === 1) {
    const t = targets[0]!;
    subject = t.type === "entity" ? `${entities.find((x) => x.id === t.entityId)?.name ?? "the selected entity"} (any of its addresses)` : `${shortAddr(t.address)} on ${CHAIN_NAMES[t.chain]}`;
  } else subject = `any of ${targets.length} targets`;

  const min = typeof rule.minUsd === "number" ? rule.minUsd : rule.minUsd == null ? null : parseMinUsd(rule.minUsd);
  const amount = typeof min === "number" && min > 0 ? `at least ${formatUsd(min)} of` : "any amount of";
  const tokenList = rule.anyToken === true ? [] : (rule.tokens ?? []).map((t) => t.trim()).filter(Boolean);
  const token = tokenList.length === 0 ? "any token" : tokenList.length === 1 ? tokenTitle(tokenList[0]!) : `${tokenList.length} selected tokens`;

  const names = ["in-app"];
  for (const id of rule.methodIds) {
    const m = methods.find((x) => x.id === id);
    if (m && m.kind !== "in_app") names.push(m.enabled ? m.name : `${m.name} (disabled)`);
  }
  return `Fires when ${subject} ${VERB[rule.direction]} ${amount} ${token}. Notifies: ${names.join(", ")}.`;
}

/** A sensible default name from what's watched and which way, used when the name is left blank. */
export function suggestAlertName(form: Pick<AlertFormState, "targets" | "direction">, entities: Pick<Entity, "id" | "name">[] = []): string {
  const targets = dedupeTargets(form.targets);
  if (targets.length === 0) return "";
  const first = targets[0]!;
  const subject =
    targets.length > 1
      ? `${targets.length} targets`
      : first.type === "entity"
        ? (entities.find((x) => x.id === first.entityId)?.name ?? "entity")
        : shortAddr(first.address);
  const name = form.direction === "in" ? `Inflows to ${subject}` : form.direction === "out" ? `Outflows from ${subject}` : `Activity on ${subject}`;
  return name.slice(0, ALERT_NAME_MAX);
}

function tokenTitle(t: string): string {
  return t === "native" ? "the native coin (ETH or SOL)" : shortAddr(t);
}

function shortAddr(a: string): string {
  const v = a.trim();
  return v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

export function noBackfillNote(pollSec?: number | null): string {
  return `Only transfers after you save (or re-enable) the rule fire; past activity is not replayed.${pollSec ? ` Checked every ${pollSec}s.` : ""}`;
}
