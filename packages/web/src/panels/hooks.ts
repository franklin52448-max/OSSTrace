import type { Chain, Counterparty, SyncStatus, TransfersResponse } from "@osstrace/contract";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../kit/api.ts";
import { counterpartiesQuery, toSearchParams, transfersQuery, type CounterpartyFilter, type TransferFilter } from "./model.ts";

type CounterpartiesResponse = { counterparties: Counterparty[]; sync: SyncStatus };

export const panelKeys = {
  counterparties: (chain: Chain, address: string, flow: "in" | "out", f: CounterpartyFilter) =>
    ["graph", "counterparties", chain, address, flow, f.timeLast, f.usdGte] as const,
  transfers: (q: unknown) => ["graph", "transfers", q] as const,
};

/** Two requests (in and out), merged by the caller. */
export function useCounterparties(chain: Chain, address: string, filter: CounterpartyFilter) {
  const mk = (flow: "in" | "out") => ({
    queryKey: panelKeys.counterparties(chain, address, flow, filter),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<CounterpartiesResponse>(`/address/${chain}/${encodeURIComponent(address)}/counterparties`, { query: toSearchParams(counterpartiesQuery(filter, flow)), signal }),
    staleTime: 30_000,
    retry: 0,
    placeholderData: keepPreviousData,
  });
  const inQ = useQuery(mk("in"));
  const outQ = useQuery(mk("out"));
  return { inQ, outQ };
}

export function useTransfers(args: { base: string[]; counterparties?: string[] | null; filter: TransferFilter; cursor?: string | null; enabled?: boolean }) {
  const q = transfersQuery(args);
  return useQuery({
    queryKey: panelKeys.transfers(q),
    queryFn: ({ signal }) => api<TransfersResponse>("/transfers", { query: toSearchParams(q), signal }),
    enabled: (args.enabled ?? true) && args.base.length > 0,
    staleTime: 30_000,
    retry: 0,
    placeholderData: keepPreviousData,
  });
}

/** Worst-of two sync statuses (error > partial > syncing > ready). */
export function mergeSync(a?: SyncStatus, b?: SyncStatus): SyncStatus | undefined {
  if (!a) return b;
  if (!b) return a;
  const rank = { ready: 0, syncing: 1, partial: 2, error: 3 } as const;
  const worst = rank[a.state] >= rank[b.state] ? a : b;
  const covered = [a.coveredFrom, b.coveredFrom].filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { ...worst, coveredFrom: covered };
}
