import type { Chain, Entity } from "@osstrace/contract";
import { detectChain } from "@osstrace/contract";
import { Copy, Download, ExternalLink, PanelRightClose, Plus, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useEntity, useTags } from "./api.ts";
import { CHAIN_NAMES } from "../kit/validation.ts";
import { Button, IconButton } from "../kit/Button.tsx";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { CopyButton } from "../kit/CopyButton.tsx";
import { Input, Select } from "../kit/Field.tsx";
import { formatCount, formatTime, shortAddress } from "../kit/format.ts";
import { EmptyState, ErrorNotice, SkeletonRows } from "../kit/QueryState.tsx";
import { useToast } from "../kit/Toast.tsx";
import { ImportDialog } from "./ImportDialog.tsx";
import { LabelDialog, type LabelDialogInitial } from "./LabelDialog.tsx";
import { byId, TagList } from "./parts.tsx";

/** Entity inspector (right-hand aside): header, add / bulk add, addresses grouped by network, footer exports. */
export function EntityDetail({ id, onClose, onEdit, onDelete }: { id: string; onClose: () => void; onEdit: (e: Entity) => void; onDelete: (e: Entity) => void }) {
  const q = useEntity(id);
  const tags = useTags();
  const toast = useToast();
  const tagMap = useMemo(() => byId(tags.data), [tags.data]);
  const [adding, setAdding] = useState<LabelDialogInitial | null>(null);
  const [bulk, setBulk] = useState(false);
  const [paste, setPaste] = useState("");
  const [network, setNetwork] = useState<Chain | "">("");
  const en = q.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !adding && !bulk && !(e.target as HTMLElement | null)?.closest("[role=dialog]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, adding, bulk]);

  const addresses = (en?.addresses ?? []).filter((l) => !network || l.chain === network);
  const byChain = (Object.keys(CHAIN_NAMES) as Chain[]).map((c) => ({ chain: c, rows: addresses.filter((l) => l.chain === c) })).filter((g) => g.rows.length);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(addresses.map((l) => l.address).join("\n"));
      toast.success(`Copied ${addresses.length} address${addresses.length === 1 ? "" : "es"}`);
    } catch {
      toast.error("Clipboard is blocked in this browser.");
    }
  };
  const downloadCsv = () => {
    if (!en) return;
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = ["chain,address,name,entity", ...addresses.map((l) => [l.chain, l.address, l.name, en.name].map(esc).join(","))].join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `osstrace-entity-${en.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside aria-label={en ? `Entity ${en.name}` : "Entity"} className="kit-panel flex min-h-[520px] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <p className="kit-mono text-xs text-faint">{en ? `Last edited ${formatTime(en.updatedAt)}` : " "}</p>
        <div className="ml-auto flex items-center gap-1">
          {en ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => onEdit(en)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => onDelete(en)}>
                Delete
              </Button>
            </>
          ) : null}
          <IconButton size="sm" label="Close entity panel" onClick={onClose}>
            <PanelRightClose aria-hidden className="size-4" />
          </IconButton>
        </div>
      </div>
      {q.isPending ? (
        <SkeletonRows rows={5} />
      ) : q.isError ? (
        <ErrorNotice className="m-3" error={q.error} onRetry={() => q.refetch()} />
      ) : en ? (
        <>
          <div className="flex items-start gap-4 border-b border-border px-5 py-5">
            <span aria-hidden className="inline-flex size-14 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-2 text-[20px] font-semibold text-muted">
              {en.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.015em]">{en.name}</h2>
              <p className="kit-mono mt-1 text-xs text-muted">
                {formatCount(en.addressCount)} address{en.addressCount === 1 ? "" : "es"}
                {en.type ? ` · ${en.type}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <TagList ids={en.tagIds} tags={tagMap} max={6} />
                {en.website ? (
                  <a href={en.website} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent hover:underline">
                    website <ExternalLink aria-hidden className="size-3" />
                  </a>
                ) : null}
                {en.twitter ? <span className="kit-mono text-muted">@{en.twitter}</span> : null}
              </div>
              {en.note ? <p className="mt-2 whitespace-pre-wrap text-[13px] text-muted">{en.note}</p> : null}
            </div>
          </div>
          <form
            className="flex flex-wrap gap-2 px-4 pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              const v = paste.trim();
              setAdding({ entityId: en.id, address: v || undefined, chain: detectChain(v) ?? undefined });
              setPaste("");
            }}
          >
            <div className="relative min-w-48 flex-1">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <Input aria-label="Paste an address to add" placeholder="Paste an address to add" value={paste} onChange={(e) => setPaste(e.target.value)} className="kit-mono h-9 pl-8" spellCheck={false} />
            </div>
            <Button type="submit" className="h-9" icon={<Plus aria-hidden className="size-3.5" />}>
              Add
            </Button>
            <Button className="h-9" icon={<Upload aria-hidden className="size-3.5" />} onClick={() => setBulk(true)}>
              Bulk add
            </Button>
          </form>
          <div className="flex items-center gap-2 px-4 py-3">
            <Select aria-label="Filter by network" value={network} onChange={(e) => setNetwork(e.target.value as Chain | "")} className="h-8 w-40">
              <option value="">All networks</option>
              {(Object.keys(CHAIN_NAMES) as Chain[]).map((c) => (
                <option key={c} value={c}>
                  {CHAIN_NAMES[c]}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
            {addresses.length === 0 ? (
              <EmptyState title={network ? "No addresses on this network." : "No addresses in this entity yet."} body="Paste an address above, or pick this entity when you label one." />
            ) : (
              byChain.map((g) => (
                <section key={g.chain} aria-label={CHAIN_NAMES[g.chain]}>
                  <p className="kit-colhead sticky top-0 border-b border-border bg-surface-2 px-4 py-2">
                    {CHAIN_NAMES[g.chain]} <span className="kit-num ml-1 text-faint">{g.rows.length}</span>
                  </p>
                  <ul className="divide-y divide-border">
                    {g.rows.map((l) => (
                      <li key={l.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                        <ChainBadge chain={l.chain} />
                        <a href={`#address/${l.chain}/${encodeURIComponent(l.address)}`} title={l.address} className="kit-mono shrink-0 text-[12.5px] hover:text-accent hover:underline">
                          {shortAddress(l.address, 8, 6)}
                        </a>
                        <span className="ml-auto min-w-0 truncate rounded-sm border border-border bg-surface-2 px-2 py-0.5 font-medium">{l.name}</span>
                        <CopyButton value={l.address} label="Copy address" />
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
          <div className="flex h-11 items-center gap-2 border-t border-border bg-surface-2 px-3 text-xs">
            <span className="kit-num text-muted">{formatCount(addresses.length)} shown</span>
            <Button size="sm" variant="ghost" className="ml-auto" disabled={!addresses.length} icon={<Copy aria-hidden className="size-3" />} onClick={copyAll}>
              Copy addresses
            </Button>
            <Button size="sm" variant="ghost" disabled={!addresses.length} icon={<Download aria-hidden className="size-3" />} onClick={downloadCsv}>
              Download CSV
            </Button>
          </div>
        </>
      ) : null}
      <LabelDialog open={!!adding} onOpenChange={(o) => !o && setAdding(null)} initial={adding ?? undefined} />
      <ImportDialog open={bulk} onOpenChange={setBulk} />
    </aside>
  );
}
