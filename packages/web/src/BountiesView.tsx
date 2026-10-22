import { useCallback, useEffect, useState } from "react";
import { apiCall, isModerator, useSession } from "./session.ts";

const BOUNTIES_URL = import.meta.env["VITE_BOUNTIES_URL"] ?? "http://localhost:5313";

// --- The Bounties API's response shapes (see packages/features/bounties/README.md) ------------
type BountyStatus = "open" | "claimed" | "cancelled";
interface Bounty {
  id: string;
  status: BountyStatus;
  title: string;
  description: string;
  reward: string;
  openedBy: string;
  openedAt: string;
  claimedSubmissionId?: string;
  claimedBy?: string;
  claimedAt?: string;
  resolvedBy?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancellationReason?: string;
}
interface BountySubmission {
  id: string;
  bountyId: string;
  submittedBy: string;
  prUrl: string;
  note: string;
  submittedAt: string;
  outcome: "pending" | "accepted" | "rejected";
}

const STATUS_TEXT: Record<BountyStatus, string> = { open: "Open", claimed: "Claimed", cancelled: "Cancelled" };
const STATUS_CLASS: Record<BountyStatus, string> = {
  open: "border-signal/35 bg-signal/10 text-signal",
  claimed: "border-line-strong bg-raised text-ink-dim",
  cancelled: "border-line bg-raised text-ink-faint",
};

function short(id: string): string {
  return id.length > 10 ? `${id.slice(0, 6)}…` : id;
}

type ListState = { status: "loading" } | { status: "error"; message: string } | { status: "done"; bounties: Bounty[] };

export default function BountiesView() {
  const session = useSession();
  const token = session.status === "signed-in" ? session.token : null;
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [showOpenForm, setShowOpenForm] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList({ status: "loading" });
    const res = await apiCall<{ bounties: Bounty[] }>(`${BOUNTIES_URL}/bounties`);
    setList(res.ok ? { status: "done", bounties: res.body.bounties } : { status: "error", message: res.message });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = list.status === "done" ? list.bounties.find((b) => b.id === selectedId) ?? null : null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Bounties</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
            Anyone can fund a feature with a spec and their own stated reward — no coding required to open one. This board
            tracks the workflow; it does not hold or move the reward itself (
            <a
              href="https://github.com/OpenTraceIntelligence/OSSTrace/blob/main/docs/adr/0009-bounty-program-v1-is-tracking-only.md"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-ink"
            >
              ADR 0009
            </a>
            ).
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={() => void load()} className="btn-outline">
            Refresh
          </button>
          {token && (
            <button type="button" onClick={() => setShowOpenForm((v) => !v)} className="btn-accent">
              {showOpenForm ? "Cancel" : "Open a bounty"}
            </button>
          )}
        </div>
      </div>

      {!token && (
        <div className="rounded-card border border-line bg-raised px-4 py-2.5 text-xs text-ink-dim">
          Log in (in the sidebar) to open a bounty or submit a PR against one. Browsing is open to everyone.
        </div>
      )}

      {showOpenForm && token && <OpenBountyForm token={token} onOpened={() => { setShowOpenForm(false); void load(); }} />}

      {selected ? (
        <BountyDetail bounty={selected} onBack={() => setSelectedId(null)} onChanged={load} />
      ) : (
        <BountyList list={list} onSelect={setSelectedId} />
      )}
    </div>
  );
}

function BountyList({ list, onSelect }: { list: ListState; onSelect: (id: string) => void }) {
  if (list.status === "loading") return <div className="text-sm text-ink-faint">Loading…</div>;
  if (list.status === "error") {
    return (
      <div role="alert" className="rounded-card border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger">
        {list.message}
      </div>
    );
  }
  if (list.bounties.length === 0) {
    return <div className="card px-4 py-6 text-center text-sm text-ink-faint">No bounties yet — the first one could be yours.</div>;
  }
  return (
    <div className="space-y-2">
      {list.bounties.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => onSelect(b.id)}
          className="card flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-raised"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink">{b.title}</div>
            <div className="mt-0.5 text-xs text-ink-faint">
              <span className="num">{b.reward}</span> · opened {new Date(b.openedAt).toLocaleDateString()}
            </div>
          </div>
          <span className={`chip shrink-0 border ${STATUS_CLASS[b.status]}`}>{STATUS_TEXT[b.status]}</span>
        </button>
      ))}
    </div>
  );
}

function OpenBountyForm({ token, onOpened }: { token: string; onOpened: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reward, setReward] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await apiCall<{ bounty: Bounty }>(`${BOUNTIES_URL}/bounties`, { method: "POST", token, body: { title, description, reward } });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setTitle("");
    setDescription("");
    setReward("");
    onOpened();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-2 p-4">
      <h2 className="section-title">Open a bounty</h2>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={140} required className="ctl w-full" />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="The feature, in depth: what it does, how it should behave, what &quot;done&quot; looks like. (at least 40 characters)"
        maxLength={8000}
        rows={5}
        required
        className="ctl w-full"
      />
      <input
        value={reward}
        onChange={(e) => setReward(e.target.value)}
        placeholder="Your reward offer, in your own words (e.g. &quot;100,000 tokens, token TBD&quot;)"
        maxLength={200}
        required
        className="ctl w-full"
      />
      <p className="text-xs text-ink-faint">
        This is your own claim, not a balance this platform holds — see ADR 0009. The actual payout happens off-platform,
        between you and whoever a moderator records as the winning submission.
      </p>
      {error && <div className="rounded-card border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
      <button type="submit" disabled={submitting} className="btn-accent">
        {submitting ? "Opening…" : "Open bounty"}
      </button>
    </form>
  );
}

function BountyDetail({ bounty, onBack, onChanged }: { bounty: Bounty; onBack: () => void; onChanged: () => void }) {
  const session = useSession();
  const token = session.status === "signed-in" ? session.token : null;
  const canModerate = isModerator(session);
  const isOpener = session.status === "signed-in" && session.user.id === bounty.openedBy;
  const [submissions, setSubmissions] = useState<BountySubmission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSubmissions = useCallback(async () => {
    const res = await apiCall<{ submissions: BountySubmission[] }>(`${BOUNTIES_URL}/bounties/${bounty.id}/submissions`);
    if (res.ok) setSubmissions(res.body.submissions);
  }, [bounty.id]);

  useEffect(() => {
    void loadSubmissions();
  }, [loadSubmissions]);

  async function claim(submissionId: string): Promise<void> {
    if (!token) return;
    setError(null);
    const res = await apiCall(`${BOUNTIES_URL}/bounties/${bounty.id}/claim`, { method: "POST", token, body: { submissionId } });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("Marked claimed.");
    onChanged();
  }

  async function cancel(): Promise<void> {
    if (!token) return;
    const reason = window.prompt("Reason for cancelling (shown on the bounty)?");
    if (!reason) return;
    setError(null);
    const res = await apiCall(`${BOUNTIES_URL}/bounties/${bounty.id}/cancel`, { method: "POST", token, body: { reason } });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("Cancelled.");
    onChanged();
  }

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="btn-outline">
        ← Back to the board
      </button>

      <section className="card overflow-hidden">
        <div className="card-header">
          <h2 className="truncate text-sm font-medium text-ink">{bounty.title}</h2>
          <span className={`chip shrink-0 border ${STATUS_CLASS[bounty.status]}`}>{STATUS_TEXT[bounty.status]}</span>
        </div>
        <div className="space-y-3 px-4 py-3 text-sm">
          <p className="whitespace-pre-wrap text-ink-dim">{bounty.description}</p>
          <div className="text-xs text-ink-faint">
            Reward (poster's own claim, not escrowed — ADR 0009): <span className="num font-medium text-ink">{bounty.reward}</span>
          </div>
          <div className="hash text-xs text-ink-faint">
            opened by {short(bounty.openedBy)} · {new Date(bounty.openedAt).toLocaleString()}
          </div>
          {bounty.status === "claimed" && (
            <div className="rounded-card border border-signal/35 bg-signal/10 px-3 py-2 text-xs text-ink">
              Claimed by <span className="hash">{short(bounty.claimedBy ?? "")}</span> — recorded by a moderator on{" "}
              {bounty.claimedAt && new Date(bounty.claimedAt).toLocaleString()}.
            </div>
          )}
          {bounty.status === "cancelled" && (
            <div className="rounded-card border border-line bg-raised px-3 py-2 text-xs text-ink-dim">Cancelled: {bounty.cancellationReason}</div>
          )}
          {bounty.status === "open" && (isOpener || canModerate) && (
            <button type="button" onClick={() => void cancel()} className="btn-outline">
              Cancel this bounty
            </button>
          )}
        </div>
      </section>

      {notice && <div className="rounded-card border border-line bg-raised px-3 py-2 text-xs text-ink-dim">{notice}</div>}
      {error && <div role="alert" className="rounded-card border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}

      {bounty.status === "open" && token && <SubmitPrForm bountyId={bounty.id} token={token} onSubmitted={() => void loadSubmissions()} />}

      <section className="card overflow-hidden">
        <div className="card-header">
          <h2 className="section-title">Submissions</h2>
          <span className="text-xs text-ink-faint">
            <span className="num font-medium text-ink">{submissions?.length ?? 0}</span>
          </span>
        </div>
        {submissions === null ? (
          <div className="px-4 py-3 text-sm text-ink-faint">Loading…</div>
        ) : submissions.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-ink-faint">No submissions yet.</div>
        ) : (
          <ul className="divide-y divide-line px-4">
            {submissions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <div className="min-w-0">
                  <a href={s.prUrl} target="_blank" rel="noreferrer" className="hash block truncate text-ink hover:underline">
                    {s.prUrl}
                  </a>
                  {s.note && <div className="mt-0.5 truncate text-xs text-ink-faint">{s.note}</div>}
                  <div className="hash mt-0.5 text-xs text-ink-faint">
                    {short(s.submittedBy)} · {new Date(s.submittedAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`chip border ${s.outcome === "accepted" ? "border-signal/35 bg-signal/10 text-signal" : s.outcome === "rejected" ? "border-line bg-raised text-ink-faint" : "border-line-strong bg-raised text-ink-dim"}`}
                  >
                    {s.outcome}
                  </span>
                  {bounty.status === "open" && canModerate && s.outcome === "pending" && (
                    <button type="button" onClick={() => void claim(s.id)} className="btn-outline">
                      Mark claimed
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SubmitPrForm({ bountyId, token, onSubmitted }: { bountyId: string; token: string; onSubmitted: () => void }) {
  const [prUrl, setPrUrl] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await apiCall<{ submission: BountySubmission }>(`${BOUNTIES_URL}/bounties/${bountyId}/submissions`, {
      method: "POST",
      token,
      body: { prUrl, note },
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setPrUrl("");
    setNote("");
    onSubmitted();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-2 p-4">
      <h2 className="section-title">Submit your PR against this bounty</h2>
      <input value={prUrl} onChange={(e) => setPrUrl(e.target.value)} placeholder="https://github.com/…/pull/…" required className="ctl hash w-full" />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the moderator (optional)" maxLength={1000} className="ctl w-full" />
      {error && <div className="rounded-card border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
      <button type="submit" disabled={submitting} className="btn-accent">
        {submitting ? "Submitting…" : "Submit"}
      </button>
    </form>
  );
}
