import { detectChain, EVM_CHAINS, isEvmChain, type AddressInfo, type Chain, type TraceNode } from "@osstrace/contract";
import * as RDialog from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { describeError } from "../kit/errors.ts";
import { AddressChip } from "../kit/AddressChip.tsx";
import { Button } from "../kit/Button.tsx";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { CopyButton } from "../kit/CopyButton.tsx";
import { Dialog } from "../kit/Dialog.tsx";
import { Input } from "../kit/Field.tsx";
import { Switch } from "../kit/Switch.tsx";
import { cn } from "../kit/cn.ts";
import { saveLabel, useSearchHits } from "./api.ts";

export type AddTarget = { type: "address"; chain: Chain; address: string; info?: AddressInfo } | { type: "entity"; id: string; name: string };

/** Search hits plus a direct "use this address" row when the query is itself an address.
 *  `grouped` sets the hits under small headings (pasted address, entities, labels, addresses). */
export function SearchResults({ q, onPick, activeIndex, grouped = false }: { q: string; onPick: (t: AddTarget) => void; activeIndex?: number; grouped?: boolean }) {
  const res = useSearchHits(q);
  const term = q.trim();
  const detected = detectChain(term);
  // A 0x paste is the same account on every EVM chain: offer each one directly (Ethereum first)
  // rather than only the shape's default, so a BNB address is one click away even before search answers.
  const directChains: readonly Chain[] = detected ? (isEvmChain(detected) ? EVM_CHAINS : [detected]) : [];
  const hits = res.data?.hits ?? [];
  const items: { key: string; group: Group; target: AddTarget; render: ReactNode }[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (h.type === "entity") {
      items.push({ key: `e:${h.id}`, group: "entity", target: { type: "entity", id: h.id, name: h.name }, render: <span className="flex items-baseline gap-2"><span className="font-medium">{h.name}</span><span className="kit-mono text-xs text-faint">entity · {h.addressCount} addr</span></span> });
    } else {
      const k = `${h.chain}:${h.address}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const info: AddressInfo = h.type === "address" ? h.info : { address: h.address, chain: h.chain, label: { id: h.id, name: h.name, source: "user" } };
      items.push({ key: k, group: h.type === "label" ? "label" : "address", target: { type: "address", chain: h.chain, address: h.address, info }, render: <span className="flex min-w-0 items-center gap-2"><ChainBadge chain={h.chain} /><AddressChip info={info} showActions={false} /></span> });
    }
  }
  const missing = directChains.filter((c) => !items.some((i) => i.target.type === "address" && i.target.chain === c && i.target.address.toLowerCase() === term.toLowerCase()));
  for (const direct of [...missing].reverse()) {
    items.unshift({ key: `direct:${direct}:${term}`, group: "direct", target: { type: "address", chain: direct, address: term }, render: <span className="flex min-w-0 items-center gap-2"><ChainBadge chain={direct} /><span className="kit-mono truncate text-xs">{term}</span></span> });
  }
  if (!term) return <p className="px-1 py-3 text-[13px] text-muted">Paste an Ethereum, BNB Chain or Solana address, or type the name of one of your labels or entities.</p>;
  if (res.error && items.length === 0) return <p role="alert" className="px-1 py-3 text-[13px] text-danger">{describeError(res.error).message}</p>;
  if (items.length === 0) return <p className="px-1 py-3 text-[13px] text-muted">{res.isFetching ? "Searching…" : "No address, label or entity matches."}</p>;
  const option = (it: (typeof items)[number], i: number) => (
    <li key={it.key} role="option" aria-selected={i === activeIndex}>
      <button type="button" onClick={() => onPick(it.target)} className={cn("kit-fade flex h-10 w-full items-center rounded-sm px-2 text-left text-[13px] hover:bg-surface-2 focus-visible:bg-surface-2", i === activeIndex && "bg-surface-2")}>
        {it.render}
      </button>
    </li>
  );
  if (!grouped)
    return (
      <ul role="listbox" aria-label="Search results" className="flex flex-col">
        {items.map(option)}
      </ul>
    );
  let n = 0;
  return (
    <div role="listbox" aria-label="Search results" className="flex flex-col gap-1">
      {GROUPS.map((g) => {
        const rows = items.filter((it) => it.group === g.key);
        if (!rows.length) return null;
        return (
          <ul key={g.key} role="group" aria-label={g.label} className="flex flex-col">
            <li role="presentation" className="kit-sect-h px-2 pb-1 pt-2">{g.label}</li>
            {rows.map((it) => option(it, n++))}
          </ul>
        );
      })}
    </div>
  );
}

type Group = "direct" | "entity" | "label" | "address";
const GROUPS: { key: Group; label: string }[] = [
  { key: "direct", label: "Pasted address" },
  { key: "entity", label: "Your entities" },
  { key: "label", label: "Your labels" },
  { key: "address", label: "Addresses" },
];

/** Add a node: a search palette (the input is the header), grouped results below. */
export function AddNodeDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (t: AddTarget) => void }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="kit-scrim fixed inset-0 z-40 bg-[var(--trace-scrim)]" />
        <RDialog.Content data-state="open" className="kit-overlay fixed left-1/2 top-[12vh] z-50 flex max-h-[72vh] w-[calc(100vw-32px)] max-w-[680px] -translate-x-1/2 flex-col overflow-hidden">
          <RDialog.Title className="sr-only">Add a node</RDialog.Title>
          <RDialog.Description className="sr-only">Add an address or one of your entities to the canvas.</RDialog.Description>
          <form
            className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4"
            onSubmit={(e) => {
              e.preventDefault();
              const chain = detectChain(q);
              if (chain) onPick({ type: "address", chain, address: q.trim() });
            }}
          >
            <Search aria-hidden className="size-[18px] shrink-0 text-faint" />
            <label className="min-w-0 flex-1">
              <span className="sr-only">Search</span>
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a node: address, label or entity" autoComplete="off" spellCheck={false}
                className="h-10 w-full bg-transparent text-[15px] outline-none placeholder:text-faint" />
            </label>
            <RDialog.Close aria-label="Close" className="kit-fade rounded-sm p-1 text-muted hover:bg-surface-2 hover:text-text">
              <X aria-hidden className="size-4" />
            </RDialog.Close>
          </form>
          <div className="min-h-[200px] flex-1 overflow-y-auto p-1.5">
            <SearchResults q={q} onPick={onPick} grouped />
          </div>
          <p className="shrink-0 border-t border-border bg-surface-2 px-4 py-2 text-xs text-faint">Enter adds a pasted address directly. Esc closes.</p>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function ShareDialog({ open, onOpenChange, shareable, onShareable, url, kind = "trace" }: { open: boolean; onOpenChange: (o: boolean) => void; shareable: boolean; onShareable: (v: boolean) => Promise<boolean> | void; url: string; kind?: "trace" | "view" }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Share this ${kind}`} description={`Anyone with the link can view a public ${kind} without signing in. They cannot edit it.`}>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13px]">Public link</span>
        <Switch checked={shareable} disabled={busy} label={`Make ${kind} public`} onCheckedChange={async (v) => {
          setBusy(true);
          await onShareable(v);
          setBusy(false);
        }} />
      </div>
      <div className={cn("mt-3 flex items-center gap-2 rounded-sm border border-border px-2 py-1.5", !shareable && "opacity-50")}>
        <span className="kit-mono min-w-0 flex-1 truncate text-xs" title={url}>{url}</span>
        {shareable ? <CopyButton value={url} label="Copy link" /> : null}
      </div>
      {!shareable ? <p className="mt-2 text-xs text-muted">Turn on the public link to copy it.</p> : null}
    </Dialog>
  );
}

/** Anon Tracer sharing (ADR 0025): genuinely separate from ShareDialog above -- a one-time
 *  "publish a snapshot" action, not an on/off toggle on a living document (there is no living
 *  document; a scratch canvas is never saved anywhere). The link it returns expires in 3 hours and
 *  can't be turned back off or renewed, so this dialog has no "make private" affordance at all. */
export function AnonShareDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: () => Promise<{ url: string; expiresAt: string }> }) {
  const [result, setResult] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setResult(null);
      setError(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Share this trace"
      description="Creates a read-only link to this canvas exactly as it is right now. Anyone with the link can view it without signing in -- it expires in 3 hours and can't be edited, renewed or taken back once created."
    >
      {result ? (
        <>
          <div className="flex items-center gap-2 rounded-sm border border-border px-2 py-1.5">
            <span className="kit-mono min-w-0 flex-1 truncate text-xs" title={result.url}>{result.url}</span>
            <CopyButton value={result.url} label="Copy link" />
          </div>
          <p className="mt-2 text-xs text-muted">Expires {new Date(result.expiresAt).toLocaleString()}.</p>
        </>
      ) : (
        <>
          {error ? <p className="mb-2 text-xs text-danger">{error}</p> : null}
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setResult(await onCreate());
              } catch (e) {
                setError(describeError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Creating link…" : "Create a 3-hour link"}
          </Button>
        </>
      )}
    </Dialog>
  );
}

export function EditLabelDialog({ node, onClose, onSaved }: { node: TraceNode | null; onClose: () => void; onSaved: () => void }) {
  const current = node?.displayAddress?.label;
  const [name, setName] = useState(current?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(node?.displayAddress?.label?.name ?? "");
    setError(null);
  }, [node]);
  if (!node || !node.chain || !node.address) return null;
  const submit = async () => {
    if (!name.trim()) return setError("Enter a name.");
    setBusy(true);
    try {
      await saveLabel({ id: current?.source === "user" ? current.id : undefined, chain: node.chain!, address: node.address!, name: name.trim() });
      onSaved();
      onClose();
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={current ? "Edit label" : "Add label"} description="Labels are private to your account and show everywhere this address appears."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Save label</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-2">
        <p className="kit-mono break-all text-xs text-muted">{node.address}</p>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">Name</span>
          <Input autoFocus value={name} maxLength={128} onChange={(e) => setName(e.target.value)} aria-invalid={!!error} />
        </label>
        {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      </form>
    </Dialog>
  );
}
