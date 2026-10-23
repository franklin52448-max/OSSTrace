import { Fragment, lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BOUNTY_DIFFICULTIES, BOUNTY_TAGS, type Bounty, type BountyDifficulty, type BountySubmission, type BountyTag, type CreateBounty } from "@osstrace/contract";
import { serverApiCall, useServerSession } from "./serverSession.ts";
import { EmptyState, Loading, Notice, PageHeader, SignInPrompt } from "./ui.tsx";
import { Checkbox, cx } from "./prism/components.tsx";
import {
  applyQuery,
  assetDescription,
  assetLabel,
  boardAssets,
  deadlineInfo,
  DEFAULT_QUERY,
  DIFFICULTY_TEXT,
  fundingTotals,
  hasNarrowingFilters,
  STATUS_FILTERS,
  statusCounts,
  TAG_TEXT,
  type BoardQuery,
  type BountySort,
  type StatusFilter,
} from "./bountyBoard.ts";

// DepositPanel pulls in @solana/web3.js + @solana/spl-token (~2.5MB unminified, the whole Solana
// RPC/transaction stack) just to let a signed-in opener fund a bounty. Every other view -- the
// huge majority of page loads -- never needs any of that, so it loads in its own chunk, the same
// way App.tsx already lazy-loads the home page's WebGPU/WebGL hero effects.
const DepositPanel = lazy(() => import("./DepositPanel.tsx"));

type BountyStatus = Bounty["status"];

const STATUS_TEXT: Record<BountyStatus, string> = { open: "Open", claimed: "Claimed", cancelled: "Cancelled" };
const STATUS_CLASS: Record<BountyStatus, string> = {
  open: "border-signal/35 bg-signal/10 text-signal",
  claimed: "border-line-strong bg-raised text-ink-dim",
  cancelled: "border-line bg-raised text-ink-faint",
};
const STATUS_FILTER_TEXT: Record<StatusFilter, string> = { ...STATUS_TEXT, all: "All" };

/** Today's date where the viewer is, as the YYYY-MM-DD a date input uses. */
function todayDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function short(id: string): string {
  return id.length > 10 ? `${id.slice(0, 6)}…` : id;
}

type ListState = { status: "loading" } | { status: "error"; message: string } | { status: "done"; bounties: Bounty[] };

export default function BountiesView() {
  const session = useServerSession();
  const signedIn = session.status === "signed-in";
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [showOpenForm, setShowOpenForm] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState<BoardQuery>(DEFAULT_QUERY);

  // Once the board has loaded, later refreshes (after a claim, a cancel, a new deposit) swap the
  // data in place instead of blanking the page back to a spinner.
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    setList((prev) => (prev.status === "done" ? prev : { status: "loading" }));
    setRefreshing(true);
    const res = await serverApiCall<Bounty[]>("/api/bounties");
    setList(res.ok ? { status: "done", bounties: res.body } : { status: "error", message: res.message });
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = list.status === "done" ? list.bounties.find((b) => b.id === selectedId) ?? null : null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <PageHeader
        title="Bounties"
        description={
          <>
            Fund a feature with a spec and your own stated reward. This board tracks the work; rewards are paid off-platform (
            <a
              href="https://github.com/OpenTraceIntelligence/OSSTrace/blob/main/docs/adr/0009-bounty-program-v1-is-tracking-only.md"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-line-strong underline-offset-2 hover:text-ink"
            >
              ADR 0009
            </a>
            ).
          </>
        }
        actions={
          !selected && (
            <>
              <button type="button" onClick={() => void load()} disabled={refreshing} className="btn-outline">
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              {signedIn && (
                <button type="button" onClick={() => setShowOpenForm((v) => !v)} className="btn-accent">
                  {showOpenForm ? "Cancel" : "Open a bounty"}
                </button>
              )}
            </>
          )
        }
      />

      {!signedIn && <SignInPrompt>Log in to open a bounty or submit a PR. Anyone can browse.</SignInPrompt>}

      {showOpenForm && signedIn && (
        <OpenBountyForm
          onOpened={() => {
            setShowOpenForm(false);
            setQuery(DEFAULT_QUERY); // a fresh bounty is open: make sure the filters don't hide it
            void load();
          }}
        />
      )}

      {selected ? (
        <BountyDetail
          bounty={selected}
          onBack={() => {
            setSelectedId(null);
            void load(); // deposits recorded on the detail view show up in the list's funding totals
          }}
          onChanged={load}
        />
      ) : (
        <BountyList list={list} query={query} onQueryChange={setQuery} onSelect={setSelectedId} />
      )}
    </div>
  );
}

function BountyList({
  list,
  query,
  onQueryChange,
  onSelect,
}: {
  list: ListState;
  query: BoardQuery;
  onQueryChange: (query: BoardQuery) => void;
  onSelect: (id: string) => void;
}) {
  if (list.status === "loading") return <Loading />;
  if (list.status === "error") return <Notice tone="danger">{list.message}</Notice>;
  if (list.bounties.length === 0) {
    return <EmptyState title="No bounties yet">The first one could be yours: describe a feature and what you'd offer for it.</EmptyState>;
  }
  const counts = statusCounts(list.bounties);
  const assets = boardAssets(list.bounties);
  // A "most funded in X" sort whose asset no longer appears anywhere on the board falls back to newest.
  const sort: BountySort = query.sort.startsWith("funded:") && !assets.some((a) => `funded:${a.key}` === query.sort) ? "newest" : query.sort;
  const shown = applyQuery(list.bounties, { ...query, sort });

  return (
    <section aria-label="Bounty list" className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div role="group" aria-label="Filter by status" className="inline-flex h-9 items-center rounded-ctl bg-raised p-0.5">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={query.status === s}
              onClick={() => onQueryChange({ ...query, status: s })}
              className={cx(
                "inline-flex h-full items-center gap-1.5 rounded-[10px] px-3 text-xs font-medium transition-colors duration-150",
                query.status === s ? "bg-panel text-ink" : "text-ink-faint hover:text-ink",
              )}
            >
              {STATUS_FILTER_TEXT[s]}{" "}
              <span className="num text-ink-faint">{counts[s]}</span>
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
          Sort
          <select aria-label="Sort bounties" value={sort} onChange={(e) => onQueryChange({ ...query, sort: e.target.value as BountySort })} className="ctl h-9 py-0 text-sm">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="deadline">Deadline soonest</option>
            {assets.map((a) => (
              <option key={a.key} value={`funded:${a.key}`}>
                Most funded in {assetDescription(a.chain, a.asset)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
        <div role="group" aria-label="Filter by tag" className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-ink-faint">Tags</span>
          {BOUNTY_TAGS.map((t) => {
            const on = query.tags.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => onQueryChange({ ...query, tags: on ? query.tags.filter((x) => x !== t) : [...query.tags, t] })}
                className={cx("chip border transition-colors duration-150", on ? "border-signal/35 bg-signal/10 text-signal" : "border-line text-ink-faint hover:border-line-strong hover:text-ink")}
              >
                {TAG_TEXT[t]}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-faint">
          Size
          <select
            aria-label="Filter by difficulty"
            value={query.difficulty}
            onChange={(e) => onQueryChange({ ...query, difficulty: e.target.value as BoardQuery["difficulty"] })}
            className="ctl h-8 py-0 text-xs"
          >
            <option value="any">Any</option>
            {BOUNTY_DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {DIFFICULTY_TEXT[d]}
              </option>
            ))}
          </select>
        </label>
        {hasNarrowingFilters(query) && (
          <button type="button" onClick={() => onQueryChange({ ...query, tags: [], difficulty: "any" })} className="text-xs text-ink-dim underline-offset-2 hover:text-ink hover:underline">
            Clear filters
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-ink-faint">No bounties match these filters.</div>
      ) : (
        <div className="divide-y divide-line">
          {shown.map((b) => (
            <BountyRow key={b.id} bounty={b} onSelect={() => onSelect(b.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Verified on-chain deposits summed per asset: a checked fact, kept visually apart from the opener's own reward claim. */
function FundedChips({ bounty }: { bounty: Bounty }) {
  const totals = fundingTotals(bounty.deposits);
  if (totals.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" aria-label="Verified funding">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">Funded</span>{" "}
      {totals.map((t, i) => (
        <Fragment key={t.key}>
          {i > 0 && " "}
          <span title={`Verified on-chain: ${assetDescription(t.chain, t.asset)}`} className="chip border border-signal/35 bg-signal/10 text-signal">
            <span className="num">{t.total}</span>&nbsp;{assetLabel(t.chain, t.asset)}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** The opener's own size estimate and tags. A bounty opened before these existed simply shows none. */
function MetaChips({ bounty }: { bounty: Bounty }) {
  if (!bounty.difficulty && bounty.tags.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5" aria-label="Bounty details">
      {bounty.difficulty && (
        <span title="The opener's own estimate of the work's size" className="chip border border-line-strong bg-raised text-ink">
          {DIFFICULTY_TEXT[bounty.difficulty]}
        </span>
      )}{" "}
      {bounty.tags.map((t, i) => (
        <Fragment key={t}>
          {i > 0 && " "}
          <span className="chip border border-line text-ink-dim">{TAG_TEXT[t]}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** "Due Nov 3, 2026 · 9 days left" while open; just the date once resolved (a countdown would mean nothing then). */
function DeadlineText({ bounty }: { bounty: Bounty }) {
  if (!bounty.deadline) return null;
  const info = deadlineInfo(bounty.deadline);
  const live = bounty.status === "open";
  return (
    <span aria-label="Deadline" className={cx(live && info.passed && "text-warn", live && !info.passed && info.daysLeft <= 7 && "text-ink-dim")}>
      Due {info.dateText}
      {live && ` · ${info.text}`}
    </span>
  );
}

function BountyRow({ bounty: b, onSelect }: { bounty: Bounty; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className="flex w-full items-start justify-between gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-raised">
      <div className="min-w-0 space-y-1.5">
        <div className="truncate text-sm font-medium text-ink">{b.title}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-faint">
          <span>
            Reward <span className="num text-ink-dim">{b.reward}</span>
          </span>
          <FundedChips bounty={b} />
          <span>opened {new Date(b.openedAt).toLocaleDateString()}</span>
          {b.deadline && <DeadlineText bounty={b} />}
        </div>
        <MetaChips bounty={b} />
      </div>
      <span className={`chip shrink-0 border ${STATUS_CLASS[b.status]}`}>{STATUS_TEXT[b.status]}</span>
    </button>
  );
}

function OpenBountyForm({ onOpened }: { onOpened: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reward, setReward] = useState("");
  const [tags, setTags] = useState<BountyTag[]>([]);
  const [difficulty, setDifficulty] = useState<BountyDifficulty | "">("");
  const [deadline, setDeadline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    // The select's `required` already blocks an empty difficulty; checkboxes have no group-level
    // `required`, so "at least one tag" is checked here (and again, authoritatively, server-side).
    if (tags.length === 0) {
      setError("Pick at least one tag.");
      return;
    }
    if (!difficulty) return;
    setSubmitting(true);
    setError(null);
    const body: CreateBounty = { title, description, reward, tags, difficulty, ...(deadline ? { deadline } : {}) };
    const res = await serverApiCall<Bounty>("/api/bounties", { method: "POST", body });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setTitle("");
    setDescription("");
    setReward("");
    setTags([]);
    setDifficulty("");
    setDeadline("");
    onOpened();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-3 p-4">
      <h2 className="text-[15px] font-medium text-ink">Open a bounty</h2>
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
        Your own promise, not a balance held here: you pay whichever submission you mark claimed, off-platform.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Tags</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {BOUNTY_TAGS.map((t) => (
            <Checkbox key={t} aria-label={`Tag: ${TAG_TEXT[t]}`} checked={tags.includes(t)} onCheckedChange={(on) => setTags((prev) => (on ? [...prev, t] : prev.filter((x) => x !== t)))}>
              {TAG_TEXT[t]}
            </Checkbox>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1.5">
          <span className="block text-sm font-medium text-ink">Size</span>
          <select aria-label="Difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value as BountyDifficulty)} required className="ctl h-10 py-0">
            <option value="" disabled>
              Choose…
            </option>
            {BOUNTY_DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {DIFFICULTY_TEXT[d]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block text-sm font-medium text-ink">
            Deadline <span className="font-normal text-ink-faint">(optional)</span>
          </span>
          <input type="date" aria-label="Deadline" value={deadline} min={todayDate()} onChange={(e) => setDeadline(e.target.value)} className="ctl h-10 py-0" />
        </label>
        {deadline && (
          <button type="button" onClick={() => setDeadline("")} className="btn-outline h-10">
            No deadline
          </button>
        )}
      </div>
      <p className="text-xs text-ink-faint">Leave the deadline empty for an open-ended bounty. It's shown on the board; it never closes the bounty by itself.</p>
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" disabled={submitting} className="btn-accent">
        {submitting ? "Opening…" : "Open bounty"}
      </button>
    </form>
  );
}

function BountyDetail({ bounty, onBack, onChanged }: { bounty: Bounty; onBack: () => void; onChanged: () => void }) {
  const session = useServerSession();
  const signedIn = session.status === "signed-in";
  const isOpener = signedIn && session.user.id === bounty.openedBy;
  const submissions = bounty.submissions;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function claim(submissionId: string): Promise<void> {
    setError(null);
    const res = await serverApiCall(`/api/bounties/${bounty.id}/claim`, { method: "POST", body: { submissionId } });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("Marked claimed.");
    onChanged();
  }

  async function cancel(): Promise<void> {
    const reason = window.prompt("Reason for cancelling (shown on the bounty)?");
    if (!reason) return;
    setError(null);
    const res = await serverApiCall(`/api/bounties/${bounty.id}/cancel`, { method: "POST", body: { reason } });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("Cancelled.");
    onChanged();
  }

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-ink-dim transition-colors duration-150 hover:text-ink">
        ← All bounties
      </button>

      <section className="card overflow-hidden">
        <div className="card-header">
          <h2 className="truncate text-lg font-semibold tracking-tight text-ink">{bounty.title}</h2>
          <span className={`chip shrink-0 border ${STATUS_CLASS[bounty.status]}`}>{STATUS_TEXT[bounty.status]}</span>
        </div>
        <div className="space-y-3 px-4 py-3 text-sm">
          <MetaChips bounty={bounty} />
          {bounty.deadline ? (
            <div className="text-xs text-ink-faint">
              <DeadlineText bounty={bounty} />
            </div>
          ) : (
            <div className="text-xs text-ink-faint">No deadline: open-ended.</div>
          )}
          <p className="whitespace-pre-wrap text-ink-dim">{bounty.description}</p>
          <div className="text-xs text-ink-faint">
            Reward <span className="num font-medium text-ink">{bounty.reward}</span> · the poster's own claim, not escrowed
          </div>
          <div className="hash text-xs text-ink-faint">
            opened by {short(bounty.openedBy)} · {new Date(bounty.openedAt).toLocaleString()}
          </div>
          {bounty.status === "claimed" && (
            <div className="rounded-ctl border border-signal/30 bg-signal/10 px-3 py-2 text-xs text-ink">
              Claimed by <span className="hash">{short(bounty.claimedBy ?? "")}</span> — recorded by the opener on{" "}
              {bounty.claimedAt && new Date(bounty.claimedAt).toLocaleString()}.
            </div>
          )}
          {bounty.status === "cancelled" && (
            <div className="rounded-ctl border border-line bg-raised px-3 py-2 text-xs text-ink-dim">Cancelled: {bounty.cancellationReason}</div>
          )}
          {bounty.status === "open" && isOpener && (
            <button type="button" onClick={() => void cancel()} className="btn-outline">
              Cancel this bounty
            </button>
          )}
        </div>
      </section>

      {notice && <Notice>{notice}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}

      <Suspense fallback={<Loading label="Loading funding…" />}>
        <DepositPanel bountyId={bounty.id} signedIn={signedIn} />
      </Suspense>

      {bounty.status === "open" && signedIn && <SubmitPrForm bountyId={bounty.id} onSubmitted={onChanged} />}

      <section className="card overflow-hidden">
        <div className="card-header">
          <h2 className="text-[15px] font-medium text-ink">Submissions</h2>
          <span className="text-xs text-ink-faint">
            <span className="num">{submissions?.length ?? 0}</span>
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
                  {bounty.status === "open" && isOpener && s.outcome === "pending" && (
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

function SubmitPrForm({ bountyId, onSubmitted }: { bountyId: string; onSubmitted: () => void }) {
  const [prUrl, setPrUrl] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await serverApiCall<BountySubmission>(`/api/bounties/${bountyId}/submissions`, { method: "POST", body: { prUrl, note } });
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
    <form onSubmit={handleSubmit} className="card space-y-3 p-4">
      <h2 className="text-[15px] font-medium text-ink">Submit a PR</h2>
      <input value={prUrl} onChange={(e) => setPrUrl(e.target.value)} placeholder="https://github.com/…/pull/…" required className="ctl hash w-full" />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the bounty's opener (optional)" maxLength={1000} className="ctl w-full" />
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" disabled={submitting} className="btn-accent">
        {submitting ? "Submitting…" : "Submit"}
      </button>
    </form>
  );
}
