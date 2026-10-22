import type { AlertEvent, AlertLimits, AlertRule, CreateAlertRule, Notification } from "@osstrace/contract";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../kit/api.ts";

export type NotificationsPage = { notifications: Notification[]; nextCursor: string | null; unreadCount: number };
export type EventsPage = { events: AlertEvent[]; nextCursor: string | null };

export const alertKeys = {
  all: ["alerts"] as const,
  list: ["alerts", "list"] as const,
  one: (id: string) => ["alerts", "one", id] as const,
  events: (id: string) => ["alerts", "events", id] as const,
  limits: ["alerts", "limits"] as const,
  notifications: ["notifications"] as const,
  inbox: (unreadOnly: boolean) => ["notifications", "inbox", unreadOnly] as const,
  unread: ["notifications", "unread"] as const,
};

export function useAlerts() {
  return useQuery({ queryKey: alertKeys.list, queryFn: () => api<AlertRule[]>("/alerts") });
}

export function useAlert(id: string | undefined) {
  return useQuery({ queryKey: alertKeys.one(id ?? ""), queryFn: () => api<AlertRule>(`/alerts/${encodeURIComponent(id!)}`), enabled: !!id });
}

export function useAlertLimits() {
  return useQuery({ queryKey: alertKeys.limits, queryFn: () => api<AlertLimits>("/alerts/limits"), staleTime: 10 * 60_000 });
}

export function useAlertEvents(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: alertKeys.events(id ?? ""),
    queryFn: ({ pageParam }) => api<EventsPage>(`/alerts/${encodeURIComponent(id!)}/events`, { query: { limit: 25, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!id,
  });
}

export function useCreateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAlertRule) => api<AlertRule>("/alerts", { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: alertKeys.all }),
  });
}

export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CreateAlertRule> & { id: string }) => api<AlertRule>(`/alerts/${encodeURIComponent(id)}`, { method: "PATCH", json: body }),
    onSuccess: (rule) => {
      qc.setQueryData(alertKeys.one(rule.id), rule);
      return qc.invalidateQueries({ queryKey: alertKeys.list });
    },
  });
}

export function useDeleteAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/alerts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: alertKeys.all }),
  });
}

/** Unread count for the bell. Polls every 30s while the tab is open. */
export function useUnreadCount(enabled: boolean) {
  return useQuery({
    queryKey: alertKeys.unread,
    queryFn: () => api<NotificationsPage>("/notifications", { query: { unread: 1, limit: 5 } }),
    enabled,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useInbox(unreadOnly: boolean) {
  return useInfiniteQuery({
    queryKey: alertKeys.inbox(unreadOnly),
    queryFn: ({ pageParam }) =>
      api<NotificationsPage>("/notifications", { query: { unread: unreadOnly ? 1 : undefined, limit: 30, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000,
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) => api<void>("/notifications/read", { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: alertKeys.notifications }),
  });
}
