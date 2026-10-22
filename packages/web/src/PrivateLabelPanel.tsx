import { useEffect, useState } from "react";
import type { ChainId } from "@osstrace/core";
import { apiCall, notifyPrivateLabelsChanged, PRIVATE_LABELS_URL, useSession, type PrivateLabel } from "./session.ts";

export function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className="shrink-0 fill-current">
      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
    </svg>
  );
}

type PanelState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; label: PrivateLabel | null };

/**
 * The signed-in user's own private label for one address (ADR 0004): view, add, edit, remove.
 *
 * Styled deliberately unlike the public label card and the SANCTIONED badge — violet, dashed
 * border, a lock and "only visible to you" — so a personal note can't be mistaken for a sourced,
 * public claim. It never carries a source, confidence or any public badge.
 */
export default function PrivateLabelPanel({ chain, address }: { chain: ChainId; address: string }) {
  const session = useSession();
  const path = `/private-labels/${chain}/${encodeURIComponent(address)}`;
  const token = session.status === "signed-in" ? session.token : null;
  // Fetched state is tagged with the session + address it belongs to, and ignored for any other.
  // Without this, switching accounts on a shared browser would paint the previous user's label
  // for one frame before the refetch — a (brief) cross-user leak.
  const owner = `${token}|${path}`;
  const [tagged, setTagged] = useState<{ owner: string; state: PanelState } | null>(null);
  const state: PanelState = tagged?.owner === owner ? tagged.state : { status: "loading" };
  const setState = (s: PanelState): void => setTagged({ owner, state: s });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setActionError(null);
    if (!token) return;
    let cancelled = false;
    void apiCall<{ label: PrivateLabel | null }>(PRIVATE_LABELS_URL + path, { token }).then((res) => {
      if (cancelled) return;
      setTagged({
        owner: `${token}|${path}`,
        state: res.ok ? { status: "ready", label: res.body.label } : { status: "error", message: res.message },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [token, path]);

  if (!token) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-dashed border-line-strong px-4 py-2.5 text-xs text-ink-faint">
        <LockIcon /> Log in (top right) to add a private label to this address — visible only to you.
      </div>
    );
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setActionError(null);
    const res = await apiCall<{ label: PrivateLabel }>(PRIVATE_LABELS_URL + path, { method: "PUT", token, body: { label: draft } });
    setBusy(false);
    if (!res.ok) {
      setActionError(res.message);
      return;
    }
    setState({ status: "ready", label: res.body.label });
    setEditing(false);
    notifyPrivateLabelsChanged();
  }

  async function remove(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setActionError(null);
    const res = await apiCall(PRIVATE_LABELS_URL + path, { method: "DELETE", token });
    setBusy(false);
    // 404 means it was already gone (e.g. removed in another tab) — the end state is the same.
    if (!res.ok && res.status !== 404) {
      setActionError(res.message);
      return;
    }
    setState({ status: "ready", label: null });
    notifyPrivateLabelsChanged();
  }

  const current = state.status === "ready" ? state.label : null;

  return (
    <section
      aria-label="Your private label"
      className="rounded-card border border-dashed border-private/45 bg-private/[0.07] px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold uppercase tracking-wider text-private">
        <span className="flex items-center gap-1.5">
          <LockIcon /> Your private label
        </span>
        <span className="ml-auto text-[11px] font-normal normal-case tracking-normal text-private/70">only visible to you</span>
      </div>

      {state.status === "loading" && <div className="mt-2 text-sm text-ink-faint">Loading…</div>}
      {state.status === "error" && <div className="mt-2 text-sm text-danger">{state.message}</div>}

      {state.status === "ready" && !editing && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          {current ? (
            <span className="text-base italic text-private" data-testid="private-label-text">
              “{current.label}”
            </span>
          ) : (
            <span className="text-sm text-ink-faint">You haven't labelled this address.</span>
          )}
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => {
                setDraft(current?.label ?? "");
                setEditing(true);
              }}
              className="rounded-ctl border border-private/45 px-3 py-1 text-xs font-medium text-private transition-colors duration-150 hover:bg-private/15"
            >
              {current ? "Edit" : "Add private label"}
            </button>
            {current && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="btn-outline text-xs disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}

      {state.status === "ready" && editing && (
        <form onSubmit={save} className="mt-2.5 flex flex-col gap-2 sm:flex-row">
          <label className="flex-1">
            <span className="sr-only">Private label</span>
            <input
              autoFocus
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. my cold wallet"
              className="ctl w-full border-private/45 focus:border-private focus:shadow-[0_0_0_3px_rgb(183_166_248_/_0.15)]"
            />
          </label>
          <div className="flex gap-2 text-sm">
            <button
              type="submit"
              disabled={busy || draft.trim() === ""}
              className="rounded-ctl bg-private px-3 py-1.5 text-xs font-semibold text-[#140c26] transition-colors duration-150 hover:bg-[#cbbdfb] disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-ctl border border-line-strong px-3 py-1.5 text-xs font-medium text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {current && !editing && (
        <div className="mt-1.5 text-[11px] text-ink-faint">
          Saved {new Date(current.updatedAt).toLocaleString()} · not a public label, has no source, never shared
        </div>
      )}
      {actionError && (
        <div className="mt-2 text-xs text-danger" role="alert">
          {actionError}
        </div>
      )}
    </section>
  );
}
