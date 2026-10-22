import type { CreateEntity, CreateLabel, CreateTag, Entity, ImportResult, Label, LabelsQuery, LabelsResponse, Tag } from "@osstrace/contract";
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../kit/api.ts";

export type EntityDetail = Entity & { addresses: Label[] };

export const labelKeys = {
  all: ["labels"] as const,
  list: (q: LabelsQuery) => ["labels", "list", q] as const,
  entities: ["labels", "entities"] as const,
  entity: (id: string) => ["labels", "entities", id] as const,
  tags: ["labels", "tags"] as const,
};

/** Labels feed every AddressInfo, so a label change invalidates address/search/transfer views too. */
function invalidateLabelData(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: labelKeys.all }),
    qc.invalidateQueries({ queryKey: ["address"] }),
    qc.invalidateQueries({ queryKey: ["search"] }),
  ]);
}

export function useLabels(q: LabelsQuery) {
  return useQuery({
    queryKey: labelKeys.list(q),
    queryFn: () => api<LabelsResponse>("/labels", { query: q as Record<string, string | number | undefined> }),
    placeholderData: keepPreviousData,
  });
}

export function useCreateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLabel) => api<Label>("/labels", { method: "POST", json: body }),
    onSuccess: () => invalidateLabelData(qc),
  });
}

export function useUpdateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CreateLabel> & { id: string }) => api<Label>(`/labels/${encodeURIComponent(id)}`, { method: "PATCH", json: body }),
    onSuccess: () => invalidateLabelData(qc),
  });
}

export function useDeleteLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/labels/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateLabelData(qc),
  });
}

export type ImportRequest = { format: "csv" | "json"; data: string; onConflict: "update" | "skip" };

export function useImportLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportRequest) => api<ImportResult>("/labels/import", { method: "POST", json: body }),
    onSuccess: () => invalidateLabelData(qc),
  });
}

export function useEntities() {
  return useQuery({ queryKey: labelKeys.entities, queryFn: () => api<Entity[]>("/entities"), staleTime: 30_000 });
}

export function useEntity(id: string | null | undefined) {
  return useQuery({ queryKey: labelKeys.entity(id ?? ""), queryFn: () => api<EntityDetail>(`/entities/${encodeURIComponent(id!)}`), enabled: !!id });
}

export function useCreateEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEntity) => api<Entity>("/entities", { method: "POST", json: body }),
    onSuccess: () => invalidateLabelData(qc),
  });
}

export function useUpdateEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CreateEntity> & { id: string }) => api<Entity>(`/entities/${encodeURIComponent(id)}`, { method: "PATCH", json: body }),
    onSuccess: () => invalidateLabelData(qc),
  });
}

export function useDeleteEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/entities/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateLabelData(qc),
  });
}

export function useTags() {
  return useQuery({ queryKey: labelKeys.tags, queryFn: () => api<Tag[]>("/tags"), staleTime: 30_000 });
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTag) => api<Tag>("/tags", { method: "POST", json: body }),
    onSuccess: () => invalidateLabelData(qc),
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CreateTag> & { id: string }) => api<Tag>(`/tags/${encodeURIComponent(id)}`, { method: "PATCH", json: body }),
    onSuccess: () => invalidateLabelData(qc),
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/tags/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateLabelData(qc),
  });
}
