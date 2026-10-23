import { entityNodeId, type TraceOp, type TraceSummary } from "@osstrace/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useServerSession } from "../serverSession.ts";
import { useSafeToast } from "../panels/parts.tsx";
import { postTraceBatch, traceKeys, useCreateTrace, useDeleteTrace, useTraces } from "./api.ts";
import { ShareDialog, type AddTarget } from "./dialogs.tsx";
import { DocList, type DocListItem } from "./home/DocList.tsx";
import { HomeMain } from "./home/HomeMain.tsx";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function traceListItem(t: TraceSummary): DocListItem {
  const nodes = t.addressCount + t.entityCount;
  return {
    id: t.uuid,
    title: t.title,
    href: `#trace/doc/${t.uuid}`,
    updatedAt: t.updatedAt,
    shareable: t.shareable,
    meta: (
      <span title={`${t.addressCount} addresses, ${t.entityCount} entities`}>
        {plural(nodes, "node")} · {plural(t.transferCount, "transfer")}
      </span>
    ),
  };
}

/** Tracer home: the trace list as a page sidebar, a large "start a trace" search, recent traces. */
export function TracerHome() {
  const session = useServerSession();
  const signedIn = session.status === "signed-in";
  const traces = useTraces(signedIn);
  const create = useCreateTrace();
  const del = useDeleteTrace();
  const qc = useQueryClient();
  const toast = useSafeToast();
  const [share, setShare] = useState<TraceSummary | null>(null);

  const start = async (t: AddTarget | null) => {
    // Anon mode (ADR 0025): no account to save a trace to, so this opens a local-only scratch
    // canvas instead -- the same shape the Visualizer's own anon mode already uses. A plain
    // navigation, not an API call, so it already works signed out.
    if (!signedIn) {
      if (!t) window.location.hash = "#trace/scratch";
      else if (t.type === "address") window.location.hash = `#trace/${t.chain}/${encodeURIComponent(t.address)}`;
      else toast.error("Connect a wallet to start a trace from an entity.");
      return;
    }
    try {
      if (!t) {
        const { id } = await create.mutateAsync({});
        window.location.hash = `#trace/doc/${id}`;
      } else if (t.type === "address") {
        const { id } = await create.mutateAsync({ initialAddress: t.address, initialChain: t.chain });
        window.location.hash = `#trace/doc/${id}`;
      } else {
        const { id } = await create.mutateAsync({ title: t.name });
        const node = { id: entityNodeId(id, t.id), kind: "entity" as const, currentPosition: { x: 0, y: 0 }, createdAt: new Date().toISOString(), entityID: t.id, displayEntity: { id: t.id, name: t.name, source: "user" } };
        try {
          await postTraceBatch(id, [{ type: "create_node", node }]);
        } catch {
          toast.error("The trace was created, but adding the entity failed.");
        }
        window.location.hash = `#trace/doc/${id}`;
      }
    } catch (e) {
      toast.error(e);
    }
  };

  const rows = traces.data;
  const items = useMemo(() => rows?.map(traceListItem), [rows]);
  const recent = useMemo(() => [...(items ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3), [items]);
  const byId = useMemo(() => new Map((rows ?? []).map((t) => [t.uuid, t])), [rows]);
  const shareLive = share ? (byId.get(share.uuid) ?? share) : null;

  return (
    <div className="flex min-h-full flex-col md:h-full md:flex-row">
      <DocList
        title="Traces"
        noun="trace"
        items={items}
        error={traces.error}
        onRetry={() => void traces.refetch()}
        signedOut={!signedIn}
        newLabel={signedIn ? "New trace" : "New scratch trace"}
        newPending={create.isPending}
        onNew={() => void start(null)}
        actions={(it) => [
          { key: "share", label: "Share", onSelect: () => setShare(byId.get(it.id) ?? null) },
        ]}
        onDelete={(it) => del.mutateAsync(it.id)}
        emptyText="No traces yet. Start one from an address with the search on the right; every edit saves as you go."
        className="max-h-[50vh] border-b md:max-h-none md:w-[var(--trace-sidebar-w,300px)] md:shrink-0 md:border-b-0 md:border-r"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <HomeMain
          title="Tracer"
          lede="Follow funds hop by hop on a canvas you arrange."
          searchLabel="Start a trace from an address, label or entity"
          placeholder="Start a trace: address, label or entity"
          onPick={(t) => void start(t)}
          busy={create.isPending}
          busyText="Creating trace…"
          recent={recent}
          recentLabel="Recently edited"
          noun="trace"
        />
      </div>
      {shareLive ? (
        <ShareDialog
          open
          onOpenChange={(o) => !o && setShare(null)}
          shareable={shareLive.shareable}
          url={`${window.location.origin}/#trace/view/${shareLive.uuid}`}
          onShareable={async (shareable) => {
            try {
              await postTraceBatch(shareLive.uuid, [{ type: "set_shareable", shareable } as TraceOp]);
              await qc.invalidateQueries({ queryKey: traceKeys.all });
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
