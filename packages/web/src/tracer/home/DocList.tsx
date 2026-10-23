/** Page sidebar listing the user's traces or views: title, last edit, small counts, a kebab menu,
 *  inline delete confirmation and inline rename. Shared by the Tracer and Visualizer homes. */
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Globe, MoreVertical, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { describeError } from "../../kit/errors.ts";
import { Button } from "../../kit/Button.tsx";
import { cn } from "../../kit/cn.ts";
import { ErrorNotice } from "../../kit/QueryState.tsx";
import { formatRelative } from "../../panels/parts.tsx";

export type DocListItem = { id: string; title: string; href: string; updatedAt: string; meta?: ReactNode; shareable: boolean };
export type DocMenuAction = { key: string; label: string; danger?: boolean; onSelect: () => void };

export type DocListProps = {
  /** "Traces" / "Views" */
  title: string;
  /** "trace" / "view": used in confirmations and labels */
  noun: string;
  items: DocListItem[] | undefined;
  error?: unknown;
  onRetry?: () => void;
  /** Signed out: no account, so nothing to list -- shown instead of a load error or a forever-loading
   * skeleton (anon mode, ADR 0024). The "New scratch ..." button above still works either way. */
  signedOut?: boolean;
  newLabel: string;
  onNew: () => void;
  newPending?: boolean;
  /** Menu entries besides Delete (which the list renders itself, with an inline confirmation). */
  actions: (item: DocListItem) => DocMenuAction[];
  onDelete: (item: DocListItem) => Promise<unknown>;
  /** Set to an item id to show an inline rename field for that row. */
  renamingId?: string | null;
  onRename?: (item: DocListItem, name: string) => Promise<unknown>;
  onRenameEnd?: () => void;
  emptyText: string;
  className?: string;
};

export function DocList(p: DocListProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <aside aria-label={p.title} className={cn("flex min-h-0 flex-col border-border bg-surface", p.className)}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">{p.title}</h1>
        {p.items ? <span className="kit-num rounded-sm border border-border px-1.5 text-[11px] leading-[18px] text-muted">{p.items.length}</span> : null}
        <Button variant="primary" size="sm" className="ml-auto" icon={<Plus aria-hidden className="size-3.5" />} loading={p.newPending} onClick={p.onNew}>
          {p.newLabel}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {p.signedOut ? (
          <p className="px-4 py-5 text-[13px] text-muted">Connect a wallet to save {p.noun}s and come back to them later.</p>
        ) : p.error ? (
          <div className="p-3"><ErrorNotice error={p.error} title={`Could not load your ${p.noun}s`} onRetry={p.onRetry} /></div>
        ) : !p.items ? (
          <ul aria-label="Loading" className="flex flex-col">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex h-[68px] flex-col justify-center gap-2 border-b border-border px-4">
                <span className="kit-skeleton h-3 w-40" />
                <span className="kit-skeleton h-2.5 w-24" />
              </li>
            ))}
          </ul>
        ) : p.items.length === 0 ? (
          <p className="px-4 py-5 text-[13px] text-muted">{p.emptyText}</p>
        ) : (
          <ul className="flex flex-col">
            {p.items.map((it) =>
              confirmId === it.id ? (
                <ConfirmRow key={it.id} item={it} noun={p.noun} onCancel={() => setConfirmId(null)} onConfirm={() => p.onDelete(it).then(() => setConfirmId(null))} />
              ) : p.renamingId === it.id && p.onRename ? (
                <RenameRow key={it.id} item={it} onSave={(name) => p.onRename!(it, name)} onDone={() => p.onRenameEnd?.()} />
              ) : (
                <Row key={it.id} item={it} noun={p.noun} actions={p.actions(it)} onDelete={() => setConfirmId(it.id)} />
              ),
            )}
          </ul>
        )}
      </div>
    </aside>
  );
}

function Row({ item, noun, actions, onDelete }: { item: DocListItem; noun: string; actions: DocMenuAction[]; onDelete: () => void }) {
  return (
    <li className="group relative border-b border-border">
      <a href={item.href} className="kit-fade flex min-h-[68px] flex-col justify-center gap-1 py-3 pl-4 pr-12 hover:bg-surface-2 focus-visible:bg-surface-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate text-[14px] font-medium", !item.title && "text-muted")}>{item.title || `Untitled ${noun}`}</span>
          {item.shareable ? <Globe aria-label="Public" className="size-3.5 shrink-0 text-faint" /> : null}
        </span>
        <span className="kit-mono flex min-w-0 items-center gap-1.5 truncate text-[11px] text-faint">
          <span title={item.updatedAt}>{formatRelative(item.updatedAt)}</span>
          {item.meta ? (
            <>
              <span aria-hidden>·</span>
              {item.meta}
            </>
          ) : null}
        </span>
      </a>
      <Menu.Root>
        <Menu.Trigger
          aria-label={`Actions for ${item.title || `untitled ${noun}`}`}
          className="kit-fade absolute right-2 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-sm text-muted hover:bg-surface-3 hover:text-text data-[state=open]:bg-surface-3 data-[state=open]:text-text"
        >
          <MoreVertical aria-hidden className="size-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="end" sideOffset={4} className="kit-overlay z-[80] min-w-44 p-1 text-[13px]" data-state="open">
            {actions.map((a) => (
              <Menu.Item key={a.key} onSelect={a.onSelect} className={cn("kit-fade flex h-8 cursor-pointer items-center rounded-sm px-2.5 outline-none data-[highlighted]:bg-surface-2", a.danger && "text-danger")}>
                {a.label}
              </Menu.Item>
            ))}
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Item onSelect={onDelete} className="kit-fade flex h-8 cursor-pointer items-center rounded-sm px-2.5 text-danger outline-none data-[highlighted]:bg-danger-soft">
              Delete {noun}
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </li>
  );
}

function ConfirmRow({ item, noun, onCancel, onConfirm }: { item: DocListItem; noun: string; onCancel: () => void; onConfirm: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <li className="border-b border-border bg-danger-soft px-4 py-3" role="group" aria-label={`Delete ${item.title || `untitled ${noun}`}`}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <p className="text-[13px] font-medium">Delete this {noun}?</p>
      <p className="mt-0.5 truncate text-xs text-muted">"{item.title || `Untitled ${noun}`}" is deleted for good; public links stop working.</p>
      {error ? <p role="alert" className="mt-1 text-xs text-danger">{error}</p> : null}
      <div className="mt-2 flex justify-end gap-2">
        <Button ref={cancelRef} size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="danger-solid" loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
            } catch (e) {
              setError(describeError(e).message);
              setBusy(false);
            }
          }}>
          Delete {noun}
        </Button>
      </div>
    </li>
  );
}

function RenameRow({ item, onSave, onDone }: { item: DocListItem; onSave: (name: string) => Promise<unknown>; onDone: () => void }) {
  const [name, setName] = useState(item.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commit = async () => {
    const n = name.trim().slice(0, 256);
    if (!n || n === item.title) return onDone();
    setBusy(true);
    try {
      await onSave(n);
      onDone();
    } catch (e) {
      setError(describeError(e).message);
      setBusy(false);
    }
  };
  return (
    <li className="border-b border-border bg-surface-2 px-4 py-3">
      <form onSubmit={(e) => { e.preventDefault(); void commit(); }}>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Name</span>
          <input autoFocus value={name} maxLength={256} disabled={busy} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onDone()} onBlur={() => !busy && void commit()}
            className="h-8 rounded-sm border border-border bg-surface px-2 text-[13px] focus-visible:border-accent" />
        </label>
        {error ? <p role="alert" className="mt-1 text-xs text-danger">{error}</p> : null}
      </form>
    </li>
  );
}
