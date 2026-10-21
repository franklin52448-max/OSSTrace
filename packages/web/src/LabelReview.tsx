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
        className="rounded border border-sky-500/60 bg-sky-950 px-2 py-0.5 text-xs font-medium text-sky-200"
        title="A community submission a project moderator has reviewed and confirmed"
      >
        ✓ CONFIRMED
      </span>
    );
  }
  if (label.reviewStatus === "community") {
    return (
      <span
        className="rounded border border-amber-500/50 px-2 py-0.5 text-xs text-amber-300"
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
    <div className="mt-1 text-xs text-neutral-500">
      Community submission, {day(label.submittedAt)}
      {label.reviewStatus === "confirmed" && label.confirmedAt && <> · confirmed by a moderator {day(label.confirmedAt)}</>}
    </div>
  );
}

const inputClass = "w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm";

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

  if (session.status !== "signed-in") {
    return session.status === "anonymous" ? (
      <div className="text-xs text-neutral-500">Log in to suggest a label for this address.</div>
    ) : null;
  }
  const token = session.token;

  if (!open) {
    return (
      <div className="text-xs">
        <button type="button" onClick={() => setOpen(true)} className="text-emerald-400 hover:text-emerald-300">
          Suggest a label for this address
        </button>
        {result?.kind === "ok" && <span className="ml-2 text-neutral-400">{result.message}</span>}
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
    <form onSubmit={handleSubmit} className="space-y-2 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3" aria-label="Suggest a label">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-neutral-500">Suggest a label</div>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-neutral-500 hover:text-neutral-300">
          Cancel
        </button>
      </div>
      <label className="block text-xs text-neutral-400">
        Label
        <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Who or what this address is" className={`mt-1 ${inputClass}`} />
      </label>
      <label className="block text-xs text-neutral-400">
        Source URL (required)
        <input required type="url" maxLength={2048} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={`mt-1 ${inputClass}`} />
      </label>
      <label className="block text-xs text-neutral-400">
        What the source says (required)
        <input
          required
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. the project's own docs list this as its treasury wallet"
          className={`mt-1 ${inputClass}`}
        />
      </label>
      <label className="block text-xs text-neutral-400">
        How directly does the source support it?
        <select value={confidence} onChange={(e) => setConfidence(e.target.value as "verified" | "predicted")} className={`mt-1 ${inputClass}`}>
          <option value="verified">verified: the source states it outright</option>
          <option value="predicted">predicted: inferred from the source</option>
        </select>
      </label>
      <p className="text-xs text-neutral-500">
        It's public right away, marked unreviewed, until a moderator confirms or rejects it. Your account id (not your email)
        is recorded with it.
      </p>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50">
          {busy ? "Submitting…" : "Submit label"}
        </button>
        {result?.kind === "error" && <span className="text-xs text-red-300">{result.message}</span>}
      </div>
    </form>
  );
}
