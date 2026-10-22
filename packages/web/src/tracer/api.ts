import type {
  AggregateSummaryResponse,
  BalancesResponse,
  BatchResult,
  Chain,
  CreateTraceRequest,
  Entity,
  Label,
  SearchHit,
  Trace,
  TraceEdge,
  TraceOp,
  TraceSummary,
} from "@osstrace/contract";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../kit/api.ts";

export const traceKeys = {
  all: ["graph", "traces"] as const,
  one: (id: string, pub: boolean) => ["graph", "trace", id, pub ? "public" : "owner"] as const,
  summary: (id: string, a: string, b: string) => ["graph", "trace", id, "aggregate-summary", a, b] as const,
  balances: (chain: Chain, address: string) => ["graph", "balances", chain, address] as const,
  search: (q: string) => ["graph", "search", q] as const,
  entity: (id: string) => ["graph", "entity", id] as const,
};

export function useTraces() {
  return useQuery({ queryKey: traceKeys.all, queryFn: () => api<TraceSummary[]>("/traces"), staleTime: 15_000 });
}

export function useTrace(id: string, readOnly: boolean) {
  return useQuery({
    queryKey: traceKeys.one(id, readOnly),
    queryFn: () => api<Trace>(readOnly ? `/public/traces/${encodeURIComponent(id)}` : `/traces/${encodeURIComponent(id)}`),
    refetchOnWindowFocus: false,
    retry: 0,
  });
}

export function useCreateTrace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTraceRequest) => api<{ id: string }>("/traces", { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: traceKeys.all }),
  });
}

export function useDeleteTrace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/traces/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: traceKeys.all }),
  });
}

export const postTraceBatch = (id: string, ops: TraceOp[]) => api<BatchResult>(`/traces/${encodeURIComponent(id)}/batch`, { method: "POST", json: { ops } });

export const refreshTraceEdge = (id: string, edgeId: string) =>
  api<TraceEdge>(`/traces/${encodeURIComponent(id)}/edges/${encodeURIComponent(edgeId)}/refresh`, { method: "POST" });

export function useAggregateSummary(traceId: string, a: string | null, b: string | null, enabled: boolean) {
  return useQuery({
    queryKey: traceKeys.summary(traceId, a ?? "", b ?? ""),
    queryFn: () => api<AggregateSummaryResponse>(`/traces/${encodeURIComponent(traceId)}/aggregate-summary`, { method: "POST", json: { fromNodeID: a, toNodeID: b } }),
    enabled: enabled && !!a && !!b,
    staleTime: 60_000,
    retry: 0,
  });
}

export function useBalances(chain: Chain | undefined, address: string | undefined, enabled = true) {
  return useQuery({
    queryKey: traceKeys.balances(chain ?? "ethereum", address ?? ""),
    queryFn: () => api<BalancesResponse>(`/address/${chain}/${encodeURIComponent(address!)}/balances`),
    enabled: enabled && !!chain && !!address,
    staleTime: 60_000,
    retry: 0,
  });
}

export function useSearchHits(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: traceKeys.search(term),
    queryFn: ({ signal }) => api<{ hits: SearchHit[] }>("/search", { query: { q: term, limit: 12 }, signal }),
    enabled: term.length > 0,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useEntity(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: traceKeys.entity(id ?? ""),
    queryFn: () => api<Entity & { addresses: Label[] }>(`/entities/${encodeURIComponent(id!)}`),
    enabled: enabled && !!id,
    staleTime: 60_000,
    retry: 0,
  });
}

export const saveLabel = (args: { id?: string; chain: Chain; address: string; name: string }) =>
  args.id
    ? api<Label>(`/labels/${encodeURIComponent(args.id)}`, { method: "PATCH", json: { name: args.name } })
    : api<Label>("/labels", { method: "POST", json: { chain: args.chain, address: args.address, name: args.name } });
