import { useEffect, useState } from "react";
import type { ChainId } from "@osstrace/core";

/**
 * Client side of the Explorer's real-time stream (`ws://<explorer>/stream`, ADR 0013). While an
 * address report is on screen, this subscribes to that address and collects the real
 * transactions the background indexer pushes when its regular refetch finds a new one. It never
 * polls anything itself: no pushes means nothing new was found (or the address isn't live — the
 * status says which).
 *
 * The stream requires a signed-in session (ADR 0013 §6): the first message is
 * `{ auth: { token } }`, with the subscribe pipelined right behind it. Signed out, it doesn't
 * connect at all. A refused session (close code 1008) isn't retried with the same token.
 */

export type NotLiveCause = "no_indexer_cycle" | "indexer_stopped" | "not_indexed" | "history_unavailable";
export type LiveStatus = { live: true } | { live: false; cause: NotLiveCause; reason: string };

export interface LiveState<T> {
  /** `signed-out`: no session, so no socket. `refused`: the server rejected the session; `refusal` says why. */
  connection: "signed-out" | "connecting" | "open" | "offline" | "refused";
  refusal?: string;
  /** From the server's subscribe ack and later status events; null until the ack arrives. */
  status: LiveStatus | null;
  /** Pushed transactions, newest first. */
  incoming: T[];
  /** The server said more may have happened than it could push (a full window of new transactions). */
  gap: boolean;
}

const RECONNECT_MS = 10_000;
const MAX_INCOMING = 50;
/** The server's "policy violation" close: the session was refused, so retrying with it is pointless. */
const CLOSE_AUTH_FAILED = 1008;

export function streamUrl(explorerUrl: string): string {
  const url = new URL(explorerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/stream";
  return url.toString();
}

export function useLiveTransactions<T extends { hash: string }>(
  explorerUrl: string,
  chain: ChainId,
  address: string,
  token: string | null,
): LiveState<T> {
  const initial = (): LiveState<T> => ({ connection: token ? "connecting" : "signed-out", status: null, incoming: [], gap: false });
  const [state, setState] = useState<LiveState<T>>(initial);

  useEffect(() => {
    setState(initial());
    if (!token) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let lastError = "";

    const connect = (): void => {
      socket = new WebSocket(streamUrl(explorerUrl));
      socket.onopen = () => {
        setState((s) => ({ ...s, connection: "open" }));
        // The server queues the subscribe until the session check finishes.
        socket?.send(JSON.stringify({ auth: { token } }));
        socket?.send(JSON.stringify({ subscribe: { chain, address } }));
      };
      socket.onmessage = (message) => {
        let msg: { event?: string; address?: string; transaction?: T; message?: string } & Partial<{
          live: boolean;
          cause: NotLiveCause;
          reason: string;
        }>;
        try {
          msg = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (msg.address !== undefined && msg.address !== address) return;
        if (msg.event === "error") {
          lastError = msg.message ?? "";
        } else if (msg.event === "subscribed" || msg.event === "status") {
          const status: LiveStatus = msg.live ? { live: true } : { live: false, cause: msg.cause ?? "not_indexed", reason: msg.reason ?? "" };
          setState((s) => ({ ...s, status }));
        } else if (msg.event === "new_transaction" && msg.transaction) {
          const tx = msg.transaction;
          setState((s) =>
            s.incoming.some((t) => t.hash === tx.hash) ? s : { ...s, incoming: [tx, ...s.incoming].slice(0, MAX_INCOMING) },
          );
        } else if (msg.event === "possible_gap") {
          setState((s) => ({ ...s, gap: true }));
        }
      };
      socket.onclose = (event) => {
        if (disposed) return;
        if (event.code === CLOSE_AUTH_FAILED) {
          setState((s) => ({ ...s, connection: "refused", refusal: lastError || event.reason, status: null }));
          return;
        }
        setState((s) => ({ ...s, connection: "offline", status: null }));
        retry = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
    // `initial` only reads `token`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorerUrl, chain, address, token]);

  return state;
}

/** One compact chip for the transactions header: what the stream is actually doing for this address. */
export function LiveBadge({ state }: { state: LiveState<unknown> }) {
  if (state.connection === "signed-out") {
    return (
      <span className="chip border-line-strong bg-raised text-ink-faint" title="Live updates need a signed-in account. The report itself doesn't.">
        Live: sign in
      </span>
    );
  }
  if (state.connection === "refused") {
    return (
      <span className="chip border-line-strong bg-raised text-ink-faint" title={state.refusal || "The Explorer refused this session."}>
        Live: session refused
      </span>
    );
  }
  if (state.connection === "offline") {
    return (
      <span className="chip border-line-strong bg-raised text-ink-faint" title="Couldn't reach the Explorer's live stream; retrying every 10s.">
        Live: offline
      </span>
    );
  }
  if (state.connection === "connecting" || !state.status) {
    return <span className="chip border-line-strong bg-raised text-ink-faint">Live: connecting…</span>;
  }
  if (state.status.live) {
    return (
      <span
        className="chip gap-1.5 border-signal/30 bg-signal/10 text-signal"
        title="New transactions are pushed as the background indexer finds them — up to one indexer interval after they land."
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-signal motion-safe:animate-pulse" aria-hidden="true" />
        LIVE
      </span>
    );
  }
  return (
    <span className="chip border-line-strong bg-raised text-ink-faint" title={state.status.reason}>
      Not live
    </span>
  );
}
