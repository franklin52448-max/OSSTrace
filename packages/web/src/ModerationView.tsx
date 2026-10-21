import { useCallback, useEffect, useState } from "react";
import { apiCall, COMMUNITY_LABELS_URL, isModerator, useSession } from "./session.ts";

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

  if (session.status === "checking") return <div className="mt-6 text-sm text-neutral-400">Checking session…</div>;
  if (!allowed) {
    return (
      <div className="mt-6 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-400">
        The review queue is for moderators. {session.status === "signed-in" ? "Your account doesn't have the moderator role." : "Log in with a moderator account."}
      </div>
    );
  }

  function removeFromQueue(id: string): void {
    setQueue((q) => (q.status === "done" ? { status: "done", submissions: q.submissions.filter((s) => s.id !== id) } : q));
  }

  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-400">
          {queue.status === "done" ? `${queue.submissions.length} pending community submission${queue.submissions.length === 1 ? "" : "s"}` : "Pending community submissions"}
        </div>
        <button type="button" onClick={() => void load()} className="text-xs text-neutral-400 underline hover:text-neutral-200">
          Refresh
        </button>
      </div>
      {notice && <div className="rounded-md border border-neutral-800 bg-neutral-900 px-4 py-2 text-xs text-neutral-300">{notice}</div>}
      {queue.status === "loading" && <div className="text-sm text-neutral-500">Loading…</div>}
      {queue.status === "error" && (
        <div className="rounded-md border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{queue.message}</div>
      )}
      {queue.status === "done" && queue.submissions.length === 0 && <div className="text-sm text-neutral-500">Nothing waiting for review.</div>}
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
    <div className="rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm" data-submission-id={s.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{s.name}</span>
        <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">{s.confidence}</span>
        <span className="text-xs text-neutral-500">{s.address.chain}</span>
      </div>
      <a href={explorerLink(s)} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-xs text-neutral-400 hover:text-neutral-200">
        {s.address.value}
      </a>
      <div className="mt-2 text-xs text-neutral-400">
        Source: {s.source.description}
        <a href={s.source.url} target="_blank" rel="noreferrer" className="mt-0.5 block break-all text-sky-400 hover:text-sky-300">
          {s.source.url}
        </a>
      </div>
      <div className="mt-1 text-xs text-neutral-500">
        Submitted {new Date(s.submittedAt).toLocaleString()} by account {s.submittedBy.slice(0, 8)}…{mine && " (you)"}
      </div>

      {mine ? (
        <div className="mt-2 text-xs text-neutral-500">Your own submission: another moderator has to review it.</div>
      ) : rejecting ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Reason (shown to the submitter)"
            aria-label="Rejection reason"
            className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            disabled={busy || !reason.trim()}
            onClick={() => void review("reject")}
            className="rounded-md bg-red-800 px-3 py-1.5 text-sm hover:bg-red-700 disabled:opacity-50"
          >
            Reject
          </button>
          <button type="button" onClick={() => setRejecting(false)} className="text-xs text-neutral-500 hover:text-neutral-300">
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void review("confirm")}
            className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium hover:bg-sky-600 disabled:opacity-50"
          >
            Confirm
          </button>
          <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800">
            Reject…
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
    </div>
  );
}
