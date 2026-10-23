import { Eye, GripVertical, Group, Link2, Maximize2, Minus, Plus, Redo2, Share2, Trash2, Undo2, Ungroup } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../kit/Button.tsx";
import { Switch } from "../kit/Switch.tsx";
import { cn } from "../kit/cn.ts";

const EDIT_POS_KEY = "osstrace.tracer.editToolbarOffset";

/** Offset from the edit pill's default position (bottom-centered), dragged by its grip handle and
 * saved per browser -- same localStorage-per-visitor pattern as theme.ts/motion.ts, just for one
 * widget's position rather than a site-wide preference. */
function useDraggableOffset(): { dx: number; dy: number; dragging: boolean; onGripPointerDown: (e: React.PointerEvent) => void } {
  const [offset, setOffset] = useState(() => {
    try {
      const raw = window.localStorage.getItem(EDIT_POS_KEY);
      const parsed = raw ? (JSON.parse(raw) as { dx?: number; dy?: number }) : null;
      return { dx: parsed?.dx ?? 0, dy: parsed?.dy ?? 0 };
    } catch {
      return { dx: 0, dy: 0 };
    }
  });
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

  const onGripPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY, dx: offset.dx, dy: offset.dy };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      if (!start.current) return;
      setOffset({ dx: start.current.dx + (e.clientX - start.current.x), dy: start.current.dy + (e.clientY - start.current.y) });
    };
    const onUp = () => {
      setDragging(false);
      start.current = null;
      setOffset((o) => {
        try {
          window.localStorage.setItem(EDIT_POS_KEY, JSON.stringify(o));
        } catch {
          // Storage blocked (private mode etc.): the position just won't survive a reload.
        }
        return o;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  return { ...offset, dragging, onGripPointerDown };
}

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
  onFindConnections: () => void;
  finding: boolean;
  indirectOn: boolean;
  onIndirectOn: (v: boolean) => void;
  indirectLocked: boolean;
  className?: string;
}) {
  const p = props;
  const drag = useDraggableOffset();
  return (
    <div className={cn("pointer-events-none relative flex flex-wrap items-end gap-2", p.className)}>
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
        <div
          className={cn(pill, "pointer-events-auto absolute bottom-0 left-1/2", drag.dragging ? "cursor-grabbing" : undefined)}
          style={{ transform: `translateX(-50%) translate(${drag.dx}px, ${drag.dy}px)` }}
          role="toolbar"
          aria-label="Edit"
        >
          <button
            type="button"
            aria-label="Drag to move this toolbar"
            title="Drag to move"
            onPointerDown={drag.onGripPointerDown}
            className="flex h-7 w-4 cursor-grab items-center justify-center text-faint hover:text-muted active:cursor-grabbing"
          >
            <GripVertical aria-hidden className="size-3.5" />
          </button>
          <Sep />
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
          <Button variant="ghost" size="sm" disabled={p.finding} icon={<Link2 aria-hidden className="size-3.5" />} onClick={p.onFindConnections}>
            {p.finding ? "Finding…" : "Find connections"}
          </Button>
          <span
            className="flex items-center gap-1.5 pl-1.5 pr-1"
            title={p.indirectLocked ? "Connect a wallet to search for indirect links (shared counterparties)" : "Also flag nodes that share a counterparty, even if they never transacted directly"}
          >
            <span className={cn("text-xs", p.indirectLocked ? "text-faint" : "text-muted")}>Indirect</span>
            <Switch checked={p.indirectOn && !p.indirectLocked} disabled={p.indirectLocked} onCheckedChange={p.onIndirectOn} label="Also search for indirect (shared-counterparty) links" />
          </span>
          <Sep />
          <Button variant="primary" size="sm" className="ml-0.5" icon={<Plus aria-hidden className="size-3.5" />} onClick={p.onAdd}>
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}
