import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { addressKey, type Address, type TransactionSummary } from "@osstrace/core";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { isSupportedChain, normalizeAddress, SUPPORTED_CHAINS } from "./address.ts";
import type { CycleCompletedEvent, IndexerEvent, IndexerEventBus } from "./events.ts";

/**
 * Real-time streaming over a websocket (ADR 0013). Clients subscribe to addresses; the hub pushes
 * a `new_transaction` event whenever the background indexer's regular refetch of that address
 * finds a transaction hash its previous fetch didn't have. The hub itself never calls a chain
 * adapter — it only relays what the indexer publishes on the event bus.
 *
 * Client → server:
 *   { "subscribe":   { "chain": "ethereum", "address": "0x..." } }
 *   { "unsubscribe": { "chain": "ethereum", "address": "0x..." } }
 *
 * Server → client: see `ServerMessage` below and the Explorer README's "Real-time streaming".
 */

export const STREAM_PATH = "/stream";
/** Per connection. Each subscription is cheap (no RPC), but an unbounded list is a memory hole. */
export const MAX_SUBSCRIPTIONS_PER_CLIENT = 25;
/** Client messages are tiny JSON objects; anything bigger is refused at the frame level. */
const MAX_MESSAGE_BYTES = 4096;
const MAX_ADDRESS_LENGTH = 128;

/**
 * Why an address isn't getting live pushes. `cause` is the stable, machine-readable part (a client
 * should branch on it); `reason` is the human explanation and can carry an adapter's own error.
 * - `no_indexer_cycle`: this server has never heard from an indexer.
 * - `indexer_stopped`: it has, but not recently enough to trust that one is still running.
 * - `not_indexed`: the indexer is running but this address isn't in its top-N popular set.
 * - `history_unavailable`: the indexer refreshes it but its last fetch couldn't read transactions.
 */
export type NotLiveCause = "no_indexer_cycle" | "indexer_stopped" | "not_indexed" | "history_unavailable";
export type LiveStatus = { live: true } | { live: false; cause: NotLiveCause; reason: string };

/** Adapter errors can be whole JSON-RPC batch bodies; a status message doesn't need all of it. */
const MAX_REASON_LENGTH = 300;

export type ServerMessage =
  | ({ event: "subscribed"; chain: string; address: string } & LiveStatus)
  | ({ event: "status"; chain: string; address: string } & LiveStatus)
  | { event: "unsubscribed"; chain: string; address: string }
  | { event: "new_transaction"; chain: string; address: string; transaction: TransactionSummary; detectedAt: string }
  | { event: "possible_gap"; chain: string; address: string; detectedAt: string; message: string }
  | { event: "error"; message: string };

/** Status events go out when this changes — the cause, not the wording, so a different 429 body each cycle isn't news. */
function statusKey(status: LiveStatus): string {
  return status.live ? "live" : status.cause;
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_REASON_LENGTH ? `${oneLine.slice(0, MAX_REASON_LENGTH)}…` : oneLine;
}

export interface StreamHubOptions {
  now?: () => Date;
}

export class StreamHub {
  readonly #now: () => Date;
  /** addressKey → sockets subscribed to it. */
  readonly #subscribers = new Map<string, Set<WebSocket>>();
  /** socket → the addresses it's subscribed to (for O(own subs) cleanup on disconnect). */
  readonly #bySocket = new Map<WebSocket, Map<string, Address>>();
  /** Last status sent per subscribed address, so a status event only goes out on a real change. */
  readonly #lastStatus = new Map<string, string>();
  #lastCycle: CycleCompletedEvent | null = null;
  #unsubscribeBus: (() => void) | null = null;

  private constructor(now: () => Date) {
    this.#now = now;
  }

  static async create(bus: IndexerEventBus, options: StreamHubOptions = {}): Promise<StreamHub> {
    const hub = new StreamHub(options.now ?? (() => new Date()));
    hub.#unsubscribeBus = await bus.subscribe((event) => hub.#onIndexerEvent(event));
    return hub;
  }

  /** Number of connected clients being tracked. */
  get clientCount(): number {
    return this.#bySocket.size;
  }

  /** Number of distinct addresses with at least one subscriber. */
  get subscribedAddressCount(): number {
    return this.#subscribers.size;
  }

  /** Whether an address currently gets live pushes, judged from the indexer's last reported cycle. */
  statusFor(key: string): LiveStatus {
    const cycle = this.#lastCycle;
    if (!cycle) {
      return {
        live: false,
        cause: "no_indexer_cycle",
        reason:
          "No indexer cycle has reached this server yet, so no live updates are flowing. The background indexer must be " +
          "running and sharing this server's REDIS_URL, or be embedded in it (EXPLORER_EMBEDDED_INDEXER=1).",
      };
    }
    // The next cycle starts `intervalMs` after the previous one *finishes*, so the expected gap
    // between completions is interval + cycle duration. Two of those, plus slack, means it's gone.
    const ageMs = this.#now().getTime() - Date.parse(cycle.completedAt);
    if (ageMs > 2 * (cycle.intervalMs + cycle.durationMs) + 30_000) {
      return {
        live: false,
        cause: "indexer_stopped",
        reason: `The indexer's last completed cycle was at ${cycle.completedAt}; it looks stopped, so no live updates are flowing.`,
      };
    }
    if (cycle.live.includes(key)) return { live: true };
    const failed = cycle.notLive.find((entry) => entry.key === key);
    if (failed) {
      return {
        live: false,
        cause: "history_unavailable",
        reason: truncate(`The indexer refreshes this address but its last fetch couldn't read transaction history: ${failed.reason}`),
      };
    }
    return {
      live: false,
      cause: "not_indexed",
      reason:
        `This address isn't among the ${cycle.topN} most-looked-up addresses the indexer refreshes, so it gets no live ` +
        "updates right now. The subscription stays open: if it becomes one of them, a status event says so and pushes start.",
    };
  }

  /** Start tracking a connected socket. The hub owns its message and close handling from here. */
  addClient(socket: WebSocket): void {
    this.#bySocket.set(socket, new Map());
    socket.on("message", (data: RawData, isBinary: boolean) => this.#onClientMessage(socket, data, isBinary));
    socket.on("close", () => this.#removeClient(socket));
    socket.on("error", () => this.#removeClient(socket));
  }

  async close(): Promise<void> {
    this.#unsubscribeBus?.();
    this.#unsubscribeBus = null;
    for (const socket of [...this.#bySocket.keys()]) {
      this.#removeClient(socket);
      socket.terminate();
    }
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  #onClientMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.#send(socket, { event: "error", message: "binary frames aren't supported; send JSON text" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.#send(socket, { event: "error", message: "message is not valid JSON" });
      return;
    }
    const msg = parsed as { subscribe?: unknown; unsubscribe?: unknown } | null;
    const action = msg && typeof msg === "object" ? (msg.subscribe !== undefined ? "subscribe" : msg.unsubscribe !== undefined ? "unsubscribe" : null) : null;
    if (!action || !msg) {
      this.#send(socket, { event: "error", message: 'expected { "subscribe": { chain, address } } or { "unsubscribe": { chain, address } }' });
      return;
    }
    const target = (action === "subscribe" ? msg.subscribe : msg.unsubscribe) as { chain?: unknown; address?: unknown } | null;
    const chain = target && typeof target === "object" ? target.chain : undefined;
    const rawAddress = target && typeof target === "object" ? target.address : undefined;
    if (typeof chain !== "string" || !isSupportedChain(chain)) {
      this.#send(socket, { event: "error", message: `unsupported chain ${JSON.stringify(chain)} — supported: ${SUPPORTED_CHAINS.join(", ")}` });
      return;
    }
    if (typeof rawAddress !== "string" || rawAddress.trim() === "" || rawAddress.length > MAX_ADDRESS_LENGTH) {
      this.#send(socket, { event: "error", message: "address must be a non-empty string" });
      return;
    }
    const address = normalizeAddress(chain, rawAddress);
    if (action === "subscribe") this.#subscribe(socket, address);
    else this.#unsubscribe(socket, address);
  }

  #subscribe(socket: WebSocket, address: Address): void {
    const own = this.#bySocket.get(socket);
    if (!own) return;
    const key = addressKey(address);
    if (!own.has(key) && own.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
      this.#send(socket, { event: "error", message: `at most ${MAX_SUBSCRIPTIONS_PER_CLIENT} subscriptions per connection` });
      return;
    }
    own.set(key, address);
    let sockets = this.#subscribers.get(key);
    if (!sockets) {
      sockets = new Set();
      this.#subscribers.set(key, sockets);
    }
    sockets.add(socket);
    const status = this.statusFor(key);
    this.#lastStatus.set(key, statusKey(status));
    this.#send(socket, { event: "subscribed", chain: address.chain, address: address.value, ...status });
  }

  #unsubscribe(socket: WebSocket, address: Address): void {
    const key = addressKey(address);
    this.#detach(socket, key);
    this.#send(socket, { event: "unsubscribed", chain: address.chain, address: address.value });
  }

  /** Removes one socket from one address, dropping the address entirely once nobody's left. */
  #detach(socket: WebSocket, key: string): void {
    this.#bySocket.get(socket)?.delete(key);
    const sockets = this.#subscribers.get(key);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.#subscribers.delete(key);
      this.#lastStatus.delete(key);
    }
  }

  #removeClient(socket: WebSocket): void {
    const own = this.#bySocket.get(socket);
    if (!own) return;
    for (const key of [...own.keys()]) this.#detach(socket, key);
    this.#bySocket.delete(socket);
  }

  #onIndexerEvent(event: IndexerEvent): void {
    if (event.type === "new_transactions") {
      const key = addressKey(event.address);
      const sockets = this.#subscribers.get(key);
      if (!sockets) return;
      const { chain, value } = event.address;
      for (const socket of sockets) {
        for (const transaction of event.transactions) {
          this.#send(socket, { event: "new_transaction", chain, address: value, transaction, detectedAt: event.detectedAt });
        }
        if (event.windowOverflow) {
          this.#send(socket, {
            event: "possible_gap",
            chain,
            address: value,
            detectedAt: event.detectedAt,
            message:
              "Every transaction in the indexer's latest window was new, so more may have happened since its previous fetch " +
              "than were pushed. Re-fetch the address over HTTP for the full recent list.",
          });
        }
      }
      return;
    }

    this.#lastCycle = event;
    for (const [key, sockets] of this.#subscribers) {
      const status = this.statusFor(key);
      const next = statusKey(status);
      if (this.#lastStatus.get(key) === next) continue;
      this.#lastStatus.set(key, next);
      const first = sockets.values().next().value;
      const address = first ? this.#bySocket.get(first)?.get(key) : undefined;
      if (!address) continue;
      for (const socket of sockets) this.#send(socket, { event: "status", chain: address.chain, address: address.value, ...status });
    }
  }
}

export interface AttachedStream {
  close(): Promise<void>;
}

/**
 * Mounts the websocket endpoint on an existing HTTP server at `STREAM_PATH`, via the server's
 * `upgrade` event — no second port. Any other upgrade path is refused. A ping goes to every
 * client each `heartbeatMs`; a client that didn't answer the previous one is terminated, so a
 * half-open connection (laptop lid closed, network dropped) can't hold subscriptions forever.
 */
export function attachStream(server: Server, hub: StreamHub, options: { heartbeatMs?: number } = {}): AttachedStream {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== STREAM_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      hub.addClient(ws);
    });
  };
  server.on("upgrade", onUpgrade);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref();

  return {
    async close(): Promise<void> {
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      await hub.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
