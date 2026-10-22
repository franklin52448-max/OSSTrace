import type { Tag } from "@osstrace/contract";
import { ChevronRight, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useCreateTag, useDeleteTag, useLabels, useTags, useUpdateTag } from "./api.ts";
import { isApiError } from "../kit/api.ts";
import { useDocumentTitle } from "../kit/hooks.ts";
import { Button } from "../kit/Button.tsx";
import { ConfirmDialog } from "../kit/ConfirmDialog.tsx";
import { Dialog } from "../kit/Dialog.tsx";
import { Field, Input } from "../kit/Field.tsx";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { formatCount, formatDate, shortAddress } from "../kit/format.ts";
import { EmptyState, ErrorNotice, ErrorText, SkeletonRows } from "../kit/QueryState.tsx";
import { Table, Td, Th, THead, Tr } from "../kit/Table.tsx";
import { useToast } from "../kit/Toast.tsx";

/** Muted swatches that read on both themes. Users can also type any hex. */
export const TAG_COLORS = ["#7f9fe0", "#74b88c", "#d2a85a", "#dc7a70", "#a993d8", "#5fb3b3", "#c98bb9", "#9a9993"];
const HEX_RE = /^#[0-9a-f]{6}$/i;

function readTagParam(): string | null {
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tag");
}

export function TagsPage() {
  useDocumentTitle("Tags");
  const tags = useTags();
  const del = useDeleteTag();
  const toast = useToast();
  const [tagParam, setTagParam] = useState<string | null>(readTagParam);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Tag | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const all = [...(tags.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const list = q.trim() ? all.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase())) : all;
  const current = all.find((t) => t.id === tagParam) ?? all[0] ?? null;
  const pick = (id: string) => {
    const hash = `#labels/tags?tag=${encodeURIComponent(id)}`;
    if (window.location.hash !== hash) history.replaceState(null, "", hash);
    setTagParam(id);
  };

  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start">
      <aside aria-label="Tags" className="kit-panel flex shrink-0 flex-col md:sticky md:top-4 md:max-h-[calc(100dvh-var(--trace-topbar-h)-140px)] md:w-[var(--trace-sidebar-w)]">
        <div className="kit-panel-head">
          <h2 className="kit-panel-title">Tags</h2>
          <Button size="sm" variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setCreating(true)}>
            New tag
          </Button>
        </div>
        <div className="p-2">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <Input type="search" aria-label="Search tags" placeholder="Search tags" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
        </div>
        <ul aria-label="Tag list" className="min-h-0 flex-1 overflow-y-auto border-t border-border p-2">
          {tags.isPending ? (
            <li className="px-2 py-2 text-xs text-muted">Loading tags</li>
          ) : tags.isError ? (
            <li className="px-2 py-2">
              <ErrorNotice error={tags.error} onRetry={() => tags.refetch()} />
            </li>
          ) : list.length === 0 ? (
            <li className="px-2 py-2 text-[13px] text-muted">{q.trim() ? "No tag matches." : "No tags yet."}</li>
          ) : (
            list.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  aria-current={current?.id === t.id ? "true" : undefined}
                  onClick={() => pick(t.id)}
                  className={`kit-fade flex h-10 w-full items-center gap-2.5 rounded-sm px-2.5 text-left ${current?.id === t.id ? "bg-accent-soft text-accent" : "hover:bg-surface-2"}`}
                >
                  <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: t.color }} />
                  <span className="kit-mono min-w-0 flex-1 truncate text-[12px] font-medium uppercase tracking-[0.06em]">{t.name}</span>
                  <span className="kit-num text-xs text-muted">{formatCount(t.usageCount)}</span>
                  <ChevronRight aria-hidden className="size-3.5 text-faint" />
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>

      <div className="min-w-0 flex-1">
        {tags.isSuccess && all.length === 0 ? (
          <EmptyState
            className="kit-panel"
            title="No tags yet."
            body="Make tags like exchange, bridge or suspect, then attach them to labels and entities. Filter any table by tag."
            action={<Button size="sm" onClick={() => setCreating(true)}>New tag</Button>}
          />
        ) : current ? (
          <TagDetail tag={current} onEdit={() => setEditing(current)} onDelete={() => setDeleting(current)} />
        ) : null}
      </div>

      <TagDialog open={creating} onOpenChange={setCreating} />
      <TagDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} tag={editing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
            del.reset();
          }
        }}
        title="Delete tag"
        body={
          <p>
            Delete <span className="font-medium text-text">{deleting?.name}</span>?{" "}
            {deleting && deleting.usageCount > 0
              ? `It is removed from ${formatCount(deleting.usageCount)} label${deleting.usageCount === 1 ? "" : "s"} and entities. The labels themselves stay.`
              : "Nothing uses it yet."}
          </p>
        }
        confirmLabel="Delete tag"
        pending={del.isPending}
        error={del.error}
        onConfirm={() =>
          deleting &&
          del.mutate(deleting.id, {
            onSuccess: () => {
              toast.success("Tag deleted");
              setDeleting(null);
              history.replaceState(null, "", "#labels/tags");
              setTagParam(null);
            },
          })
        }
      />
    </div>
  );
}

/** Main area for one tag: header (title, colour, usage, actions) and the labels that carry it. */
function TagDetail({ tag, onEdit, onDelete }: { tag: Tag; onEdit: () => void; onDelete: () => void }) {
  const labels = useLabels({ tagId: tag.id, limit: 100 });
  const rows = labels.data?.labels ?? [];
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="kit-mono flex items-center gap-3 text-[26px] font-semibold uppercase leading-tight tracking-[0.02em]">
            <span aria-hidden className="size-4 shrink-0 rounded-[4px]" style={{ background: tag.color }} />
            <span className="truncate">{tag.name}</span>
          </h1>
          <p className="kit-mono mt-1.5 text-xs text-muted">
            used by {formatCount(tag.usageCount)} label{tag.usageCount === 1 ? "" : "s"} and entities · created {formatDate(tag.createdAt)} · {tag.color}
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={<Pencil aria-hidden className="size-3.5" />} onClick={onEdit}>
            Edit
          </Button>
          <Button variant="danger" icon={<Trash2 aria-hidden className="size-3.5" />} onClick={onDelete}>
            Delete
          </Button>
        </div>
      </header>
      <div className="kit-panel">
        <div className="kit-panel-head">
          <p className="kit-panel-title">Labels with this tag</p>
          <a href={`#labels?tag=${encodeURIComponent(tag.id)}`} className="text-xs font-medium text-accent hover:underline">
            Open in labels table
          </a>
        </div>
        {labels.isPending ? (
          <SkeletonRows rows={4} />
        ) : labels.isError ? (
          <ErrorNotice className="m-3" error={labels.error} onRetry={() => labels.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No labels carry this tag." body="Attach it from a label's details, or to an entity from the Entities tab." />
        ) : (
          <Table label={`Labels tagged ${tag.name}`}>
            <THead>
              <tr>
                <Th className="w-12">#</Th>
                <Th>Label</Th>
                <Th>Address</Th>
                <Th>Network</Th>
                <Th>Updated</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((l, i) => (
                <Tr key={l.id}>
                  <Td className="kit-num text-xs text-muted">{i + 1}</Td>
                  <Td className="max-w-72 truncate font-medium">{l.name}</Td>
                  <Td>
                    <a href={`#address/${l.chain}/${encodeURIComponent(l.address)}`} title={l.address} className="kit-mono text-[12.5px] hover:text-accent hover:underline">
                      {shortAddress(l.address, 8, 6)}
                    </a>
                  </Td>
                  <Td>
                    <ChainBadge chain={l.chain} />
                  </Td>
                  <Td className="kit-num text-xs text-muted">{formatDate(l.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {labels.data && labels.data.total > rows.length ? (
          <p className="border-t border-border bg-surface-2 px-4 py-2.5 text-xs text-muted">
            Showing {rows.length} of {formatCount(labels.data.total)}.{" "}
            <a href={`#labels?tag=${encodeURIComponent(tag.id)}`} className="text-accent hover:underline">
              See all in the labels table
            </a>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function TagDialog({ open, onOpenChange, tag }: { open: boolean; onOpenChange: (o: boolean) => void; tag?: Tag | null }) {
  const create = useCreateTag();
  const update = useUpdateTag();
  const toast = useToast();
  const m = tag ? update : create;
  const [name, setName] = useState("");
  const [color, setColor] = useState(TAG_COLORS[0]!);
  const [errors, setErrors] = useState<{ name?: string; color?: string }>({});

  useEffect(() => {
    if (open) {
      setName(tag?.name ?? "");
      setColor(tag?.color ?? TAG_COLORS[0]!);
      setErrors({});
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tag?.id]);

  const conflict = isApiError(m.error, "conflict");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    const n = name.trim();
    if (!n) errs.name = "Enter a name.";
    else if (n.length > 40) errs.name = "Name must be at most 40 characters.";
    if (!HEX_RE.test(color)) errs.color = "Use a hex colour like #7f9fe0.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const done = () => {
      toast.success(tag ? "Tag saved" : "Tag created");
      onOpenChange(false);
    };
    if (tag) update.mutate({ id: tag.id, name: n, color: color.toLowerCase() }, { onSuccess: done });
    else create.mutate({ name: n, color: color.toLowerCase() }, { onSuccess: done });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tag ? "Edit tag" : "New tag"}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="tag-form" variant="primary" loading={m.isPending}>
            {tag ? "Save" : "Create tag"}
          </Button>
        </>
      }
    >
      <form id="tag-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Name" error={errors.name ?? (conflict ? "A tag with this name already exists." : null)}>
          {(p) => <Input {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-medium">Colour</legend>
          <div className="flex flex-wrap gap-1.5">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                aria-pressed={color.toLowerCase() === c}
                onClick={() => setColor(c)}
                className={`kit-fade size-7 rounded-sm ring-offset-2 ring-offset-[var(--trace-surface)] ${color.toLowerCase() === c ? "ring-2 ring-text" : "hover:ring-1 hover:ring-border-strong"}`}
                style={{ background: c }}
              />
            ))}
          </div>
          <Field label="Hex" error={errors.color} className="max-w-40">
            {(p) => <Input {...p} className="kit-mono" value={color} maxLength={7} onChange={(e) => setColor(e.target.value.trim())} />}
          </Field>
        </fieldset>
        {m.isError && !conflict ? <ErrorText error={m.error} /> : null}
      </form>
    </Dialog>
  );
}
