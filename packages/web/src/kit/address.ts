import type { AddressInfo, BalancesResponse, Chain } from "@osstrace/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

export const addressKeys = {
  info: (chain: Chain, address: string) => ["address", chain, address, "info"] as const,
  balances: (chain: Chain, address: string) => ["address", chain, address, "balances"] as const,
};

export function useAddressInfo(chain: Chain, address: string) {
  return useQuery({ queryKey: addressKeys.info(chain, address), queryFn: () => api<AddressInfo>(`/address/${chain}/${encodeURIComponent(address)}`), staleTime: 60_000 });
}

export function useBalances(chain: Chain, address: string) {
  return useQuery({
    queryKey: addressKeys.balances(chain, address),
    queryFn: () => api<BalancesResponse>(`/address/${chain}/${encodeURIComponent(address)}/balances`),
    staleTime: 60_000,
    retry: 0,
  });
}
