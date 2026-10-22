import { useEffect, useRef, useSyncExternalStore } from "react";
import { OptimisticDocumentStore, type OptimisticConfig, type Snapshot } from "./store.ts";

export type UseOptimisticDocumentArgs<D, O> = OptimisticConfig<D, O> & {
  /** Latest server copy (or the initial scratch document) and its updatedAt. */
  remote: D | null | undefined;
  remoteUpdatedAt: string | null | undefined;
  /** Changing the key resets the store (another document). */
  documentKey: string;
};

/**
 * React binding for OptimisticDocumentStore. The store lives for the lifetime of `documentKey`;
 * config callbacks are refreshed every render so they may close over fresh state.
 */
export function useOptimisticDocument<D, O>(args: UseOptimisticDocumentArgs<D, O>): { store: OptimisticDocumentStore<D, O>; snap: Snapshot<D> } {
  const { remote, remoteUpdatedAt, documentKey, ...cfg } = args;
  const ref = useRef<{ key: string; store: OptimisticDocumentStore<D, O> } | null>(null);
  if (!ref.current || ref.current.key !== documentKey) {
    ref.current = { key: documentKey, store: new OptimisticDocumentStore<D, O>(cfg) };
  }
  const store = ref.current.store;
  store.configure(cfg);

  const seeded = useRef<{ store: unknown; doc: unknown } | null>(null);
  useEffect(() => {
    if (remote == null || remoteUpdatedAt == null) return;
    if (seeded.current?.store === store && seeded.current.doc === remote) return;
    // scratch documents are seeded once; later "remote" changes come from the store itself
    if (cfg.localOnly && seeded.current?.store === store) return;
    seeded.current = { store, doc: remote };
    store.setRemote(remote, remoteUpdatedAt);
  }, [store, remote, remoteUpdatedAt, cfg.localOnly]);

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, snap };
}
