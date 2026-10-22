import { useState } from "react";
import type { ChainId } from "@osstrace/core";
import { apiCall, COMMUNITY_LABELS_URL, useSession } from "./session.ts";

/**
 * Label trust tiers in the UI (ADR 0004 / ADR 0007). The shape the Explorer and Visualizer APIs
 * return for a label: ingested labels have no `reviewStatus`; community submissions do.
 */
export interface LabelView {
  name: string;
  confidence: "verified" | "predicted";
  source: { description: string; url: string; addedAt: string };
  reviewStatus?: "community" | "confirmed";
  submittedBy?: string;
  submittedAt?: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

const day = (iso: string): string => iso.slice(0, 10);

/**
 * Distinct from the red SANCTIONED tag badge: this is about who vouches for the *label*, not what
 * the address is. Ingested labels (official sources) get no badge — they aren't in moderation.
 */
export function ReviewBadge({ label }: { label: LabelView }) {
  if (label.reviewStatus === "confirmed") {
    return (
      <span
        className="chip border-info/35 bg-info/10 text-info"
        title="A community submission a project moderator has reviewed and confirmed"
      >
        ✓ CONFIRMED
      </span>
    );
  }
  if (label.reviewStatus === "community") {
    return (
      <span
        className="chip border-warn/35 bg-warn/10 text-warn"
        title="Submitted by a community member with a cited source; not yet reviewed by a moderator"
      >
        COMMUNITY · UNREVIEWED
      </span>
    );
  }
  return null;
}

/** "Community submission, 2026-10-21 · confirmed 2026-10-22" — nothing for ingested labels. */
export function SubmissionByline({ label }: { label: LabelView }) {
  if (!label.reviewStatus || !label.submittedAt) return null;
  return (
    <div className="mt-1 text-xs text-ink-faint">
      Community submission, {day(label.submittedAt)}
      {label.reviewStatus === "confirmed" && label.confirmedAt && <> · confirmed by a moderator {day(label.confirmedAt)}</>}
    </div>
  );
}

/**
 * Suggest a label for the address being viewed. Only rendered for a logged-in user; the server
 * re-checks the session and requires a real source URL + description (ADR 0002).
 */
export function LabelSubmitForm({ chain, address, onSubmitted }: { chain: ChainId; address: string; onSubmitted: () => void }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [confidence, setConfidence] = useState<"verified" | "predicted">("verified");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; message: string } | null>(null);

  // Signed out: the report shows one combined sign-in prompt instead.
  if (session.status !== "signed-in") return null;
  const token = session.token;

  if (!open) {
    return (
      <div className="space-y-2">
        <button type="button" onClick={() => setOpen(true)} className="btn-outline w-full">
          Suggest a public label
        </button>
        {result?.kind === "ok" && <p className="text-xs text-ink-dim">{result.message}</p>}
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    const res = await apiCall<{ submission: { id: string } }>(`${COMMUNITY_LABELS_URL}/labels/submissions`, {
      method: "POST",
      token,
      body: { chain, address, name, confidence, source: { url, description } },
    });
    setBusy(false);
    if (!res.ok) {
      setResult({ kind: "error", message: res.message });
      return;
    }
    setName("");
    setUrl("");
    setDescription("");
    setOpen(false);
    setResult({ kind: "ok", message: "Submitted. It shows as Community (unreviewed) until a moderator reviews it." });
    onSubmitted();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-3 p-4" aria-label="Suggest a label">
      <div className="flex items-center justify-between">
        <h2 className="section-title">Suggest a label</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-ink-faint transition-colors duration-150 hover:text-ink-dim"
        >
          Cancel
        </button>
      </div>
      <label className="block text-xs font-medium text-ink-dim">
        Label
        <input
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Who or what this address is"
          className="ctl mt-1 w-full"
        />
      </label>
      <label className="block text-xs font-medium text-ink-dim">
        Source URL (required)
        <input
          required
          type="url"
          maxLength={2048}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="ctl mt-1 w-full"
        />
      </label>
      <label className="block text-xs font-medium text-ink-dim">
        What the source says (required)
        <input
          required
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. the project's own docs list this as its treasury wallet"
          className="ctl mt-1 w-full"
        />
      </label>
      <label className="block text-xs font-medium text-ink-dim">
        How directly does the source support it?
        <select
          value={confidence}
          onChange={(e) => setConfidence(e.target.value as "verified" | "predicted")}
          className="ctl mt-1 w-full"
        >
          <option value="verified">verified: the source states it outright</option>
          <option value="predicted">predicted: inferred from the source</option>
        </select>
      </label>
      <p className="text-xs leading-relaxed text-ink-faint">
        Public right away, marked unreviewed until a moderator checks it. Your account id (not your email) is recorded.
      </p>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="btn-accent">
          {busy ? "Submitting…" : "Submit label"}
        </button>
        {result?.kind === "error" && <span className="text-xs text-danger">{result.message}</span>}
      </div>
    </form>
  );
}
