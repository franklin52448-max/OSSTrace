import type { AlertTarget, Chain, Entity } from "@osstrace/contract";
import { CHAIN_NAMES, chainForAddress } from "@osstrace/contract";
import { Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { dedupeTargets, targetKey } from "./alertForm.ts";
import { validateAddress } from "../kit/validation.ts";
import { Button, IconButton } from "../kit/Button.tsx";
import { Input, Select } from "../kit/Field.tsx";
import { ChainSelect } from "../ChainSelect.tsx";
import { TargetLabel } from "./parts.tsx";

/**
 * What an alert watches. One address field (its chain switches on its own when a recognisable
 * address is pasted), the list of watched targets, and, only when the user has entities, a picker
 * to watch one of those too.
 */
export function TargetsEditor({
  targets,
  onChange,
  entities,
  max,
  defaultChain,
  error,
  autoFocus,
}: {
  targets: AlertTarget[];
  onChange: (t: AlertTarget[]) => void;
  entities: Entity[];
  max?: number;
  defaultChain: Chain;
  error?: string;
  /** Put the cursor in the address field when the dialog opens on an empty rule. */
  autoFocus?: boolean;
}) {
  const [chain, setChain] = useState<Chain>(defaultChain);
  const [address, setAddress] = useState("");
  const [addrError, setAddrError] = useState<string | null>(null);
  const full = max != null && targets.length >= max;

  const add = (t: AlertTarget): boolean => {
    if (full) return false;
    const next = dedupeTargets([...targets, t]);
    if (next.length === targets.length) {
      setAddrError("Already watching this one.");
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
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex gap-2">
          <ChainSelect value={chain} onChange={setChain} small label="Address chain" />
          <Input
            aria-label="Address to watch"
            autoFocus={autoFocus}
            aria-invalid={addrError || error ? true : undefined}
            placeholder={chain === "solana" ? "Paste a Solana address" : `Paste ${chain === "ethereum" ? "an" : "a"} ${CHAIN_NAMES[chain]} address (0x…)`}
            spellCheck={false}
            autoComplete="off"
            value={address}
            disabled={full}
            onChange={(e) => {
              const v = e.target.value;
              setAddress(v);
              setAddrError(null);
              // Keeps BNB when a 0x address is pasted with BNB picked; only a shape mismatch switches.
              const detected = chainForAddress(v.trim(), chain);
              if (detected) setChain(detected);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") addAddress(e);
            }}
            className="kit-mono h-9 min-w-0 flex-1 placeholder:font-sans"
          />
          <Button variant="primary" className="h-9" onClick={() => addAddress()} disabled={full || !address.trim()} icon={<Plus aria-hidden className="size-3.5" />}>
            Add
          </Button>
        </div>
        {addrError ? <p className="mt-1.5 text-xs text-danger">{addrError}</p> : null}
      </div>

      {targets.length > 0 ? (
        <ul aria-label="Watched targets" className="divide-y divide-border overflow-hidden rounded-[12px] border border-border">
          {targets.map((t) => (
            <li key={targetKey(t)} className="flex h-10 items-center gap-2 pl-3 pr-1.5 text-[13px]">
              <TargetLabel target={t} entities={entities} link={false} />
              {t.type === "address" ? <span className="kit-mono hidden min-w-0 truncate text-xs text-faint lg:inline">{t.address}</span> : null}
              <IconButton size="sm" className="ml-auto" label="Remove target" onClick={() => onChange(targets.filter((x) => targetKey(x) !== targetKey(t)))}>
                <X aria-hidden className="size-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-[12px] border border-dashed border-border px-3 py-3 text-center text-xs text-muted">
          Nothing watched yet. Add an address above{entities.length ? " or pick one of your entities below" : ""}.
        </p>
      )}

      {entities.length > 0 ? (
        <Select
          aria-label="Watch one of your entities"
          className="h-9"
          value=""
          onChange={(e) => {
            if (e.target.value) add({ type: "entity", entityId: e.target.value });
          }}
          disabled={full || available.length === 0}
        >
          <option value="">{available.length === 0 ? "All your entities are being watched" : "Or watch one of your entities…"}</option>
          {available.map((en) => (
            <option key={en.id} value={en.id}>
              {en.name} ({en.addressCount} {en.addressCount === 1 ? "address" : "addresses"})
            </option>
          ))}
        </Select>
      ) : null}

      <p className="text-xs text-muted">
        {max != null ? `${targets.length} of ${max}. ` : ""}
        {entities.length > 0
          ? "An entity covers every address you've grouped under it."
          : <>Tip: group addresses into an entity under <a href="#labels/entities" className="text-accent hover:underline">Labels</a> to watch them together.</>}
      </p>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
