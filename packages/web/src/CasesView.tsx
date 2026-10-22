import { useCallback, useEffect, useState } from "react";
import type { ChainId } from "@osstrace/core";
import { LockIcon } from "./PrivateLabelPanel.tsx";
import { apiCall, useSession } from "./session.ts";

const CASES_URL = import.meta.env["VITE_CASES_URL"] ?? "http://localhost:5314";

// --- The case-management API's response shapes (see packages/features/case-management/README.md) ---
type CaseStatus = "open" | "closed";
interface CaseView {
  id: string;
  title: string;
  description: string;
  status: CaseStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
type CaseSummary = CaseView & { itemCount: number };
interface CaseItem {
  id: string;
  caseId: string;
  chain: ChainId;
  address: string;
  note: string;
  addedAt: string;
  updatedAt: string;
}

const STATUS_CLASS: Record<CaseStatus, string> = {
  open: "border-signal/35 bg-signal/10 text-signal",
  closed: "border-line bg-raised text-ink-faint",
};

const errorBox = "rounded-card border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger";

type ListState = { status: "loading" } | { status: "error"; message: string } | { status: "done"; cases: CaseSummary[] };

/**
 * Your own private cases (ADR 0011): group real addresses, each with your own note, into a record
 * only you can see. Every fetched state here is tagged with the session token it was fetched for
 * and ignored under any other — same rule as PrivateLabelPanel — so switching accounts in one
 * browser can't paint the previous user's cases for even one frame.
 */
export default function CasesView() {
  const session = useSession();
  const token = session.status === "signed-in" ? session.token : null;
  const [tagged, setTagged] = useState<{ owner: string | null; list: ListState } | null>(null);
  const list: ListState = tagged?.owner === token ? tagged.list : { status: "loading" };
  const [selected, setSelected] = useState<{ owner: string; id: string } | null>(null);
  const selectedId = selected?.owner === token ? selected.id : null;
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await apiCall<{ cases: CaseSummary[] }>(`${CASES_URL}/cases`, { token });
    setTagged({ owner: token, list: res.ok ? { status: "done", cases: res.body.cases } : { status: "error", message: res.message } });
  }, [token]);

  useEffect(() => {
    setShowNew(false);
    void load();
  }, [load]);

  if (!token) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <Header />
        <div className="flex items-center gap-2 rounded-card border border-dashed border-line-strong px-4 py-2.5 text-xs text-ink-faint">
          <LockIcon /> Log in (in the sidebar) to open a case. Cases are private — only you can ever see yours.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Header />
        {!selectedId && (
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={() => void load()} className="btn-outline">
              Refresh
            </button>
            <button type="button" onClick={() => setShowNew((v) => !v)} className="btn-accent">
              {showNew ? "Cancel" : "New case"}
            </button>
          </div>
        )}
      </div>

      {showNew && !selectedId && (
        <NewCaseForm
          token={token}
          onCreated={(id) => {
            setShowNew(false);
            void load();
            setSelected({ owner: token, id });
          }}
        />
      )}

      {selectedId ? (
        <CaseDetail
          key={`${token}|${selectedId}`}
          token={token}
          caseId={selectedId}
          onBack={() => {
            setSelected(null);
            void load();
          }}
        />
      ) : (
        <CaseList list={list} onSelect={(id) => setSelected({ owner: token, id })} />
      )}
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Cases</h1>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs leading-relaxed text-ink-faint">
        <span className="text-private">
          <LockIcon />
        </span>
        Group addresses and your own notes into an investigation record. Private to you — not shared with anyone, including
        moderators and admins (ADR 0011).
      </p>
    </div>
  );
}

function CaseList({ list, onSelect }: { list: ListState; onSelect: (id: string) => void }) {
  if (list.status === "loading") return <div className="text-sm text-ink-faint">Loading…</div>;
  if (list.status === "error") {
    return (
      <div role="alert" className="rounded-card border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger">
        {list.message}
      </div>
    );
  }
  if (list.cases.length === 0) {
    return <div className="card px-4 py-6 text-center text-sm text-ink-faint">You have no cases yet.</div>;
  }
  return (
    <div className="space-y-2">
      {list.cases.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(c.id)}
          className="card flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-raised"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink">{c.title}</div>
            <div className="mt-0.5 text-xs text-ink-faint">
              <span className="num">{c.itemCount}</span> {c.itemCount === 1 ? "address" : "addresses"} · updated{" "}
              {new Date(c.updatedAt).toLocaleString()}
            </div>
          </div>
          <span className={`chip shrink-0 border ${STATUS_CLASS[c.status]}`}>{c.status}</span>
        </button>
      ))}
    </div>
  );
}

function NewCaseForm({ token, onCreated }: { token: string; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiCall<{ case: CaseView }>(`${CASES_URL}/cases`, { method: "POST", token, body: { title, description } });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onCreated(res.body.case.id);
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-2 p-4">
      <h2 className="section-title">New case</h2>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={140} required className="ctl w-full" />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What you're investigating (optional)"
        maxLength={8000}
        rows={3}
        className="ctl w-full"
      />
      {error && <div className={errorBox}>{error}</div>}
      <button type="submit" disabled={busy || title.trim() === ""} className="btn-accent">
        {busy ? "Creating…" : "Create case"}
      </button>
    </form>
  );
}

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string; notFound: boolean }
  | { status: "done"; case: CaseView; items: CaseItem[] };

/** Mounted with `key={token|caseId}`, so its state can never outlive the session it was fetched for. */
function CaseDetail({ token, caseId, onBack }: { token: string; caseId: string; onBack: () => void }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `${CASES_URL}/cases/${encodeURIComponent(caseId)}`;

  const load = useCallback(async () => {
    const res = await apiCall<{ case: CaseView; items: CaseItem[] }>(base, { token });
    setState(
      res.ok ? { status: "done", case: res.body.case, items: res.body.items } : { status: "error", message: res.message, notFound: res.status === 404 },
    );
  }, [base, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(run: () => Promise<{ ok: boolean; message?: string }>): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await run();
    setBusy(false);
    if (!res.ok) {
      setError(res.message ?? "request failed");
      return false;
    }
    await load();
    return true;
  }

  async function setStatus(action: "close" | "reopen"): Promise<void> {
    await act(() => apiCall(`${base}/${action}`, { method: "POST", token }));
  }

  async function deleteCase(): Promise<void> {
    if (!window.confirm("Delete this case and every address in it? This can't be undone.")) return;
    setBusy(true);
    setError(null);
    const res = await apiCall(base, { method: "DELETE", token });
    setBusy(false);
    // 404: already gone (e.g. deleted in another tab) — the end state is the same.
    if (!res.ok && res.status !== 404) {
      setError(res.message);
      return;
    }
    onBack();
  }

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="btn-outline">
        ← Back to your cases
      </button>

      {state.status === "loading" && <div className="text-sm text-ink-faint">Loading…</div>}
      {state.status === "error" && (
        <div role="alert" className="rounded-card border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger">
          {state.notFound ? "This case doesn't exist (it may have been deleted)." : state.message}
        </div>
      )}

      {state.status === "done" && (
        <>
          <section className="card overflow-hidden" aria-label="Case">
            <div className="card-header">
              <h2 className="truncate text-sm font-medium text-ink">{state.case.title}</h2>
              <span className={`chip shrink-0 border ${STATUS_CLASS[state.case.status]}`}>{state.case.status}</span>
            </div>
            <div className="space-y-3 px-4 py-3 text-sm">
              {editing ? (
                <EditCaseForm
                  token={token}
                  base={base}
                  initial={state.case}
                  onDone={async (changed) => {
                    setEditing(false);
                    if (changed) await load();
                  }}
                />
              ) : (
                <>
                  {state.case.description ? (
                    <p className="whitespace-pre-wrap text-ink-dim">{state.case.description}</p>
                  ) : (
                    <p className="text-ink-faint">No description.</p>
                  )}
                  <div className="text-xs text-ink-faint">
                    opened {new Date(state.case.createdAt).toLocaleString()} · updated {new Date(state.case.updatedAt).toLocaleString()}
                    {state.case.closedAt && <> · closed {new Date(state.case.closedAt).toLocaleString()}</>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {state.case.status === "open" ? (
                      <>
                        <button type="button" onClick={() => setEditing(true)} disabled={busy} className="btn-outline">
                          Edit
                        </button>
                        <button type="button" onClick={() => void setStatus("close")} disabled={busy} className="btn-outline">
                          Close case
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => void setStatus("reopen")} disabled={busy} className="btn-outline">
                        Reopen case
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void deleteCase()}
                      disabled={busy}
                      className="rounded-ctl border border-danger/40 px-3 py-1.5 text-sm font-medium text-danger transition-colors duration-150 hover:bg-danger/10 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                  {state.case.status === "closed" && (
                    <p className="text-xs text-ink-faint">Closed cases are read-only. Reopen it to edit or change its addresses.</p>
                  )}
                </>
              )}
            </div>
          </section>

          {error && (
            <div role="alert" className={errorBox}>
              {error}
            </div>
          )}

          {state.case.status === "open" && <AddItemForm token={token} base={base} onAdded={load} />}

          <section className="card overflow-hidden" aria-label="Addresses in this case">
            <div className="card-header">
              <h2 className="section-title">Addresses</h2>
              <span className="num text-xs font-medium text-ink">{state.items.length}</span>
            </div>
            {state.items.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-ink-faint">No addresses in this case yet.</div>
            ) : (
              <ul className="divide-y divide-line">
                {state.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    editable={state.case.status === "open"}
                    token={token}
                    base={base}
                    onChanged={load}
                    onError={setError}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function EditCaseForm({
  token,
  base,
  initial,
  onDone,
}: {
  token: string;
  base: string;
  initial: CaseView;
  onDone: (changed: boolean) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiCall<{ case: CaseView }>(base, { method: "PATCH", token, body: { title, description } });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    await onDone(true);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required aria-label="Title" className="ctl w-full" />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={8000}
        rows={4}
        aria-label="Description"
        className="ctl w-full"
      />
      {error && <div className={errorBox}>{error}</div>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || title.trim() === ""} className="btn-accent">
          Save
        </button>
        <button type="button" onClick={() => void onDone(false)} className="btn-outline">
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddItemForm({ token, base, onAdded }: { token: string; base: string; onAdded: () => Promise<void> }) {
  const [chain, setChain] = useState<ChainId>("ethereum");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiCall<{ item: CaseItem }>(`${base}/items`, { method: "POST", token, body: { chain, address, note } });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setAddress("");
    setNote("");
    await onAdded();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-2 p-4">
      <h2 className="section-title">Add an address</h2>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select value={chain} onChange={(e) => setChain(e.target.value as ChainId)} aria-label="Chain" className="ctl shrink-0">
          <option value="ethereum">Ethereum</option>
          <option value="solana">Solana</option>
        </select>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={chain === "ethereum" ? "0x…" : "a Solana address"}
          aria-label="Address"
          required
          className="ctl hash min-w-0 flex-1"
        />
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Your note — why this address belongs in the case (optional)"
        maxLength={2000}
        rows={2}
        aria-label="Note"
        className="ctl w-full"
      />
      {error && <div className={errorBox}>{error}</div>}
      <button type="submit" disabled={busy || address.trim() === ""} className="btn-accent">
        {busy ? "Adding…" : "Add to case"}
      </button>
    </form>
  );
}

function ItemRow({
  item,
  editable,
  token,
  base,
  onChanged,
  onError,
}: {
  item: CaseItem;
  editable: boolean;
  token: string;
  base: string;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.note);
  const [busy, setBusy] = useState(false);
  const itemUrl = `${base}/items/${encodeURIComponent(item.id)}`;

  async function saveNote(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    onError(null);
    const res = await apiCall(itemUrl, { method: "PATCH", token, body: { note: draft } });
    setBusy(false);
    if (!res.ok) {
      onError(res.message);
      return;
    }
    setEditing(false);
    await onChanged();
  }

  async function remove(): Promise<void> {
    setBusy(true);
    onError(null);
    const res = await apiCall(itemUrl, { method: "DELETE", token });
    setBusy(false);
    if (!res.ok && res.status !== 404) {
      onError(res.message);
      return;
    }
    await onChanged();
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="chip shrink-0 border-line-strong bg-raised text-ink-dim">{item.chain}</span>
            <span className="hash min-w-0 break-all text-xs text-ink">{item.address}</span>
          </div>
          {!editing &&
            (item.note ? (
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink-dim">{item.note}</p>
            ) : (
              <p className="mt-1.5 text-xs text-ink-faint">No note.</p>
            ))}
          <div className="mt-1 text-[11px] text-ink-faint">added {new Date(item.addedAt).toLocaleString()}</div>
        </div>
        {editable && !editing && (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(item.note);
                setEditing(true);
              }}
              disabled={busy}
              className="btn-outline text-xs"
            >
              Edit note
            </button>
            <button type="button" onClick={() => void remove()} disabled={busy} className="btn-outline text-xs disabled:opacity-50">
              Remove
            </button>
          </div>
        )}
      </div>
      {editing && (
        <form onSubmit={saveNote} className="mt-2 space-y-2">
          <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000} rows={2} aria-label="Note" className="ctl w-full" />
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="btn-accent">
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className="btn-outline">
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
