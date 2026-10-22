import type { CreateNotificationMethod, NotificationMethod, Settings, UpdateSettingsRequest } from "@osstrace/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../kit/api.ts";

export const settingsKeys = {
  settings: ["settings"] as const,
  methods: ["settings", "notification-methods"] as const,
};

export function useSettings(enabled = true) {
  return useQuery({ queryKey: settingsKeys.settings, queryFn: () => api<Settings>("/settings"), enabled, staleTime: 60_000 });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSettingsRequest) => api<Settings>("/settings", { method: "PATCH", json: body }),
    onSuccess: (s) => qc.setQueryData(settingsKeys.settings, s),
  });
}

export function useNotificationMethods() {
  return useQuery({ queryKey: settingsKeys.methods, queryFn: () => api<NotificationMethod[]>("/settings/notification-methods") });
}

export function useCreateNotificationMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateNotificationMethod) => api<NotificationMethod>("/settings/notification-methods", { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.methods }),
  });
}

export function useUpdateNotificationMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; enabled?: boolean; url?: string }) =>
      api<NotificationMethod>(`/settings/notification-methods/${encodeURIComponent(id)}`, { method: "PATCH", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.methods }),
  });
}

export function useDeleteNotificationMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/settings/notification-methods/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.methods }),
  });
}

export type MethodTestResult = { ok: boolean; status: number | string | null };

export function useTestNotificationMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<MethodTestResult>(`/settings/notification-methods/${encodeURIComponent(id)}/test`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: settingsKeys.methods }),
  });
}
