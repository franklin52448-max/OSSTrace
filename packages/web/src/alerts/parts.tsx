import type { AlertRule, AlertTarget, Chain, Entity } from "@osstrace/contract";
import { Building2 } from "lucide-react";
import { useAddressInfo } from "../kit/address.ts";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { cn } from "../kit/cn.ts";
import { Chip, type ChipTone } from "../kit/Chip.tsx";
import { addressDisplayName, formatUsd, shortAddress } from "../kit/format.ts";

export const DIRECTION_LABEL: Record<AlertRule["direction"], string> = { in: "Incoming", out: "Outgoing", both: "Both directions" };

/** One watched target: entity name (from your entities) or chain + short address linking to the explorer. */
export function TargetLabel({ target, entities, link = true }: { target: AlertTarget; entities?: Pick<Entity, "id" | "name">[]; link?: boolean }) {
  if (target.type === "entity") {
    const name = entities?.find((e) => e.id === target.entityId)?.name;
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Building2 aria-hidden className="size-3.5 shrink-0 text-muted" />
        <span className={cn("truncate", name ? "font-medium" : "text-muted")}>{name ?? "Deleted entity"}</span>
      </span>
    );
  }
  return <AddressTargetLabel chain={target.chain} address={target.address} link={link} />;
}

/** Address target, name first (your entity or label), short hash second. */
function AddressTargetLabel({ chain, address, link }: { chain: Chain; address: string; link: boolean }) {
  const info = useAddressInfo(chain, address);
  const name = info.data ? addressDisplayName(info.data) : null;
  const named = !!name && name !== shortAddress(address);
  const body = (
    <>
      <ChainBadge chain={chain} />
      {named ? <span className="truncate font-medium">{name}</span> : null}
      <span className={cn("kit-mono truncate", named && "hidden text-xs text-faint xl:inline")}>{shortAddress(address, 6, 4)}</span>
    </>
  );
  return link ? (
    <a href={`#address/${chain}/${encodeURIComponent(address)}`} title={address} className="kit-fade inline-flex min-w-0 items-center gap-1.5 hover:text-accent">
      {body}
    </a>
  ) : (
    <span title={address} className="inline-flex min-w-0 items-center gap-1.5">
      {body}
    </span>
  );
}

/** Compact summary for table cells: first target plus "+N more". */
export function TargetsSummary({ targets, entities }: { targets: AlertTarget[]; entities?: Pick<Entity, "id" | "name">[] }) {
  if (targets.length === 0) return <span className="text-muted">No targets</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <TargetLabel target={targets[0]!} entities={entities} link={false} />
      {targets.length > 1 ? <span className="kit-num shrink-0 text-xs text-muted">+{targets.length - 1} more</span> : null}
    </span>
  );
}

/** Direction of a transfer relative to the matched target: in/out ink. */
export function FlowMark({ flow }: { flow: "in" | "out" | "self" }) {
  if (flow === "self") return <span className="text-muted">Self</span>;
  return <span className={flow === "in" ? "text-in" : "text-out"}>{flow === "in" ? "In" : "Out"}</span>;
}

export type ChipSpec = { id: string; k: string; value?: string; tone: ChipTone; kind: "target" | "direction" | "usd" | "tokens" | "chain"; target?: AlertTarget };

/** Chip specs for a rule or a form in progress: targets, direction, USD floor, tokens, networks. */
export function ruleChipSpecs(
  rule: { targets: AlertTarget[]; direction: AlertRule["direction"]; minUsd: number | string | null; tokens: string[] | null; anyToken?: boolean },
  entities?: Pick<Entity, "id" | "name">[],
): ChipSpec[] {
  const out: ChipSpec[] = [];
  for (const t of rule.targets) {
    if (t.type === "entity") out.push({ id: `e:${t.entityId}`, k: "Entity", value: entities?.find((e) => e.id === t.entityId)?.name ?? "deleted", tone: "neutral", kind: "target", target: t });
    else out.push({ id: `a:${t.chain}:${t.address}`, k: t.chain === "ethereum" ? "ETH" : "SOL", value: shortAddress(t.address, 6, 4), tone: "neutral", kind: "target", target: t });
  }
  if (rule.direction !== "both") out.push({ id: "dir", k: rule.direction === "in" ? "Inflow" : "Outflow", tone: rule.direction, kind: "direction" });
  const min = typeof rule.minUsd === "number" ? rule.minUsd : rule.minUsd == null || rule.minUsd.trim() === "" ? null : Number(rule.minUsd.replace(/,/g, ""));
  if (min != null && Number.isFinite(min) && min > 0) out.push({ id: "usd", k: "USD", value: `>= ${formatUsd(min)}`, tone: "accent", kind: "usd" });
  const tokens = rule.anyToken === true ? [] : (rule.tokens ?? []).filter(Boolean);
  if (tokens.length) out.push({ id: "tok", k: "Tokens", value: tokens.length === 1 ? (tokens[0] === "native" ? "native" : shortAddress(tokens[0]!, 6, 4)) : String(tokens.length), tone: "warn", kind: "tokens" });
  return out;
}

/** Read-only chip row for a saved rule. */
export function RuleChips({ rule, entities, max }: { rule: AlertRule; entities?: Pick<Entity, "id" | "name">[]; max?: number }) {
  const specs = ruleChipSpecs(rule, entities);
  const shown = max ? specs.slice(0, max) : specs;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {shown.map((c) => (
        <Chip key={c.id} k={c.k} tone={c.tone}>
          {c.value}
        </Chip>
      ))}
      {max && specs.length > max ? <span className="kit-num text-xs text-muted">+{specs.length - max}</span> : null}
    </span>
  );
}
