import { Eye, Group, Maximize2, Minus, Plus, Redo2, Share2, Trash2, Undo2, Ungroup } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, IconButton } from "../kit/Button.tsx";
import { Switch } from "../kit/Switch.tsx";
import { cn } from "../kit/cn.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";

export function Kbd({ children }: { children: string }) {
  return <kbd className="kit-mono rounded-[3px] border border-border px-1 text-[11px] text-faint">{children}</kbd>;
}

function ZoomInput({ scale, onScale }: { scale: number; onScale: (s: number) => void }) {
  const pct = Math.round(scale * 100);
  const [draft, setDraft] = useState(String(pct));
  useEffect(() => setDraft(String(pct)), [pct]);
  const commit = () => {
    const n = Number(draft.replace("%", ""));
    if (Number.isFinite(n) && n > 0) onScale(n / 100);
    else setDraft(String(pct));
  };
  return (
    <label className="kit-fade flex h-7 items-center rounded-sm px-1 hover:bg-surface-2 focus-within:bg-surface-2">
      <span className="sr-only">Zoom percent</span>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="kit-num h-7 w-8 bg-transparent text-right text-xs outline-none" inputMode="numeric" />
      <span aria-hidden className="kit-num text-xs text-faint">%</span>
    </label>
  );
}

const pill = "kit-dock flex h-10 items-center gap-0.5 px-1";
const Sep = () => <span aria-hidden className="kit-dock-sep" />;

export function Toolbar(props: {
  readOnly: boolean;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onScale: (s: number) => void;
  flowDots: boolean;
  onFlowDots: (v: boolean) => void;
  reducedMotion: boolean;
  onShare: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  canDelete: boolean;
  onDelete: () => void;
  onAdd: () => void;
  group?: { mode: "group" | "ungroup"; disabledReason: string | null; onClick: () => void } | null;
  className?: string;
}) {
  const p = props;
  return (
    <div className={cn("pointer-events-none flex flex-wrap items-end justify-between gap-2", p.className)}>
      <div className={cn(pill, "pointer-events-auto")}>
        {p.readOnly ? (
          <span className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted">
            <Eye aria-hidden className="size-3.5" /> View only
          </span>
        ) : (
          <Button variant="ghost" size="sm" icon={<Share2 aria-hidden className="size-3.5" />} onClick={p.onShare}>
            Share
          </Button>
        )}
        <Sep />
        <div className="flex items-center gap-0.5" role="group" aria-label="Zoom">
          <IconButton size="sm" label="Zoom out (−)" onClick={p.onZoomOut}><Minus aria-hidden className="size-3.5" /></IconButton>
          <ZoomInput scale={p.scale} onScale={p.onScale} />
          <IconButton size="sm" label="Zoom in (+)" onClick={p.onZoomIn}><Plus aria-hidden className="size-3.5" /></IconButton>
          <IconButton size="sm" label="Fit to view (F)" onClick={p.onFit}><Maximize2 aria-hidden className="size-3.5" /></IconButton>
        </div>
        <Sep />
        <div className="flex items-center gap-2 pl-1.5 pr-1.5">
          <span className="text-xs text-muted" id="flowdots-label">Flow dots</span>
          <Switch checked={p.flowDots && !p.reducedMotion} disabled={p.reducedMotion} onCheckedChange={p.onFlowDots} label={p.reducedMotion ? "Flow dots are off because reduced motion is on" : "Flow dots"} />
        </div>
      </div>
      {!p.readOnly ? (
        <div className={cn(pill, "pointer-events-auto")} role="toolbar" aria-label="Edit">
          {p.group ? (
            <>
              <span title={p.group.disabledReason ?? undefined}>
                <IconButton size="sm" label={p.group.mode === "ungroup" ? "Ungroup entity into addresses" : "Group addresses into their entity"} disabled={!!p.group.disabledReason} onClick={p.group.onClick}>
                  {p.group.mode === "ungroup" ? <Ungroup aria-hidden className="size-3.5" /> : <Group aria-hidden className="size-3.5" />}
                </IconButton>
              </span>
              <Sep />
            </>
          ) : null}
          <IconButton size="sm" label={`Undo${p.undoLabel ? `: ${p.undoLabel}` : ""} (${MOD}Z)`} disabled={!p.canUndo} onClick={p.onUndo}><Undo2 aria-hidden className="size-3.5" /></IconButton>
          <IconButton size="sm" label={`Redo${p.redoLabel ? `: ${p.redoLabel}` : ""} (${MOD}⇧Z)`} disabled={!p.canRedo} onClick={p.onRedo}><Redo2 aria-hidden className="size-3.5" /></IconButton>
          <IconButton size="sm" label="Remove selected (⌫)" disabled={!p.canDelete} onClick={p.onDelete} className={p.canDelete ? "text-danger hover:text-danger" : undefined}><Trash2 aria-hidden className="size-3.5" /></IconButton>
          <Sep />
          <Button variant="primary" size="sm" className="ml-0.5" icon={<Plus aria-hidden className="size-3.5" />} onClick={p.onAdd}>
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
