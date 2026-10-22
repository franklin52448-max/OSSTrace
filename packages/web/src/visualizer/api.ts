import type { BatchResult, Entity, Label, TransfersResponse, VisualizerOp, VisualizerState, VisualizerView, VisualizerViewSummary } from "@osstrace/contract";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../kit/api.ts";
import { toSearchParams } from "../panels/model.ts";

export const viewKeys = {
  all: ["graph", "views"] as const,
  one: (id: string, pub: boolean) => ["graph", "view", id, pub ? "public" : "owner"] as const,
  canvas: (q: unknown) => ["graph", "canvas-transfers", q] as const,
  entity: (id: string) => ["graph", "entity", id] as const,
};

export function useViews() {
  return useQuery({ queryKey: viewKeys.all, queryFn: () => api<VisualizerViewSummary[]>("/views"), staleTime: 15_000 });
}

export function useView(id: string | undefined, readOnly: boolean) {
  return useQuery({
    queryKey: viewKeys.one(id ?? "", readOnly),
    queryFn: () => api<VisualizerView>(readOnly ? `/public/views/${encodeURIComponent(id!)}` : `/views/${encodeURIComponent(id!)}`),
    enabled: !!id,
    retry: 0,
    refetchOnWindowFocus: false,
  });
}

export function useCreateView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; state: VisualizerState }) => api<{ id: string }>("/views", { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: viewKeys.all }),
  });
}

export function useDeleteView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/views/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: viewKeys.all }),
  });
}

export const postViewBatch = (id: string, ops: VisualizerOp[]) => api<BatchResult>(`/views/${encodeURIComponent(id)}/batch`, { method: "POST", json: { ops } });

/** ONE request, limit 1000. */
export function useCanvasTransfers(q: Record<string, unknown> & { base: string[] }, enabled: boolean) {
  return useQuery({
    queryKey: viewKeys.canvas(q),
    queryFn: ({ signal }) => api<TransfersResponse>("/transfers", { query: toSearchParams(q as never), signal }),
    enabled: enabled && q.base.length > 0,
    staleTime: 30_000,
    retry: 0,
  });
}

/** Addresses of every entity in the base (entity bases are expanded client-side into address bases). */
export function useEntityAddresses(ids: string[], enabled: boolean) {
  const qs = useQueries({
    queries: ids.map((id) => ({
      queryKey: viewKeys.entity(id),
      queryFn: () => api<Entity & { addresses: Label[] }>(`/entities/${encodeURIComponent(id)}`),
      enabled,
      staleTime: 60_000,
      retry: 0,
    })),
  });
  const map = new Map<string, string[]>();
  const names = new Map<string, string>();
  ids.forEach((id, i) => {
    const d = qs[i]?.data;
    if (d) {
      map.set(id, d.addresses.map((l) => `${l.chain}:${l.address}`));
      names.set(id, d.name);
    }
  });
  return { map, names, loading: qs.some((q) => q.isPending && enabled), error: qs.find((q) => q.error)?.error };
}
