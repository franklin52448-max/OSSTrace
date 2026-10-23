/**
 * The Tracer's AI agent chat panel. Only ever mounted when the build-time flag is on (flag.ts).
 *
 * A message goes to POST /api/tracer-agent/chat (with the canvas itself for a local-only scratch
 * trace, which has no server copy). The server runs the model and its tools and returns the reply,
 * each tool call with its result, and the ops it applied; those ops go onto this same canvas
 * through the page's normal edit path (see toolCalls.ts), so what the panel says happened is what
 * the canvas shows, and one Undo takes the turn back.
 *
 * Two states are first-class, not errors: the server not having a model key yet (the agent isn't
 * turned on -- checked up front via GET /api/tracer-agent/status, and again on any 503), and a
 * visitor without a wallet having used their free messages. Neither ever shows an invented reply.
 */
import { ArrowUp, Check, CircleAlert, Eye, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, IconButton } from "../../kit/Button.tsx";
import { cn } from "../../kit/cn.ts";
import { Textarea } from "../../kit/Field.tsx";
import { useServerSession } from "../../serverSession.ts";
import { openLogin } from "../../ui.tsx";
import { ANON_MESSAGE_LIMIT, getAgentStatus, sendAgentMessage } from "./api.ts";
import { describeToolCall, type AgentCanvas, type AgentStep } from "./toolCalls.ts";

type Entry =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "agent"; text: string; steps: AgentStep[] }
  | { id: number; role: "notice"; text: string };

const EXAMPLES = ["Find connections between the addresses on the canvas", "Add 0x… and show who it sent funds to", "Remove the node I just added"];

const STEP_ICON = { applied: Check, read: Eye, failed: CircleAlert } as const;

export default function AgentChatPanel({ canvas, onClose, className }: { canvas: AgentCanvas; onClose: () => void; className?: string }) {
  const session = useServerSession();
  const signedIn = session.status === "signed-in";
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  /** Server-reported free messages left for a visitor; null = unlimited or not reported yet. */
  const [remaining, setRemaining] = useState<number | null>(null);
  const [limit, setLimit] = useState(ANON_MESSAGE_LIMIT);
  const [limitReached, setLimitReached] = useState(false);
  const seq = useRef(0);
  const logRef = useRef<HTMLOListElement>(null);
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;

  // Is the agent turned on, and how many free messages does this browser have left? Re-asked when
  // the session changes (connecting a wallet lifts the visitor limit).
  const [statusTick, setStatusTick] = useState(0);
  useEffect(() => {
    if (session.status === "checking") return;
    let live = true;
    getAgentStatus()
      .then((s) => {
        if (!live) return;
        if (!s.configured) setNotConfigured("not configured");
        else setNotConfigured(null);
        setLimit(s.messageLimit ?? ANON_MESSAGE_LIMIT);
        setRemaining(s.signedIn ? null : s.messagesRemaining);
        setLimitReached(!s.signedIn && s.messagesRemaining === 0);
      })
      .catch(() => {
        // Status is a convenience: if it can't be read, sending still tells the truth.
      });
    return () => {
      live = false;
    };
  }, [session.status, statusTick]);

  useEffect(() => {
    const el = logRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight });
  }, [entries]);

  const exhausted = !signedIn && (limitReached || remaining === 0);
  const used = signedIn || remaining === null ? null : Math.max(0, Math.min(limit, limit - remaining));
  const notice = (text: string) => setEntries((es) => [...es, { id: ++seq.current, role: "notice", text }]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || sending || exhausted || notConfigured) return;
    setDraft("");
    setSending(true);
    setEntries((es) => [...es, { id: ++seq.current, role: "user", text: message }]);
    try {
      const c = canvasRef.current;
      const doc = c.getDoc();
      // A scratch canvas exists only in this tab: the server can only see it if it's sent along.
      const scratch = c.docId === "scratch" && doc ? { title: doc.title, notes: doc.notes, nodes: doc.nodes, edges: doc.edges } : undefined;
      const out = await sendAgentMessage(c.docId, message, scratch);
      if (out.kind === "not-configured") {
        setNotConfigured(out.message);
        return;
      }
      if (out.kind === "limit") {
        if (signedIn) notice(out.message);
        else {
          setLimitReached(true);
          setRemaining(0);
        }
        return;
      }
      if (out.kind === "error") {
        notice(out.retryAfterSec ? `${out.message} (try again in ${out.retryAfterSec}s)` : out.message);
        return;
      }
      if (!signedIn) setRemaining(out.messagesRemaining);
      const applied = out.ops.length ? await canvasRef.current.applyAgentOps(out.ops, out.doc) : true;
      const after = canvasRef.current.getDoc();
      const steps = out.toolCalls.map((call) => describeToolCall(call, after));
      setEntries((es) => [...es, { id: ++seq.current, role: "agent", text: out.reply, steps }]);
      if (!applied) notice("The agent's changes couldn't be put on this canvas. Nothing here changed.");
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  return (
    <aside aria-label="Tracer agent" className={cn("kit-overlay pointer-events-auto flex h-full w-[340px] max-w-[calc(100vw-32px)] flex-col overflow-hidden", className)} data-canvas-scroll-region>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <Sparkles aria-hidden className="size-4 text-accent" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">Agent</h2>
        {used !== null && !notConfigured ? (
          <span className="kit-num rounded-sm border border-border px-1.5 text-[11px] leading-[18px] text-muted" aria-live="polite">
            {used} of {limit} messages used
          </span>
        ) : null}
        <IconButton size="sm" label="Close agent" onClick={onClose}>
          <X aria-hidden className="size-3.5" />
        </IconButton>
      </header>

      <ol ref={logRef} role="log" aria-label="Conversation" aria-live="polite" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-[13px]">
        {entries.length === 0 && !notConfigured ? (
          <li className="space-y-2 text-muted">
            <p>Tell the agent what to trace in plain words. Everything it does happens on this canvas, and one Undo takes a reply's changes back.</p>
            <ul className="space-y-1">
              {EXAMPLES.map((ex) => (
                <li key={ex} className="rounded-sm border border-dashed border-border px-2 py-1.5 text-[12px] text-faint">
                  {ex}
                </li>
              ))}
            </ul>
          </li>
        ) : null}
        {entries.map((e) =>
          e.role === "user" ? (
            <li key={e.id} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-[12px] rounded-br-[4px] bg-accent-soft px-3 py-2 text-text">{e.text}</p>
            </li>
          ) : e.role === "agent" ? (
            <li key={e.id} className="space-y-1.5" data-role="agent-reply">
              <p className="max-w-[92%] whitespace-pre-wrap break-words rounded-[12px] rounded-bl-[4px] bg-surface-2 px-3 py-2 text-text">{e.text}</p>
              {e.steps.length ? (
                <ul aria-label="What the agent did" className="space-y-1 pl-1 text-[12px]">
                  {e.steps.map((s, i) => {
                    const Icon = STEP_ICON[s.status];
                    return (
                      <li key={i} className={cn("flex items-start gap-1.5", s.status === "failed" ? "text-danger" : s.status === "applied" ? "text-muted" : "text-faint")} data-status={s.status}>
                        <Icon aria-hidden className="mt-[2px] size-3 shrink-0" />
                        {s.href ? (
                          <a href={s.href} className="underline hover:text-text">
                            {s.summary}
                          </a>
                        ) : (
                          <span>{s.summary}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          ) : (
            <li key={e.id} role="alert" className="flex items-start gap-1.5 rounded-sm border border-border px-2 py-1.5 text-[12px] text-danger">
              <CircleAlert aria-hidden className="mt-[2px] size-3 shrink-0" />
              <span>{e.text}</span>
            </li>
          ),
        )}
        {sending ? <li className="text-[12px] text-faint">Working on it…</li> : null}
      </ol>

      <footer className="shrink-0 border-t border-border p-3">
        {notConfigured ? (
          <div role="status" className="space-y-2">
            <p className="text-[13px] font-semibold">The AI agent isn't turned on yet</p>
            <p className="text-[12px] text-muted">This server doesn't have an AI model connected, so the agent can't answer yet. Nothing was sent to a model and nothing on the canvas changed. Every other Tracer tool works as usual.</p>
            <Button
              size="sm"
              onClick={() => {
                setNotConfigured(null);
                setStatusTick((t) => t + 1);
              }}
            >
              Check again
            </Button>
          </div>
        ) : exhausted ? (
          <div role="status" className="space-y-2">
            <p className="text-[13px] font-semibold">You've used all {limit} free messages</p>
            <p className="text-[12px] text-muted">Connect your wallet for unlimited messages. Your canvas stays as it is.</p>
            <Button variant="primary" size="sm" onClick={openLogin}>
              Connect wallet
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex items-end gap-2">
            <label htmlFor="tracer-agent-input" className="sr-only">
              Message the agent
            </label>
            <Textarea
              id="tracer-agent-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              maxLength={2000}
              placeholder="Find connections between…"
              className="min-h-[52px] flex-1 resize-none"
            />
            <IconButton type="submit" variant="primary" label="Send" disabled={sending || !draft.trim()}>
              <ArrowUp aria-hidden className="size-4" />
            </IconButton>
          </form>
        )}
      </footer>
    </aside>
  );
}
