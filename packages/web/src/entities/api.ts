import type { Entity } from "@osstrace/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../kit/api.ts";

export const entityKeys = {
  all: ["labels", "entities"] as const,
};

export function useEntities() {
  return useQuery({ queryKey: entityKeys.all, queryFn: () => api<Entity[]>("/entities"), staleTime: 30_000 });
}
