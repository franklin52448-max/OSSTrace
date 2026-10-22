import type { Entity } from "@osstrace/contract";
import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useDeleteEntity, useEntities, useTags } from "./api.ts";
import { useDocumentTitle } from "../kit/hooks.ts";
import { Button } from "../kit/Button.tsx";
import { ConfirmDialog } from "../kit/ConfirmDialog.tsx";
import { Input, Select } from "../kit/Field.tsx";
import { formatCount, formatDate } from "../kit/format.ts";
import { EmptyState, ErrorNotice, SkeletonRows } from "../kit/QueryState.tsx";
import { Table, Td, Th, THead, Tr } from "../kit/Table.tsx";
import { useToast } from "../kit/Toast.tsx";
import { EntityDetail } from "./EntityDetail.tsx";
import { EntityDialog } from "./EntityDialog.tsx";
import { byId, TagList } from "./parts.tsx";

function readSelected(): string | null {
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("entity");
}

export function EntitiesPage() {
  useDocumentTitle("Entities");
  const [selected, setSelected] = useState<string | null>(readSelected);
  const entities = useEntities();
  const tags = useTags();
  const tagMap = useMemo(() => byId(tags.data), [tags.data]);
  const del = useDeleteEntity();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"updated" | "name" | "addresses">("updated");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Entity | null>(null);
  const [deleting, setDeleting] = useState<Entity | null>(null);

  const select = (id: string | null) => {
    const hash = id ? `#labels/entities?entity=${encodeURIComponent(id)}` : "#labels/entities";
    if (window.location.hash !== hash) history.replaceState(null, "", hash);
    setSelected(id);
  };

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = [...(entities.data ?? [])].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "addresses" ? b.addressCount - a.addressCount : b.updatedAt.localeCompare(a.updatedAt),
    );
    return term ? all.filter((e) => e.name.toLowerCase().includes(term) || (e.type ?? "").toLowerCase().includes(term)) : all;
  }, [entities.data, q, sort]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-[420px]">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input type="search" aria-label="Search entities by name or type" placeholder="Search entities" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 pl-9" />
        </div>
        <Select aria-label="Sort entities" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="ml-auto h-9 w-56">
          <option value="updated">Sort: Recently updated</option>
          <option value="name">Sort: Name</option>
          <option value="addresses">Sort: Most addresses</option>
        </Select>
        <Button variant="primary" className="h-9" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setCreating(true)}>
          New entity
        </Button>
      </div>
      <div className={selected ? "grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(440px,1.15fr)]" : ""}>
      <div className="kit-panel">
        {entities.isPending ? (
          <SkeletonRows rows={6} />
        ) : entities.isError ? (
          <ErrorNotice error={entities.error} onRetry={() => entities.refetch()} className="m-3" />
        ) : list.length === 0 ? (
          q.trim() ? (
            <EmptyState title="No entities match this filter." />
          ) : (
            <EntitiesEmpty onCreate={() => setCreating(true)} />
          )
        ) : (
          <Table label="Entities">
            <THead>
              <tr>
                <Th>Entity</Th>
                <Th className={selected ? "hidden" : undefined}>Type</Th>
                <Th num>Addresses</Th>
                <Th className={selected ? "hidden" : undefined}>Tags</Th>
                <Th className={selected ? "hidden" : undefined}>Updated</Th>
              </tr>
            </THead>
            <tbody>
              {list.map((e) => (
                <Tr key={e.id} selected={selected === e.id} className="cursor-pointer" onClick={() => select(e.id)}>
                  <Td className="max-w-72">
                    <button type="button" onClick={(ev) => { ev.stopPropagation(); select(e.id); }} aria-current={selected === e.id ? "true" : undefined} className="flex max-w-full items-center gap-2 text-left font-medium hover:text-accent">
                      <span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-[11px] text-muted">{e.name.slice(0, 1).toUpperCase()}</span>
                      <span className="truncate">{e.name}</span>
                    </button>
                  </Td>
                  <Td className={selected ? "hidden" : "text-muted"}>{e.type || <span className="text-faint">—</span>}</Td>
                  <Td num>{formatCount(e.addressCount)}</Td>
                  <Td className={selected ? "hidden" : undefined}>
                    <TagList ids={e.tagIds} tags={tagMap} />
                  </Td>
                  <Td className={selected ? "hidden" : "kit-num text-xs text-muted"}>{formatDate(e.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      {selected ? <EntityDetail key={selected} id={selected} onClose={() => select(null)} onEdit={(e) => setEditing(e)} onDelete={(e) => setDeleting(e)} /> : null}
      </div>

      <EntityDialog open={creating} onOpenChange={setCreating} onSaved={(e) => select(e.id)} />
      <EntityDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} entity={editing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
            del.reset();
          }
        }}
        title="Delete entity"
        body={
          <p>
            Delete <span className="font-medium text-text">{deleting?.name}</span>? Its {formatCount(deleting?.addressCount ?? 0)} labelled address
            {deleting?.addressCount === 1 ? "" : "es"} keep their labels but no longer belong to an entity. Alerts that target this entity stop matching.
          </p>
        }
        confirmLabel="Delete entity"
        pending={del.isPending}
        error={del.error}
        onConfirm={() =>
          deleting &&
          del.mutate(deleting.id, {
            onSuccess: () => {
              toast.success("Entity deleted");
              setDeleting(null);
              select(null);
            },
          })
        }
      />
    </div>
  );
}

function EntitiesEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      title="No entities yet."
      body="An entity is one owner with many addresses: an exchange, a fund, a person. Create one, then assign labelled addresses to it."
      action={
        <Button size="sm" onClick={onCreate}>
          New entity
        </Button>
      }
    />
  );
}
