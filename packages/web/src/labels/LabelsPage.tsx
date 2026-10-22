import type { Chain, Label } from "@osstrace/contract";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronLeft, ChevronRight, Download, MoreVertical, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { downloadFile } from "../kit/api.ts";
import { useDeleteLabel, useEntities, useLabels, useTags, useUpdateLabel } from "./api.ts";
import { useDebounced, useDocumentTitle } from "../kit/hooks.ts";
import { CHAIN_NAMES } from "../kit/validation.ts";
import { Button, IconButton } from "../kit/Button.tsx";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { Chip } from "../kit/Chip.tsx";
import { cn } from "../kit/cn.ts";
import { ConfirmDialog } from "../kit/ConfirmDialog.tsx";
import { CopyButton } from "../kit/CopyButton.tsx";
import { Dialog } from "../kit/Dialog.tsx";
import { Field, Input, Select } from "../kit/Field.tsx";
import { formatCount, formatDate, shortAddress } from "../kit/format.ts";
import { EmptyState, ErrorNotice, ErrorText, SkeletonRows } from "../kit/QueryState.tsx";
import { Table, Td, Th, THead, Tr } from "../kit/Table.tsx";
import { useToast } from "../kit/Toast.tsx";
import { ImportDialog } from "./ImportDialog.tsx";
import { LabelDialog } from "./LabelDialog.tsx";
import { byId, TagList } from "./parts.tsx";

const PAGE_SIZES = [25, 50, 100] as const;
type Sort = "updated" | "oldest" | "name";

/** Reads/writes filter state in the hash's own query part (this page's #labels route owns it, the
 *  same way Visualizer's scratch mode owns `#graph/scratch?...`) -- a silent History API write, so
 *  it never re-triggers the LabelsRoute hash listener. */
function useHashParams(): [URLSearchParams, (mutate: (p: URLSearchParams) => void) => void] {
  const read = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const [params, setParamsState] = useState<URLSearchParams>(read);
  const setParams = (mutate: (p: URLSearchParams) => void) => {
    const p = read();
    mutate(p);
    const qs = p.toString();
    const hash = `#labels${qs ? `?${qs}` : ""}`;
    if (window.location.hash !== hash) history.replaceState(null, "", hash);
    setParamsState(p);
  };
  return [params, setParams];
}

/** CSV for the selected rows, built from the rows on screen (same columns as the server export). */
export function labelsToCsv(rows: Label[], entityName: (id: string | null) => string, tagName: (id: string) => string): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ["chain,address,name,note,entity,tags"];
  for (const l of rows) lines.push([l.chain, l.address, l.name, l.note ?? "", entityName(l.entityId), l.tagIds.map(tagName).filter(Boolean).join(";")].map(esc).join(","));
  return lines.join("\n") + "\n";
}

export function LabelsPage() {
  useDocumentTitle("Labels");
  const [params, setParams] = useHashParams();
  const chain = (params.get("chain") as Chain | null) ?? undefined;
  const entityId = params.get("entity") ?? undefined;
  const tagId = params.get("tag") ?? undefined;
  const [q, setQ] = useState(params.get("q") ?? "");
  const [pageSize, setPageSize] = useState<number>(50);
  const [sort, setSort] = useState<Sort>("updated");
  const debouncedQ = useDebounced(q.trim(), 250);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors.length - 1;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filterKey = `${chain}|${entityId}|${tagId}|${debouncedQ}|${pageSize}`;
  useEffect(() => {
    setCursors([undefined]);
    setSelected(new Set());
  }, [filterKey]);
  useEffect(() => {
    setParams((p) => {
      if (debouncedQ) p.set("q", debouncedQ);
      else p.delete("q");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const labels = useLabels({ chain, entityId, tagId, q: debouncedQ || undefined, limit: pageSize, cursor: cursors[page] });
  const entities = useEntities();
  const tags = useTags();
  const entityMap = useMemo(() => byId(entities.data), [entities.data]);
  const tagMap = useMemo(() => byId(tags.data), [tags.data]);
  const del = useDeleteLabel();
  const toast = useToast();

  const [editing, setEditing] = useState<Label | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<Label[] | null>(null);
  const [assigning, setAssigning] = useState<Label[] | null>(null);
  const [exporting, setExporting] = useState(false);

  const setFilter = (k: string, v: string) =>
    setParams((p) => {
      if (v) p.set(k, v);
      else p.delete(k);
    });
  const clearAll = () => {
    setQ("");
    setParams((p) => {
      for (const k of [...p.keys()]) p.delete(k);
    });
  };

  const filtered = !!(chain || entityId || tagId || debouncedQ);
  const raw = labels.data?.labels ?? [];
  // Sort applies to the page on screen; the server returns pages newest-updated first.
  const rows = useMemo(() => {
    const r = [...raw];
    if (sort === "oldest") r.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    else if (sort === "name") r.sort((a, b) => a.name.localeCompare(b.name));
    return r;
  }, [raw, sort]);
  const total = labels.data?.total ?? 0;
  const from = page * pageSize + 1;
  const selectedRows = rows.filter((l) => selected.has(l.id));
  const allOnPage = rows.length > 0 && rows.every((l) => selected.has(l.id));
  const toggleRow = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exportAll = async (format: "csv" | "json") => {
    setExporting(true);
    try {
      await downloadFile("/labels/export", { format }, `osstrace-labels-${new Date().toISOString().slice(0, 10)}.${format}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setExporting(false);
    }
  };
  const exportSelected = () => {
    const csv = labelsToCsv(selectedRows, (id) => (id ? (entityMap.get(id)?.name ?? "") : ""), (id) => tagMap.get(id)?.name ?? "");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `osstrace-labels-selected-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${selectedRows.length} label${selectedRows.length === 1 ? "" : "s"}`);
  };

  const filterChips = [
    chain ? { k: "Chain", v: CHAIN_NAMES[chain], key: "chain" } : null,
    entityId ? { k: "Entity", v: entityMap.get(entityId)?.name ?? "deleted", key: "entity" } : null,
    tagId ? { k: "Tag", v: tagMap.get(tagId)?.name ?? "deleted", key: "tag" } : null,
  ].filter(Boolean) as { k: string; v: string; key: string }[];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-[420px]">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input type="search" aria-label="Search labels by name, address or note" placeholder="Search name, address, note" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 pl-9" />
        </div>
        <Select aria-label="Filter by chain" value={chain ?? ""} onChange={(e) => setFilter("chain", e.target.value)} className="h-9 w-36">
          <option value="">All networks</option>
          {(Object.keys(CHAIN_NAMES) as Chain[]).map((c) => (
            <option key={c} value={c}>
              {CHAIN_NAMES[c]}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by entity" value={entityId ?? ""} onChange={(e) => setFilter("entity", e.target.value)} className="h-9 w-40">
          <option value="">Any entity</option>
          {(entities.data ?? []).map((en) => (
            <option key={en.id} value={en.id}>
              {en.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by tag" value={tagId ?? ""} onChange={(e) => setFilter("tag", e.target.value)} className="h-9 w-36">
          <option value="">Any tag</option>
          {(tags.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Sort this page" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-9 w-48">
          <option value="updated">Sort: Recently updated</option>
          <option value="oldest">Sort: Oldest first</option>
          <option value="name">Sort: Name</option>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <Menu.Root>
            <Menu.Trigger className="kit-fade inline-flex h-9 items-center gap-1.5 rounded-sm border border-border bg-surface px-3 text-[13px] font-medium hover:border-border-strong hover:bg-surface-2 data-[state=open]:bg-surface-2">
              <Download aria-hidden className="size-3.5" /> Export <ChevronDown aria-hidden className="size-3.5 text-muted" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content align="end" sideOffset={4} className="kit-overlay z-40 min-w-[180px] p-1">
                {(["csv", "json"] as const).map((f) => (
                  <Menu.Item key={f} disabled={exporting} onSelect={() => exportAll(f)} className="kit-fade flex h-8 cursor-pointer items-center rounded-sm px-2 text-[13px] outline-none data-[highlighted]:bg-surface-2">
                    All labels as {f.toUpperCase()}
                  </Menu.Item>
                ))}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
          <Button className="h-9" icon={<Upload aria-hidden className="size-3.5" />} onClick={() => setImporting(true)}>
            Bulk upload
          </Button>
          <Button variant="primary" className="h-9" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setCreating(true)}>
            New address
          </Button>
        </div>
      </div>

      {filterChips.length || debouncedQ ? (
        <div className="-mt-1 flex flex-wrap items-center gap-1.5">
          {debouncedQ ? <Chip k="Search" tone="accent" onRemove={() => setQ("")}>{debouncedQ}</Chip> : null}
          {filterChips.map((c) => (
            <Chip key={c.key} k={c.k} tone="accent" onRemove={() => setFilter(c.key, "")}>
              {c.v}
            </Chip>
          ))}
          <button type="button" onClick={clearAll} className="ml-1 text-xs font-medium text-muted hover:text-text">
            Clear all
          </button>
        </div>
      ) : null}

      <div className="kit-panel">
        {selectedRows.length > 0 ? (
          <div role="toolbar" aria-label="Bulk actions" className="flex h-11 items-center gap-2 border-b border-border bg-accent-soft px-3">
            <span className="kit-num mr-2 text-[13px] font-medium text-accent">{selectedRows.length} selected</span>
            <Button size="sm" onClick={() => setAssigning(selectedRows)}>
              Add to entity
            </Button>
            <Button size="sm" icon={<Download aria-hidden className="size-3" />} onClick={exportSelected}>
              Export
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 aria-hidden className="size-3" />} onClick={() => setDeleting(selectedRows)}>
              Delete
            </Button>
            <IconButton size="sm" className="ml-auto" label="Clear selection" onClick={() => setSelected(new Set())}>
              <X aria-hidden className="size-3.5" />
            </IconButton>
          </div>
        ) : null}
        {labels.isPending ? (
          <SkeletonRows rows={8} />
        ) : labels.isError ? (
          <ErrorNotice error={labels.error} onRetry={() => labels.refetch()} className="m-3" />
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState title="No labels match these filters." action={<Button size="sm" onClick={clearAll}>Clear filters</Button>} />
          ) : (
            <EmptyState
              title="Labels are yours: nothing here yet."
              body="Name an address once and that name shows in every trace, graph, table and alert. Add one by hand or bulk upload a CSV or JSON file."
              action={<Button size="sm" onClick={() => setCreating(true)}>New address</Button>}
            />
          )
        ) : (
          <Table label="Labels">
            <THead>
              <tr>
                <Th className="w-10">
                  <input
                    type="checkbox"
                    aria-label={allOnPage ? "Deselect all on this page" : "Select all on this page"}
                    checked={allOnPage}
                    onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((l) => l.id)))}
                    className="size-3.5 cursor-pointer accent-[var(--trace-accent)]"
                  />
                </Th>
                <Th>Address</Th>
                <Th>Label</Th>
                <Th>Network</Th>
                <Th>Entity</Th>
                <Th>Tags</Th>
                <Th className="hidden lg:table-cell">Updated</Th>
                <Th className="w-10">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <tbody className={labels.isPlaceholderData ? "opacity-60" : undefined}>
              {rows.map((l) => {
                const en = l.entityId ? entityMap.get(l.entityId) : undefined;
                return (
                  <Tr key={l.id} selected={selected.has(l.id)}>
                    <Td>
                      <input type="checkbox" aria-label={`Select ${l.name}`} checked={selected.has(l.id)} onChange={() => toggleRow(l.id)} className="size-3.5 cursor-pointer accent-[var(--trace-accent)]" />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        <a href={`#address/${l.chain}/${encodeURIComponent(l.address)}`} title={l.address} className="kit-mono text-[12.5px] hover:text-accent hover:underline">
                          {shortAddress(l.address, 8, 6)}
                        </a>
                        <CopyButton value={l.address} label="Copy address" />
                      </span>
                    </Td>
                    <Td className="max-w-64">
                      <InlineName label={l} />
                    </Td>
                    <Td>
                      <ChainBadge chain={l.chain} />
                    </Td>
                    <Td className="max-w-44">
                      {en ? (
                        <a href={`#labels/entities?entity=${encodeURIComponent(en.id)}`} className="block truncate hover:text-accent hover:underline">
                          {en.name}
                        </a>
                      ) : (
                        <button type="button" onClick={() => setAssigning([l])} className="text-[13px] text-accent hover:underline">
                          Add to entity
                        </button>
                      )}
                    </Td>
                    <Td>
                      <TagList ids={l.tagIds} tags={tagMap} />
                    </Td>
                    <Td className="kit-num hidden whitespace-nowrap text-xs text-muted lg:table-cell">{formatDate(l.updatedAt)}</Td>
                    <Td>
                      <RowMenu label={l} onEdit={() => setEditing(l)} onDelete={() => setDeleting([l])} />
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <div className="flex h-11 flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2 px-4 text-xs text-muted">
          <span className="flex items-center gap-1">
            <IconButton size="sm" label="Previous page" disabled={page === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
              <ChevronLeft aria-hidden className="size-3.5" />
            </IconButton>
            <span className="kit-num px-1">
              {rows.length ? `${formatCount(from)}–${formatCount(from + rows.length - 1)} of ${formatCount(total)}` : "0 of 0"}
            </span>
            <IconButton
              size="sm"
              label="Next page"
              disabled={!labels.data?.nextCursor || labels.isPlaceholderData}
              onClick={() => setCursors((c) => [...c, labels.data!.nextCursor!])}
            >
              <ChevronRight aria-hidden className="size-3.5" />
            </IconButton>
          </span>
          <label className="flex items-center gap-2">
            Rows per page
            <Select aria-label="Rows per page" value={String(pageSize)} onChange={(e) => setPageSize(Number(e.target.value))} className="h-7 w-20 text-xs">
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>

      <LabelDialog open={creating} onOpenChange={setCreating} initial={{ entityId: entityId ?? null }} />
      <LabelDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} label={editing} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
      <AssignEntityDialog labels={assigning} onClose={() => setAssigning(null)} onDone={() => setSelected(new Set())} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
            del.reset();
          }
        }}
        title={deleting && deleting.length > 1 ? `Delete ${deleting.length} labels` : "Delete label"}
        body={
          <p>
            {deleting && deleting.length > 1 ? (
              <>Delete {deleting.length} labels?</>
            ) : (
              <>
                Delete <span className="font-medium text-text">{deleting?.[0]?.name}</span>?
              </>
            )}{" "}
            The addresses will show as their hash again everywhere. Alerts that target these addresses keep working.
          </p>
        }
        confirmLabel={deleting && deleting.length > 1 ? `Delete ${deleting.length} labels` : "Delete label"}
        pending={del.isPending}
        error={del.error}
        onConfirm={async () => {
          if (!deleting) return;
          const results = await Promise.allSettled(deleting.map((l) => del.mutateAsync(l.id)));
          const failed = results.filter((r) => r.status === "rejected").length;
          if (failed) toast.error(`${failed} of ${deleting.length} labels could not be deleted. Try again.`);
          else toast.success(deleting.length > 1 ? `Deleted ${deleting.length} labels` : "Label deleted");
          setSelected(new Set());
          setDeleting(null);
        }}
      />
    </div>
  );
}

/** Click the name to rename in place; Enter saves, Escape cancels. */
function InlineName({ label }: { label: Label }) {
  const update = useUpdateLabel();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(label.name), [label.name]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const save = () => {
    const v = value.trim();
    if (!v || v === label.name) {
      setValue(label.name);
      setEditing(false);
      return;
    }
    if (v.length > 200) return toast.error("Name must be at most 200 characters.");
    update.mutate({ id: label.id, name: v }, { onSuccess: () => setEditing(false), onError: (e) => toast.error(e) });
  };
  if (editing) {
    return (
      <Input
        ref={ref}
        aria-label={`Rename ${label.name}`}
        value={value}
        disabled={update.isPending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setValue(label.name);
            setEditing(false);
          }
        }}
        className="h-7"
      />
    );
  }
  return (
    <button
      type="button"
      title={label.note ? `${label.note} (click to rename)` : "Click to rename"}
      onClick={() => setEditing(true)}
      className="kit-fade block h-7 max-w-full truncate rounded-sm border border-transparent px-2 text-left font-medium hover:border-border hover:bg-surface"
    >
      {label.name}
    </button>
  );
}

function RowMenu({ label, onEdit, onDelete }: { label: Label; onEdit: () => void; onDelete: () => void }) {
  const item = "kit-fade flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px] outline-none data-[highlighted]:bg-surface-2";
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={`Actions for ${label.name}`} className="kit-fade inline-flex size-7 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-text data-[state=open]:bg-surface-2">
        <MoreVertical aria-hidden className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={4} className="kit-overlay z-40 min-w-[160px] p-1">
          <Menu.Item className={item} onSelect={onEdit}>
            <Pencil aria-hidden className="size-3.5 text-muted" /> Edit details
          </Menu.Item>
          <Menu.Item className={cn(item, "text-danger")} onSelect={onDelete}>
            <Trash2 aria-hidden className="size-3.5" /> Delete
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Assign one or many labels to one of your entities (or remove them from their entity). */
function AssignEntityDialog({ labels, onClose, onDone }: { labels: Label[] | null; onClose: () => void; onDone: () => void }) {
  const entities = useEntities();
  const update = useUpdateLabel();
  const toast = useToast();
  const [entityId, setEntityId] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (labels) {
      setEntityId("");
      setError(null);
    }
  }, [labels]);
  const n = labels?.length ?? 0;
  const apply = async () => {
    if (!labels) return;
    setBusy(true);
    setError(null);
    const target = entityId === "__none" ? null : entityId;
    const results = await Promise.allSettled(labels.map((l) => update.mutateAsync({ id: l.id, entityId: target })));
    setBusy(false);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) return setError(failed.reason);
    toast.success(target ? `Added ${n} label${n === 1 ? "" : "s"} to ${entities.data?.find((e) => e.id === target)?.name ?? "the entity"}` : `Removed ${n} label${n === 1 ? "" : "s"} from their entity`);
    onDone();
    onClose();
  };
  return (
    <Dialog
      open={!!labels}
      onOpenChange={(o) => !o && onClose()}
      title="Add to entity"
      description={n === 1 ? `Group "${labels?.[0]?.name}" under one of your entities.` : `Group ${n} labelled addresses under one of your entities.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!entityId} onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Entity" help={entities.data?.length === 0 ? "No entities yet. Create one in the Entities tab first." : undefined}>
          {(p) => (
            <Select {...p} value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              <option value="">Choose an entity</option>
              {(entities.data ?? []).map((en) => (
                <option key={en.id} value={en.id}>
                  {en.name}
                </option>
              ))}
              <option value="__none">No entity (remove from entity)</option>
            </Select>
          )}
        </Field>
        {error ? <ErrorText error={error} /> : null}
      </div>
    </Dialog>
  );
}
