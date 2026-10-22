import type { AlertTarget, Chain, Entity } from "@osstrace/contract";
import { detectChain } from "@osstrace/contract";
import { Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { dedupeTargets, targetKey } from "./alertForm.ts";
import { CHAIN_NAMES, validateAddress } from "../kit/validation.ts";
import { Button, IconButton } from "../kit/Button.tsx";
import { Input, Select } from "../kit/Field.tsx";
import { TargetLabel } from "./parts.tsx";

/** Add addresses (chain-validated, chain auto-detected on paste) or your entities; list with remove. */
export function TargetsEditor({
  targets,
  onChange,
  entities,
  max,
  defaultChain,
  error,
  describedBy,
}: {
  targets: AlertTarget[];
  onChange: (t: AlertTarget[]) => void;
  entities: Entity[];
  max?: number;
  defaultChain: Chain;
  error?: string;
  describedBy?: string;
}) {
  const [chain, setChain] = useState<Chain>(defaultChain);
  const [address, setAddress] = useState("");
  const [addrError, setAddrError] = useState<string | null>(null);
  const [entityId, setEntityId] = useState("");
  const full = max != null && targets.length >= max;

  const add = (t: AlertTarget): boolean => {
    if (full) return false;
    const next = dedupeTargets([...targets, t]);
    if (next.length === targets.length) {
      setAddrError("Already in the list.");
      return false;
    }
    onChange(next);
    return true;
  };

  const addAddress = (e?: FormEvent) => {
    e?.preventDefault();
    const v = address.trim();
    const err = validateAddress(chain, v);
    if (err) {
      setAddrError(err);
      return;
    }
    if (add({ type: "address", chain, address: v })) {
      setAddress("");
      setAddrError(null);
    }
  };

  const available = entities.filter((en) => !targets.some((t) => t.type === "entity" && t.entityId === en.id));

  return (
    <div className="flex flex-col gap-3" aria-describedby={describedBy}>
      {targets.length > 0 ? (
        <ul aria-label="Watched targets" className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-2">
          {targets.map((t) => (
            <li key={targetKey(t)} className="flex h-9 items-center gap-2 px-2.5 text-[13px]">
              <TargetLabel target={t} entities={entities} link={false} />
              {t.type === "address" ? <span className="kit-mono hidden truncate text-xs text-faint lg:inline">{t.address}</span> : null}
              <IconButton size="sm" className="ml-auto" label="Remove target" onClick={() => onChange(targets.filter((x) => targetKey(x) !== targetKey(t)))}>
                <X aria-hidden className="size-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-start gap-2">
        <Select aria-label="Chain" className="w-32" value={chain} onChange={(e) => setChain(e.target.value as Chain)} disabled={full}>
          {(Object.keys(CHAIN_NAMES) as Chain[]).map((c) => (
            <option key={c} value={c}>
              {CHAIN_NAMES[c]}
            </option>
          ))}
        </Select>
        <div className="min-w-56 flex-1">
          <Input
            aria-label="Address to watch"
            aria-invalid={addrError ? true : undefined}
            placeholder={chain === "ethereum" ? "0x…" : "Solana address"}
            spellCheck={false}
            autoComplete="off"
            value={address}
            disabled={full}
            onChange={(e) => {
              const v = e.target.value;
              setAddress(v);
              setAddrError(null);
              const detected = detectChain(v);
              if (detected) setChain(detected);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") addAddress(e);
            }}
            className="kit-mono"
          />
          {addrError ? <p className="mt-1 text-xs text-danger">{addrError}</p> : null}
        </div>
        <Button onClick={() => addAddress()} disabled={full || !address.trim()} icon={<Plus aria-hidden className="size-3.5" />}>
          Add address
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Entity to watch" className="min-w-56 flex-1" value={entityId} onChange={(e) => setEntityId(e.target.value)} disabled={full || available.length === 0}>
          <option value="">{entities.length === 0 ? "No entities yet (create them under Labels)" : available.length === 0 ? "All your entities are added" : "Choose one of your entities"}</option>
          {available.map((en) => (
            <option key={en.id} value={en.id}>
              {en.name} ({en.addressCount} {en.addressCount === 1 ? "address" : "addresses"})
            </option>
          ))}
        </Select>
        <Button
          disabled={full || !entityId}
          icon={<Plus aria-hidden className="size-3.5" />}
          onClick={() => {
            if (entityId && add({ type: "entity", entityId })) setEntityId("");
          }}
        >
          Add entity
        </Button>
      </div>

      <p className="text-xs text-muted">
        {max != null ? `${targets.length} of ${max} targets. ` : ""}
        An entity target watches every address you have assigned to that entity.
      </p>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
