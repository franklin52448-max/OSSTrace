import type { NodeColor, TraceNode } from "@osstrace/contract";
import { memo, type CSSProperties, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from "react";
import { cn } from "../../kit/cn.ts";
import { formatUsd, shortAddress } from "../../kit/format.ts";
import { useBalances } from "../api.ts";
import { NODE_WIDTH, nodeSize, type Viewport } from "../lib/viewport.ts";
import { ChainIcon } from "../../ChainSelect.tsx";

export const NODE_COLORS: { value: NodeColor; label: string }[] = [
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "amber", label: "Amber" },
  { value: "red", label: "Red" },
  { value: "purple", label: "Purple" },
  { value: "gray", label: "Gray" },
];

/** Title rules: "Entity: Label (abcde)" / "Entity (abcde)" / "Label (abcde)" / raw address / "Unknown address". */
export function nodeTitle(n: TraceNode): { title: string; mono: boolean } {
  if (n.kind === "entity") return { title: n.displayEntity?.name ?? "Entity", mono: false };
  const info = n.displayAddress;
  const addr = n.address ?? info?.address;
  if (!addr) return { title: "Unknown address", mono: false };
  const tail = addr.startsWith("0x") ? addr.slice(2, 7) : addr.slice(0, 5);
  const ent = info?.entity?.name;
  const label = info?.label?.name;
  if (ent && label && label !== ent) return { title: `${ent}: ${label} (${tail})`, mono: false };
  if (ent) return { title: `${ent} (${tail})`, mono: false };
  if (label) return { title: `${label} (${tail})`, mono: false };
  return { title: addr, mono: true };
}

function Avatar({ node }: { node: TraceNode }) {
  const entity = node.kind === "entity";
  return (
    <span aria-hidden className={cn("kit-node-tile flex size-10 shrink-0 items-center justify-center rounded-[7px]", entity && "text-[16px] font-semibold")}>
      {entity ? (node.displayEntity?.name ?? "E").slice(0, 1).toUpperCase() : <ChainIcon chain={node.chain === "solana" ? "solana" : "ethereum"} size={20} />}
    </span>
  );
}

function Balance({ node, enabled }: { node: TraceNode; enabled: boolean }) {
  const q = useBalances(node.chain, node.address, enabled && node.kind === "address");
  if (node.kind === "entity") return <span className="truncate text-xs text-muted">Entity{node.displayEntity?.type ? ` · ${node.displayEntity.type}` : ""}</span>;
  if (q.isPending && enabled) return <span className="kit-skeleton inline-block h-3 w-16" aria-label="Loading balance" />;
  const v = q.data?.totalUsd;
  const text = v == null ? "—" : v < 0.01 && v > 0 ? "$0.00" : formatUsd(v);
  return (
    <span className={cn("kit-num text-[13px]", v == null ? "text-faint" : "text-text")} title={q.error ? "Balance unavailable from the provider" : v == null ? "No priced balance" : "Current balance (priced tokens only)"}>
      {text}
    </span>
  );
}

export type NodeCardProps = {
  node: TraceNode;
  viewport: Viewport;
  selected: boolean;
  editable: boolean;
  /** live resize preview width (world units) */
  previewWidth?: number;
  onPointerDown: (e: RPointerEvent, node: TraceNode) => void;
  onContextMenu: (e: RMouseEvent, node: TraceNode) => void;
  onResizeStart: (e: RPointerEvent, node: TraceNode) => void;
  onActivate: (node: TraceNode, additive: boolean) => void;
  loadBalances: boolean;
};

/** One canvas card: fixed 254x72 layout scaled uniformly by viewport.scale * customWidth/254. */
export const NodeCard = memo(function NodeCard({ node, viewport, selected, editable, previewWidth, onPointerDown, onContextMenu, onResizeStart, onActivate, loadBalances }: NodeCardProps) {
  const size = nodeSize(node);
  const w = previewWidth ?? size.w;
  const k = viewport.scale * (w / NODE_WIDTH);
  const sx = viewport.x + node.currentPosition.x * viewport.scale;
  const sy = viewport.y + node.currentPosition.y * viewport.scale;
  const { title, mono } = nodeTitle(node);
  const chainLabel = node.kind === "address" ? (node.chain === "solana" ? "Solana" : "Ethereum") : "Entity";
  const hash = !mono && node.kind === "address" && node.address ? shortAddress(node.address, node.address.startsWith("0x") ? 6 : 4, 4) : null;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${chainLabel} node ${title}`}
      data-node-id={node.id}
      data-kind={node.kind}
      data-color={node.color || undefined}
      onPointerDown={(e) => onPointerDown(e, node)}
      onContextMenu={(e) => onContextMenu(e, node)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(node, e.shiftKey);
        }
      }}
      className="kit-node absolute left-0 top-0 flex select-none items-center gap-3 px-3 py-2.5"
      style={{
        width: NODE_WIDTH,
        height: (size.h / size.w) * NODE_WIDTH,
        transform: `translate(${sx}px, ${sy}px) scale(${k})`,
        transformOrigin: "top left",
        willChange: "transform",
        ...(node.color ? ({ "--traceg-node": `var(--trace-node-${node.color})` } as CSSProperties) : null),
      }}
    >
      <Avatar node={node} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className={cn("truncate text-[13.5px] font-semibold leading-tight text-text", mono && "kit-mono text-[12.5px] font-medium tracking-[-0.01em]")} title={node.address ?? title}>
          {mono ? shortAddress(title, 8, 6) : title}
        </span>
        <span className="flex min-w-0 items-baseline justify-between gap-2 leading-tight">
          <Balance node={node} enabled={loadBalances} />
          {hash ? <span className="kit-mono truncate text-[11px] text-faint">{hash}</span> : null}
        </span>
      </span>
      {editable && selected ? (
        <span
          role="presentation"
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(e, node);
          }}
          title="Drag to resize"
          className="absolute -bottom-[5px] -right-[5px] size-3 cursor-nwse-resize rounded-[3px] border border-accent bg-surface"
        />
      ) : null}
    </div>
  );
});
