import { useEffect, useState } from "react";
import { describeError } from "../kit/errors.ts";
import { Button } from "../kit/Button.tsx";
import { Dialog } from "../kit/Dialog.tsx";
import { Input } from "../kit/Field.tsx";
import { formatUsd } from "../kit/format.ts";
import type { GraphNode, Neighbour } from "./lib/graph.ts";

export function SaveViewDialog({ open, onOpenChange, onSave, defaultName }: { open: boolean; onOpenChange: (o: boolean) => void; onSave: (name: string) => Promise<void>; defaultName: string }) {
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(defaultName);
      setError(null);
    }
  }, [open, defaultName]);
  const submit = async () => {
    if (!name.trim()) return setError("Enter a name.");
    setBusy(true);
    try {
      await onSave(name.trim().slice(0, 256));
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Save view" description="Saved views keep their base, filters, pins and expanded entities."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Save view</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">Name</span>
          <Input autoFocus value={name} maxLength={256} onChange={(e) => setName(e.target.value)} aria-invalid={!!error} />
        </label>
        {error ? <p role="alert" className="mt-1 text-xs text-danger">{error}</p> : null}
      </form>
    </Dialog>
  );
}

export function SendToTracerDialog({ origin, neighbours, onClose, onCreate }: { origin: GraphNode; neighbours: Neighbour[]; onClose: () => void; onCreate: (picked: Neighbour[]) => Promise<void> }) {
  const [picked, setPicked] = useState(() => new Set(neighbours.slice(0, 8).map((n) => n.node.id)));
  const [busy, setBusy] = useState(false);
  const chosen = neighbours.filter((n) => picked.has(n.node.id));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width="lg" title={`Trace from ${origin.label}`} description="Creates a new trace with this node and the counterparties you pick, joined by aggregate edges summed from the visible transfers."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await onCreate(chosen); } finally { setBusy(false); } }}>
            Create trace with {chosen.length} counterpart{chosen.length === 1 ? "y" : "ies"}
          </Button>
        </>
      }>
      {neighbours.length === 0 ? (
        <p className="text-[13px] text-muted">No visible counterparties. The trace will start with this node only.</p>
      ) : (
        <>
          <div className="mb-2 flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(neighbours.map((n) => n.node.id)))}>Select all</Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear all</Button>
          </div>
          <ul className="max-h-[45vh] overflow-y-auto border-y border-border">
            {neighbours.map((n) => (
              <li key={n.node.id} className="border-b border-border last:border-b-0">
                <label className="flex h-10 cursor-pointer items-center gap-3 px-1 text-[13px]">
                  <input type="checkbox" className="size-3.5 accent-[var(--trace-accent)]" checked={picked.has(n.node.id)}
                    onChange={() => setPicked((s) => { const x = new Set(s); if (x.has(n.node.id)) x.delete(n.node.id); else x.add(n.node.id); return x; })} />
                  <span className="min-w-0 flex-1 truncate">{n.node.label}</span>
                  <span className="kit-num text-xs text-out">{formatUsd(n.usdOut)} · {n.countOut}</span>
                  <span className="kit-num text-xs text-in">{formatUsd(n.usdIn)} · {n.countIn}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-faint">Out / in from {origin.label}, with transfer counts. Sums cover only transfers loaded on the canvas.</p>
        </>
      )}
    </Dialog>
  );
}
