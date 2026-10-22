import type { AddressInfo, Chain } from "@osstrace/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

export const addressKeys = {
  info: (chain: Chain, address: string) => ["address", chain, address, "info"] as const,
};

export function useAddressInfo(chain: Chain, address: string) {
  return useQuery({ queryKey: addressKeys.info(chain, address), queryFn: () => api<AddressInfo>(`/address/${chain}/${encodeURIComponent(address)}`), staleTime: 60_000 });
}
