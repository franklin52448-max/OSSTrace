import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { AuthResult, PublicUser } from "@osstrace/accounts";
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
 * Before any of that, a connection has to get through three gates (ADR 0013 §6): an `Origin`
 * allowlist on the upgrade, a per-IP connection cap, and an `@osstrace/accounts` session token
 * sent as the first message.
 *
 * Client → server:
 *   { "auth":        { "token": "ots_..." } }        (must be the first message)
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
 * Concurrent connections from one remote address. The web UI opens one socket per address report
 * on screen, so 8 covers one person with several tabs, or a few people behind one NAT, while one
 * address still can't hold more than 8 × 25 = 200 subscriptions, or more than 8 sockets that
 * haven't authenticated yet.
 */
export const MAX_CONNECTIONS_PER_IP = 8;
/** How long a new connection may sit without sending its `auth` message before it's closed. */
export const AUTH_TIMEOUT_MS = 10_000;
/** Messages a client may pipeline behind its `auth` while the session lookup is still running. */
const MAX_PENDING_MESSAGES = MAX_SUBSCRIPTIONS_PER_CLIENT + 5;
/** The web UI's local dev origin; the same default `@osstrace/accounts` uses. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ["http://localhost:5301"];

/** 1008 = policy violation: retrying with the same token won't help. */
export const CLOSE_AUTH_FAILED = 1008;
/** 1013 = try again later: this address already has its maximum number of connections open. */
export const CLOSE_TOO_MANY_CONNECTIONS = 1013;

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
  | { event: "authenticated" }
  | ({ event: "subscribed"; chain: string; address: string } & LiveStatus)
  | ({ event: "status"; chain: string; address: string } & LiveStatus)
  | { event: "unsubscribed"; chain: string; address: string }
  | { event: "new_transaction"; chain: string; address: string; transaction: TransactionSummary; detectedAt: string }
  | { event: "possible_gap"; chain: string; address: string; detectedAt: string; message: string }
  | { event: "error"; message: string };

/** The one thing the hub needs from `@osstrace/accounts`: `AccountService.authenticate`. */
export interface StreamAuthenticator {
  authenticate(token: string | null | undefined): Promise<AuthResult<{ user: PublicUser }>>;
}

/** Status events go out when this changes — the cause, not the wording, so a different 429 body each cycle isn't news. */
function statusKey(status: LiveStatus): string {
  return status.live ? "live" : status.cause;
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_REASON_LENGTH ? `${oneLine.slice(0, MAX_REASON_LENGTH)}…` : oneLine;
}

/** `{ "auth": { "token": "..." } }` → the token; anything else → undefined. */
function authToken(data: RawData): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return undefined;
  }
  const auth = parsed && typeof parsed === "object" ? (parsed as { auth?: unknown }).auth : undefined;
  const token = auth && typeof auth === "object" ? (auth as { token?: unknown }).token : undefined;
  return typeof token === "string" ? token : undefined;
}

/** `::ffff:127.0.0.1` and `127.0.0.1` are the same client; count them as one. */
export function normalizeIp(remoteAddress: string | undefined): string | null {
  if (!remoteAddress) return null;
  return remoteAddress.startsWith("::ffff:") ? remoteAddress.slice("::ffff:".length) : remoteAddress;
}

export interface StreamHubOptions {
  /** Checks session tokens. In the server this is the real `AccountService`, on the same accounts file. */
  accounts: StreamAuthenticator;
  now?: () => Date;
  maxConnectionsPerIp?: number;
  authTimeoutMs?: number;
}

/** Where a socket is in the auth handshake. Messages that arrive mid-lookup wait in `pending`. */
type ClientState =
  | { phase: "awaiting_auth"; ip: string; timer: ReturnType<typeof setTimeout> }
  | { phase: "authenticating"; ip: string; pending: { data: RawData; isBinary: boolean }[] }
  | { phase: "ready"; ip: string };

export class StreamHub {
  readonly #now: () => Date;
  readonly #accounts: StreamAuthenticator;
  readonly #maxPerIp: number;
  readonly #authTimeoutMs: number;
  /** Every open socket, authenticated or not, and where it is in the handshake. */
  readonly #clients = new Map<WebSocket, ClientState>();
  /** remote address → open sockets from it. Dropped at zero, so it doesn't grow with churn. */
  readonly #perIp = new Map<string, number>();
  /** addressKey → sockets subscribed to it. */
  readonly #subscribers = new Map<string, Set<WebSocket>>();
  /** authenticated socket → the addresses it's subscribed to (for O(own subs) cleanup on disconnect). */
  readonly #bySocket = new Map<WebSocket, Map<string, Address>>();
  /** Last status sent per subscribed address, so a status event only goes out on a real change. */
  readonly #lastStatus = new Map<string, string>();
  #lastCycle: CycleCompletedEvent | null = null;
  #unsubscribeBus: (() => void) | null = null;

  private constructor(options: StreamHubOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#accounts = options.accounts;
    this.#maxPerIp = options.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP;
    this.#authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  }

  static async create(bus: IndexerEventBus, options: StreamHubOptions): Promise<StreamHub> {
    const hub = new StreamHub(options);
    hub.#unsubscribeBus = await bus.subscribe((event) => hub.#onIndexerEvent(event));
    return hub;
  }

  /** Number of authenticated clients. */
  get clientCount(): number {
    return this.#bySocket.size;
  }

  /** Number of open connections, including ones still in the auth handshake. */
  get connectionCount(): number {
    return this.#clients.size;
  }

  /** Open connections from one remote address (as `normalizeIp` reports it). */
  connectionsFrom(ip: string): number {
    return this.#perIp.get(ip) ?? 0;
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

  /**
   * Start tracking a just-upgraded socket from `ip`. Over the per-IP cap, the socket is sent an
   * error event and closed straight away (an existing connection is never evicted to make room)
   * and this returns false. Otherwise the hub owns the socket from here: it must send a valid
   * `{ auth: { token } }` as its first message within the auth timeout, or it's told why and closed.
   */
  addClient(socket: WebSocket, ip: string): boolean {
    const open = this.connectionsFrom(ip);
    if (open >= this.#maxPerIp) {
      this.#refuse(socket, CLOSE_TOO_MANY_CONNECTIONS, `too many connections from this address (at most ${this.#maxPerIp} at once)`);
      return false;
    }
    this.#perIp.set(ip, open + 1);
    const timer = setTimeout(() => {
      this.#refuse(socket, CLOSE_AUTH_FAILED, `no auth message within ${this.#authTimeoutMs}ms`);
    }, this.#authTimeoutMs);
    timer.unref();
    this.#clients.set(socket, { phase: "awaiting_auth", ip, timer });
    socket.on("message", (data: RawData, isBinary: boolean) => this.#onRawMessage(socket, data, isBinary));
    socket.on("close", () => this.#removeClient(socket));
    socket.on("error", () => this.#removeClient(socket));
    return true;
  }

  async close(): Promise<void> {
    this.#unsubscribeBus?.();
    this.#unsubscribeBus = null;
    for (const socket of [...this.#clients.keys()]) {
      this.#removeClient(socket);
      socket.terminate();
    }
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  /** One error event, then a close whose reason repeats it (for clients that only see the close). */
  #refuse(socket: WebSocket, code: number, message: string): void {
    this.#send(socket, { event: "error", message });
    if (socket.readyState === WebSocket.OPEN) socket.close(code, message.slice(0, 120));
  }

  #onRawMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    const state = this.#clients.get(socket);
    if (!state) return;
    if (state.phase === "ready") {
      this.#onClientMessage(socket, data, isBinary);
      return;
    }
    if (state.phase === "authenticating") {
      // A client may pipeline its subscribes right behind its auth; they run, in order, once it resolves.
      if (state.pending.length >= MAX_PENDING_MESSAGES) {
        this.#refuse(socket, CLOSE_AUTH_FAILED, "too many messages sent before authentication finished");
        return;
      }
      state.pending.push({ data, isBinary });
      return;
    }
    // awaiting_auth: this has to be the auth message.
    const token = isBinary ? undefined : authToken(data);
    if (token === undefined) {
      this.#refuse(socket, CLOSE_AUTH_FAILED, 'authenticate first: the first message must be { "auth": { "token": "<session token>" } }');
      return;
    }
    clearTimeout(state.timer);
    const pending: { data: RawData; isBinary: boolean }[] = [];
    this.#clients.set(socket, { phase: "authenticating", ip: state.ip, pending });
    void this.#authenticate(socket, token, pending);
  }

  async #authenticate(socket: WebSocket, token: string, pending: { data: RawData; isBinary: boolean }[]): Promise<void> {
    let result: AuthResult<{ user: PublicUser }>;
    try {
      result = await this.#accounts.authenticate(token);
    } catch (cause) {
      // Never echo internal details (file paths) to the client.
      console.error("stream: session lookup failed", cause);
      this.#refuse(socket, CLOSE_AUTH_FAILED, "couldn't check the session right now; try again later");
      return;
    }
    const state = this.#clients.get(socket);
    if (!state || state.phase !== "authenticating") return; // gone while we were checking
    if (!result.ok) {
      this.#refuse(socket, CLOSE_AUTH_FAILED, `authentication failed: ${result.message}`);
      return;
    }
    this.#clients.set(socket, { phase: "ready", ip: state.ip });
    this.#bySocket.set(socket, new Map());
    this.#send(socket, { event: "authenticated" });
    for (const message of pending) this.#onClientMessage(socket, message.data, message.isBinary);
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
    const msg = parsed as { subscribe?: unknown; unsubscribe?: unknown; auth?: unknown } | null;
    if (msg && typeof msg === "object" && msg.auth !== undefined) {
      this.#send(socket, { event: "error", message: "already authenticated" });
      return;
    }
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
    const state = this.#clients.get(socket);
    if (state) {
      this.#clients.delete(socket);
      if (state.phase === "awaiting_auth") clearTimeout(state.timer);
      const left = this.connectionsFrom(state.ip) - 1;
      if (left > 0) this.#perIp.set(state.ip, left);
      else this.#perIp.delete(state.ip);
    }
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

export interface AttachStreamOptions {
  heartbeatMs?: number;
  /**
   * Exact browser origins allowed to open the stream. Defaults to `DEFAULT_ALLOWED_ORIGINS`. An
   * upgrade carrying any other `Origin` is refused with a 403 before the websocket exists. An
   * upgrade with **no** `Origin` header is allowed: browsers always send one on a websocket
   * upgrade, so its absence means a non-browser client — which could put any value there anyway,
   * and still has to authenticate. See ADR 0013 §6.
   */
  allowedOrigins?: readonly string[];
}

/** Ends a raw upgrade request with a plain HTTP error; the websocket is never created. */
function rejectUpgrade(socket: Duplex, status: string, message: string): void {
  socket.write(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
  socket.destroy();
}

/**
 * Mounts the websocket endpoint on an existing HTTP server at `STREAM_PATH`, via the server's
 * `upgrade` event — no second port. Any other upgrade path is refused, and so is an upgrade from a
 * browser origin that isn't allowed. A ping goes to every client each `heartbeatMs`; a client that
 * didn't answer the previous one is terminated, so a half-open connection (laptop lid closed,
 * network dropped) can't hold subscriptions forever.
 *
 * The per-IP cap uses `req.socket.remoteAddress` — the TCP peer. Behind a reverse proxy that's
 * the proxy, so every client shares one cap; `X-Forwarded-For` is deliberately not read, since
 * anyone can send it and trusting it unconditionally would let a client dodge the cap.
 */
export function attachStream(server: Server, hub: StreamHub, options: AttachStreamOptions = {}): AttachedStream {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== STREAM_PATH) {
      rejectUpgrade(socket, "404 Not Found", "not found");
      return;
    }
    const origin = req.headers["origin"];
    if (typeof origin === "string" && !allowedOrigins.has(origin)) {
      rejectUpgrade(socket, "403 Forbidden", `origin ${origin} is not allowed to open this stream`);
      return;
    }
    const ip = normalizeIp(req.socket.remoteAddress);
    if (!ip) {
      rejectUpgrade(socket, "400 Bad Request", "couldn't determine the client address");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!hub.addClient(ws, ip)) return; // over the per-IP cap: already told why and closed
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
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
