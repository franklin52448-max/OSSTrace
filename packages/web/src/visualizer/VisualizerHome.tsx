import type { VisualizerViewSummary } from "@osstrace/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { clientTimestamp } from "../optimistic/index.ts";
import { useServerSession } from "../serverSession.ts";
import { useSafeToast } from "../panels/parts.tsx";
import { ShareDialog } from "../tracer/dialogs.tsx";
import { DocList, type DocListItem } from "../tracer/home/DocList.tsx";
import { HomeMain } from "../tracer/home/HomeMain.tsx";
import { postViewBatch, useDeleteView, useViews, viewKeys } from "./api.ts";

export const viewListItem = (v: VisualizerViewSummary): DocListItem => ({ id: v.id, title: v.name, href: `#graph/saved/${v.id}`, updatedAt: v.updatedAt, shareable: v.shareable, meta: v.shareable ? "public" : "private" });

/** Visualizer home: saved views as a page sidebar, a large search that opens a scratch view, recent views.
 * The scratch view itself (anon mode, ADR 0024) needs no account at all -- "New scratch view" below is a
 * plain navigation, not an API call, so it already works signed out. */
export function VisualizerHome() {
  const signedIn = useServerSession().status === "signed-in";
  const views = useViews(signedIn);
  const del = useDeleteView();
  const qc = useQueryClient();
  const toast = useSafeToast();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [share, setShare] = useState<string | null>(null);
  const rows = views.data;
  const items = useMemo(() => rows?.map(viewListItem), [rows]);
  const recent = useMemo(() => [...(items ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3), [items]);
  const shareView = share ? rows?.find((v) => v.id === share) : undefined;
  const batch = async (id: string, ops: Parameters<typeof postViewBatch>[1]) => {
    await postViewBatch(id, ops);
    await qc.invalidateQueries({ queryKey: viewKeys.all });
  };

  return (
    <div className="flex min-h-full flex-col md:h-full md:flex-row">
      <DocList
        title="Views"
        noun="view"
        items={items}
        error={views.error}
        onRetry={() => void views.refetch()}
        signedOut={!signedIn}
        newLabel="New scratch view"
        onNew={() => (window.location.hash = "#graph/scratch")}
        actions={(it) => [
          { key: "rename", label: "Rename", onSelect: () => setRenaming(it.id) },
          { key: "share", label: "Share", onSelect: () => setShare(it.id) },
        ]}
        onDelete={(it) => del.mutateAsync(it.id)}
        renamingId={renaming}
        onRename={(it, name) => batch(it.id, [{ type: "set_name", name, clientTimestamp: clientTimestamp() }])}
        onRenameEnd={() => setRenaming(null)}
        emptyText="No saved views yet. Open a scratch view from the search, then save it to keep its filters and pins."
        className="max-h-[50vh] border-b md:max-h-none md:w-[var(--trace-sidebar-w,300px)] md:shrink-0 md:border-b-0 md:border-r"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <HomeMain
          title="Visualizer"
          lede="See who an address or entity transacts with, as a graph."
          searchLabel="Open a scratch view for an address, label or entity"
          placeholder="Visualize: address, label or entity"
          onPick={(t) => (window.location.hash = `#graph/scratch?base=${encodeURIComponent(t.type === "entity" ? `entity:${t.id}` : `${t.chain}:${t.address}`)}`)}
          recent={recent}
          recentLabel="Recently edited"
          noun="view"
          footnote="Scratch views live in the URL until you save them."
        />
      </div>
      {shareView ? (
        <ShareDialog
          kind="view"
          open
          onOpenChange={(o) => !o && setShare(null)}
          shareable={shareView.shareable}
          url={`${window.location.origin}/#graph/public/${shareView.id}`}
          onShareable={async (shareable) => {
            try {
              await batch(shareView.id, [{ type: "set_shareable", shareable, clientTimestamp: clientTimestamp() }]);
              return true;
            } catch (e) {
              toast.error(e);
              return false;
            }
          }}
        />
      ) : null}
    </div>
  );
}
