import { useCallback, useEffect, useState } from "react";
import { apiCall, COMMUNITY_LABELS_URL, isModerator, useSession } from "./session.ts";
import { EmptyState, Loading, Notice, PageHeader, SignInPrompt } from "./ui.tsx";

interface Submission {
  id: string;
  status: "community" | "confirmed" | "rejected";
  address: { chain: "ethereum" | "solana"; value: string };
  name: string;
  confidence: "verified" | "predicted";
  source: { description: string; url: string; addedAt: string };
  submittedBy: string;
  submittedAt: string;
}

type QueueState = { status: "loading" } | { status: "error"; message: string } | { status: "done"; submissions: Submission[] };

const explorerLink = (s: Submission): string =>
  s.address.chain === "ethereum" ? `https://etherscan.io/address/${s.address.value}` : `https://solscan.io/account/${s.address.value}`;

/**
 * The moderator review queue: every Community-tier submission, oldest first. Confirm marks it
 * Confirmed; Reject (with a reason the submitter sees) removes it from public view. The server
 * enforces the moderator role and refuses reviews of your own submission.
 */
export default function ModerationView() {
  const session = useSession();
  const token = session.status === "signed-in" ? session.token : null;
  const allowed = isModerator(session);
  const [queue, setQueue] = useState<QueueState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setQueue({ status: "loading" });
    const res = await apiCall<{ submissions: Submission[] }>(`${COMMUNITY_LABELS_URL}/labels/submissions?status=community`, { token });
    setQueue(res.ok ? { status: "done", submissions: res.body.submissions } : { status: "error", message: res.message });
  }, [token]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const header = (actions?: React.ReactNode) => (
    <PageHeader
      title="Moderation"
      description="Community label submissions waiting for review, oldest first. Confirm what the cited source supports; reject the rest with a reason."
      actions={actions}
    />
  );

  if (session.status === "checking") return <Loading label="Checking session…" />;
  if (!allowed) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-5">
        {header()}
        {session.status === "signed-in" ? (
          <Notice>Your account doesn't have the moderator role.</Notice>
        ) : (
          <SignInPrompt>The review queue is for moderators. Log in with a moderator account.</SignInPrompt>
        )}
      </div>
    );
  }

  function removeFromQueue(id: string): void {
    setQueue((q) => (q.status === "done" ? { status: "done", submissions: q.submissions.filter((s) => s.id !== id) } : q));
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      {header(
        <>
          {queue.status === "done" && (
            <span className="chip self-center border-line-strong bg-raised text-ink-dim">
              <span className="num">{queue.submissions.length}</span>&nbsp;pending
            </span>
          )}
          <button type="button" onClick={() => void load()} className="btn-outline">
            Refresh
          </button>
        </>,
      )}
      <div className="space-y-3">
        {notice && <Notice tone="success">{notice}</Notice>}
        {queue.status === "loading" && <Loading />}
        {queue.status === "error" && <Notice tone="danger">{queue.message}</Notice>}
        {queue.status === "done" && queue.submissions.length === 0 && <EmptyState title="All caught up">Nothing is waiting for review.</EmptyState>}
        {queue.status === "done" &&
          token &&
          queue.submissions.map((s) => (
            <SubmissionCard
              key={s.id}
              submission={s}
              token={token}
              ownId={session.status === "signed-in" ? session.user.id : null}
              onReviewed={(message) => {
                setNotice(message);
                removeFromQueue(s.id);
              }}
            />
          ))}
      </div>
    </div>
  );
}

function SubmissionCard({
  submission: s,
  token,
  ownId,
  onReviewed,
}: {
  submission: Submission;
  token: string;
  ownId: string | null;
  onReviewed: (message: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = ownId === s.submittedBy;

  async function review(action: "confirm" | "reject"): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await apiCall<{ submission: Submission }>(`${COMMUNITY_LABELS_URL}/labels/submissions/${encodeURIComponent(s.id)}/${action}`, {
      method: "POST",
      token,
      ...(action === "reject" ? { body: { reason } } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onReviewed(`${action === "confirm" ? "Confirmed" : "Rejected"} “${s.name}”.`);
  }

  return (
    <article className="card p-5 text-sm" data-submission-id={s.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold text-ink">{s.name}</h2>
        <span className="chip border-line-strong bg-raised text-ink-dim">{s.confidence}</span>
        <span className="chip border-line bg-ground-deep text-ink-faint">{s.address.chain}</span>
      </div>
      <a
        href={explorerLink(s)}
        target="_blank"
        rel="noreferrer"
        className="hash mt-1.5 block break-all text-xs text-ink-dim underline decoration-line-strong underline-offset-2 transition-colors duration-150 hover:text-ink"
      >
        {s.address.value}
      </a>
      <div className="mt-2 text-xs text-ink-dim">
        Source: {s.source.description}
        <a
          href={s.source.url}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 block break-all text-info underline decoration-info/30 underline-offset-2 transition-colors duration-150 hover:decoration-info/70"
        >
          {s.source.url}
        </a>
      </div>
      <div className="mt-1.5 text-xs text-ink-faint">
        Submitted {new Date(s.submittedAt).toLocaleString()} by account <span className="hash">{s.submittedBy.slice(0, 8)}…</span>
        {mine && " (you)"}
      </div>

      {mine ? (
        <div className="mt-3 text-xs text-ink-faint">Your own submission: another moderator has to review it.</div>
      ) : rejecting ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Reason (shown to the submitter)"
            aria-label="Rejection reason"
            className="ctl min-w-0 flex-1"
          />
          <button type="button" disabled={busy || !reason.trim()} onClick={() => void review("reject")} className="btn-danger">
            Reject
          </button>
          <button type="button" onClick={() => setRejecting(false)} className="btn-outline">
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-4 flex gap-2 border-t border-line pt-4">
          <button type="button" disabled={busy} onClick={() => void review("confirm")} className="btn-accent">
            Confirm
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRejecting(true)}
            className="btn-outline disabled:opacity-50"
          >
            Reject…
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
    </article>
  );
}
