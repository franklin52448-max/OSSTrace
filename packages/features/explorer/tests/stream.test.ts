import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AccountService, JsonFileAccountStore } from "@osstrace/accounts";
import { InMemoryCache, JsonFileLabelStore, type ChainAdapter, type ChainId } from "@osstrace/core";
import { WebSocket } from "ws";
import { LOOKUP_POPULARITY_TOPIC } from "../src/cachedLookup.ts";
import { InMemoryEventBus } from "../src/events.ts";
import { Indexer } from "../src/indexing.ts";
import {
  attachStream,
  CLOSE_AUTH_FAILED,
  CLOSE_TOO_MANY_CONNECTIONS,
  MAX_CONNECTIONS_PER_IP,
  MAX_SUBSCRIPTIONS_PER_CLIENT,
  StreamHub,
} from "../src/stream.ts";
import { ScriptedAdapter, TestClient, tx, withTempDir } from "./helpers.ts";

/**
 * End to end over a real socket: a real HTTP server with the stream attached, a real `ws` client,
 * the real Indexer and InMemoryEventBus, and the real `@osstrace/accounts` service on a temp
 * accounts file (a real signup issues the session token every client authenticates with). The only
 * stand-ins are the chain adapter (a scripted history) and the indexer's timer — each "cycle" is
 * triggered by calling runCycle() directly.
 */
interface Rig {
  adapter: ScriptedAdapter;
  cache: InMemoryCache;
  indexer: Indexer;
  hub: StreamHub;
  accounts: AccountService;
  /** A real session token from a real signup. */
  token: string;
  url: string;
  clock: { ms: number };
}

interface RigOptions {
  allowedOrigins?: readonly string[];
  authTimeoutMs?: number;
}

const WEB_UI_ORIGIN = "http://localhost:5301";

async function withRig(run: (rig: Rig) => Promise<void>, options: RigOptions = {}): Promise<void> {
  await withTempDir(async (dir) => {
    const accounts = new AccountService(new JsonFileAccountStore(join(dir, "accounts.json")));
    const signup = await accounts.signup("watcher@example.com", "a real password 123");
    assert.ok(signup.ok, "signup in the test rig failed");
    const adapter = new ScriptedAdapter();
    const cache = new InMemoryCache();
    const bus = new InMemoryEventBus();
    const clock = { ms: Date.parse("2026-10-22T12:00:00.000Z") };
    const now = () => new Date(clock.ms);
    const indexer = new Indexer({
      registry: new Map<ChainId, ChainAdapter>([["ethereum", adapter]]),
      store: new JsonFileLabelStore(join(dir, "labels.json")),
      cache,
      bus,
      intervalMs: 30_000,
      topN: 20,
      now,
    });
    const hub = await StreamHub.create(bus, {
      now,
      accounts,
      ...(options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs }),
    });
    const server: Server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const stream = attachStream(server, hub, options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      await run({ adapter, cache, indexer, hub, accounts, token: signup.session.token, url: `ws://127.0.0.1:${port}/stream`, clock });
    } finally {
      await stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

async function makePopular(cache: InMemoryCache, key = "ethereum:0xwatched"): Promise<void> {
  await cache.recordHit(LOOKUP_POPULARITY_TOPIC, key);
}

/** Waits until the hub has noticed a disconnect (close is processed asynchronously server-side). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition never became true");
}

test("a subscriber is pushed the real transaction the indexer's next cycle finds", async () => {
  await withRig(async ({ adapter, cache, indexer, url, token }) => {
    adapter.history = [tx(2), tx(1)];
    await makePopular(cache);
    await indexer.runCycle(); // baseline

    const client = await TestClient.authed(url, token);
    // Checksum-cased input lands on the same lowercase key a lookup uses.
    client.send({ subscribe: { chain: "ethereum", address: "0xWATCHED" } });
    assert.deepEqual(await client.next(), { event: "subscribed", chain: "ethereum", address: "0xwatched", live: true });

    adapter.land(tx(3));
    await indexer.runCycle();
    const pushed = await client.next();
    assert.deepEqual(pushed, {
      event: "new_transaction",
      chain: "ethereum",
      address: "0xwatched",
      transaction: tx(3),
      detectedAt: "2026-10-22T12:00:00.000Z",
    });

    await indexer.runCycle();
    assert.equal(await client.silentFor(100), true, "a cycle with nothing new pushes nothing");
    await client.close();
  });
});

test("before any indexer cycle, a subscription is honestly not live", async () => {
  await withRig(async ({ url, token }) => {
    const client = await TestClient.authed(url, token);
    client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
    const ack = await client.next<{ live: boolean; reason: string }>();
    assert.equal(ack.live, false);
    assert.match(ack.reason, /No indexer cycle has reached this server/);
    await client.close();
  });
});

test("an address the indexer doesn't refresh is told so, then gets a status event and pushes once it's indexed", async () => {
  await withRig(async ({ adapter, cache, indexer, url, token }) => {
    await makePopular(cache, "ethereum:0xsomeoneelse");
    await indexer.runCycle();

    const client = await TestClient.authed(url, token);
    client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
    const ack = await client.next<{ live: boolean; cause: string; reason: string }>();
    assert.equal(ack.live, false);
    assert.equal(ack.cause, "not_indexed");
    assert.match(ack.reason, /isn't among the 20 most-looked-up addresses/);

    // Someone looks it up; the next cycle refreshes it (baseline) and the status flips.
    adapter.history = [tx(1)];
    await makePopular(cache);
    await indexer.runCycle();
    assert.deepEqual(await client.next(), { event: "status", chain: "ethereum", address: "0xwatched", live: true });

    adapter.land(tx(2));
    await indexer.runCycle();
    const pushed = await client.next<{ event: string; transaction: { hash: string } }>();
    assert.equal(pushed.event, "new_transaction");
    assert.equal(pushed.transaction.hash, "0xtx2");
    await client.close();
  });
});

test("unavailable history is reported as not live, with the adapter's own reason", async () => {
  await withRig(async ({ adapter, cache, indexer, url, token }) => {
    adapter.unavailable = "no ETHERSCAN_API_KEY configured";
    await makePopular(cache);
    await indexer.runCycle();
    const client = await TestClient.authed(url, token);
    client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
    const ack = await client.next<{ live: boolean; cause: string; reason: string }>();
    assert.equal(ack.live, false);
    assert.equal(ack.cause, "history_unavailable");
    assert.match(ack.reason, /no ETHERSCAN_API_KEY configured/);

    // A different error body next cycle is the same situation — no status event for reworded noise.
    adapter.unavailable = "429 Too many requests (request id 1234)";
    await indexer.runCycle();
    assert.equal(await client.silentFor(100), true);

    // Recovering is a real change and is announced.
    adapter.unavailable = null;
    await indexer.runCycle();
    assert.deepEqual(await client.next(), { event: "status", chain: "ethereum", address: "0xwatched", live: true });
    await client.close();
  });
});

test("a stopped indexer is detected at subscribe time", async () => {
  await withRig(async ({ adapter, cache, indexer, url, clock, token }) => {
    adapter.history = [tx(1)];
    await makePopular(cache);
    await indexer.runCycle();
    const client = await TestClient.authed(url, token);
    clock.ms += 60_000; // one missed cycle is within tolerance
    client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
    assert.equal((await client.next<{ live: boolean }>()).live, true);

    clock.ms += 31_000; // now past 2 × (interval + duration) + 30s
    client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
    const ack = await client.next<{ live: boolean; cause: string; reason: string }>();
    assert.equal(ack.live, false);
    assert.equal(ack.cause, "indexer_stopped");
    assert.match(ack.reason, /looks stopped/);
    await client.close();
  });
});

test("only subscribers of that address are pushed; unsubscribe stops pushes", async () => {
  await withRig(async ({ adapter, cache, indexer, url, token }) => {
    adapter.history = [tx(1)];
    await makePopular(cache);
    await indexer.runCycle();

    const watcher = await TestClient.authed(url, token);
    const bystander = await TestClient.authed(url, token);
    watcher.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
    bystander.send({ subscribe: { chain: "ethereum", address: "0xunrelated" } });
    await watcher.next();
    await bystander.next();

    adapter.land(tx(2));
    await indexer.runCycle();
    assert.equal((await watcher.next()).event, "new_transaction");
    assert.equal(await bystander.silentFor(100), true);

    watcher.send({ unsubscribe: { chain: "ethereum", address: "0xwatched" } });
    assert.deepEqual(await watcher.next(), { event: "unsubscribed", chain: "ethereum", address: "0xwatched" });
    adapter.land(tx(3));
    await indexer.runCycle();
    assert.equal(await watcher.silentFor(100), true);

    await watcher.close();
    await bystander.close();
  });
});

test("disconnecting drops every subscription the client held (no leaked state)", async () => {
  await withRig(async ({ hub, url, token }) => {
    const a = await TestClient.authed(url, token);
    const b = await TestClient.authed(url, token);
    a.send({ subscribe: { chain: "ethereum", address: "0x1" } });
    a.send({ subscribe: { chain: "solana", address: "So11111111111111111111111111111111111111112" } });
    b.send({ subscribe: { chain: "ethereum", address: "0x1" } });
    await a.next();
    await a.next();
    await b.next();
    assert.equal(hub.clientCount, 2);
    assert.equal(hub.subscribedAddressCount, 2);

    await a.close();
    await until(() => hub.clientCount === 1);
    assert.equal(hub.subscribedAddressCount, 1, "0x1 is still held by b; the Solana one is gone");

    b.socket.terminate(); // an abrupt drop, not a clean close
    await until(() => hub.clientCount === 0);
    assert.equal(hub.subscribedAddressCount, 0);
  });
});

test("a full window of new transactions also sends a possible_gap notice", async () => {
  await withRig(async ({ adapter, cache, indexer, url, token }) => {
    adapter.history = [tx(1)];
    await makePopular(cache);
    await indexer.runCycle();
    const client = await TestClient.authed(url, token);
    client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
    await client.next();

    for (let n = 2; n <= 30; n++) adapter.land(tx(n)); // 29 new — more than the 25-tx window
    await indexer.runCycle();
    const received: { event: string }[] = [];
    for (let i = 0; i < 26; i++) received.push(await client.next());
    assert.equal(received.filter((m) => m.event === "new_transaction").length, 25);
    assert.equal(received.at(-1)?.event, "possible_gap");
    await client.close();
  });
});

test("bad messages get an error event and the connection stays usable", async () => {
  await withRig(async ({ url, token }) => {
    const client = await TestClient.authed(url, token);
    client.socket.send("not json");
    assert.equal((await client.next()).event, "error");
    client.send({ hello: true });
    assert.equal((await client.next()).event, "error");
    client.send({ subscribe: { chain: "dogecoin", address: "D123" } });
    assert.match((await client.next<{ message: string }>()).message, /unsupported chain/);
    client.send({ subscribe: { chain: "ethereum", address: "" } });
    assert.equal((await client.next()).event, "error");
    client.send({ subscribe: { chain: "ethereum", address: "0xok" } });
    assert.equal((await client.next()).event, "subscribed");
    await client.close();
  });
});

test(`a connection can hold at most ${MAX_SUBSCRIPTIONS_PER_CLIENT} subscriptions`, async () => {
  await withRig(async ({ url, token }) => {
    const client = await TestClient.authed(url, token);
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CLIENT; i++) {
      client.send({ subscribe: { chain: "ethereum", address: `0x${i}` } });
      assert.equal((await client.next()).event, "subscribed");
    }
    client.send({ subscribe: { chain: "ethereum", address: "0xonetoomany" } });
    assert.match((await client.next<{ message: string }>()).message, /at most/);
    client.send({ subscribe: { chain: "ethereum", address: "0x0" } }); // re-subscribing an existing one is fine
    assert.equal((await client.next()).event, "subscribed");
    await client.close();
  });
});

test("upgrades on any path other than /stream are refused", async () => {
  await withRig(async ({ url }) => {
    const socket = new WebSocket(url.replace("/stream", "/elsewhere"));
    const outcome = await new Promise<string>((resolve) => {
      socket.once("open", () => resolve("open"));
      socket.once("error", () => resolve("refused"));
    });
    assert.equal(outcome, "refused");
  });
});

// --- Auth (ADR 0013 §6.1): a real @osstrace/accounts session, sent as the first message --------

test("a connection that never authenticates is told why and closed after the auth timeout", async () => {
  await withRig(
    async ({ hub, url }) => {
      const client = await TestClient.connect(url);
      const error = await client.next<{ event: string; message: string }>();
      assert.equal(error.event, "error");
      assert.match(error.message, /no auth message within 150ms/);
      const { code } = await client.closed();
      assert.equal(code, CLOSE_AUTH_FAILED);
      await until(() => hub.connectionCount === 0);
    },
    { authTimeoutMs: 150 },
  );
});

test("a subscribe before auth is refused and closes the socket; nothing gets subscribed", async () => {
  await withRig(async ({ hub, url }) => {
    const client = await TestClient.connect(url);
    client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
    const error = await client.next<{ event: string; message: string }>();
    assert.equal(error.event, "error");
    assert.match(error.message, /authenticate first/);
    const { code, reason } = await client.closed();
    assert.equal(code, CLOSE_AUTH_FAILED);
    assert.match(reason, /authenticate first/);
    assert.equal(hub.subscribedAddressCount, 0);
    assert.equal(hub.clientCount, 0);
  });
});

test("an invalid session token is refused with an error event and a close", async () => {
  await withRig(async ({ hub, url }) => {
    for (const token of ["not-a-token", "ots_madeUpButRightPrefix"]) {
      const client = await TestClient.connect(url);
      client.send({ auth: { token } });
      const error = await client.next<{ event: string; message: string }>();
      assert.deepEqual(error, { event: "error", message: "authentication failed: missing, invalid or expired session" });
      assert.equal((await client.closed()).code, CLOSE_AUTH_FAILED);
    }
    await until(() => hub.connectionCount === 0);
    assert.equal(hub.clientCount, 0);
  });
});

test("a token that was real but has been logged out no longer opens the stream", async () => {
  await withRig(async ({ accounts, token, url }) => {
    await accounts.logout(token);
    const client = await TestClient.connect(url);
    client.send({ auth: { token } });
    assert.match((await client.next<{ message: string }>()).message, /authentication failed/);
    assert.equal((await client.closed()).code, CLOSE_AUTH_FAILED);
  });
});

test("subscribes pipelined right behind the auth message are handled in order once it succeeds", async () => {
  await withRig(async ({ token, url }) => {
    const client = await TestClient.connect(url);
    client.send({ auth: { token } });
    client.send({ subscribe: { chain: "ethereum", address: "0xA" } });
    client.send({ subscribe: { chain: "ethereum", address: "0xB" } });
    assert.equal((await client.next()).event, "authenticated");
    assert.equal((await client.next<{ address: string }>()).address, "0xa");
    assert.equal((await client.next<{ address: string }>()).address, "0xb");
    client.send({ auth: { token } });
    assert.deepEqual(await client.next(), { event: "error", message: "already authenticated" });
    await client.close();
  });
});

// --- Origin check (ADR 0013 §6.2): refused at the upgrade, before any websocket exists ---------

/** Attempts an upgrade and reports either "open" or the HTTP status the server answered with. */
function upgradeOutcome(url: string, origin?: string): Promise<string | number> {
  const socket = new WebSocket(url, origin ? { origin } : {});
  return new Promise((resolve) => {
    socket.once("open", () => {
      socket.terminate();
      resolve("open");
    });
    socket.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    socket.once("error", () => resolve("error"));
  });
}

test("an upgrade from a disallowed Origin never completes (403), and leaves no connection behind", async () => {
  await withRig(
    async ({ hub, url }) => {
      assert.equal(await upgradeOutcome(url, "https://evil.example"), 403);
      assert.equal(await upgradeOutcome(url, "null"), 403, "a sandboxed/file:// page sends the literal origin 'null'");
      assert.equal(await upgradeOutcome(url, "http://localhost:5301.evil.example"), 403, "exact match, not a prefix");
      assert.equal(hub.connectionCount, 0);
    },
    { allowedOrigins: [WEB_UI_ORIGIN] },
  );
});

test("an allowed Origin, and a non-browser client with no Origin header, both get through", async () => {
  await withRig(
    async ({ url }) => {
      assert.equal(await upgradeOutcome(url, WEB_UI_ORIGIN), "open");
      assert.equal(await upgradeOutcome(url), "open");
    },
    { allowedOrigins: [WEB_UI_ORIGIN] },
  );
});

test("happy path from the web UI's origin: authenticated, subscribed, and pushed a real new transaction", async () => {
  await withRig(
    async ({ adapter, cache, indexer, token, url }) => {
      adapter.history = [tx(1)];
      await makePopular(cache);
      await indexer.runCycle(); // baseline

      const client = await TestClient.authed(url, token, { origin: WEB_UI_ORIGIN });
      client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
      assert.deepEqual(await client.next(), { event: "subscribed", chain: "ethereum", address: "0xwatched", live: true });
      adapter.land(tx(2));
      await indexer.runCycle();
      const pushed = await client.next<{ event: string; transaction: unknown }>();
      assert.equal(pushed.event, "new_transaction");
      assert.deepEqual(pushed.transaction, tx(2));
      await client.close();
    },
    { allowedOrigins: [WEB_UI_ORIGIN] },
  );
});

// --- Per-IP connection cap (ADR 0013 §6.3) -----------------------------------------------------

test(`one IP can hold ${MAX_CONNECTIONS_PER_IP} connections; the next is refused and none of the first are evicted`, async () => {
  await withRig(async ({ adapter, cache, hub, indexer, token, url }) => {
    adapter.history = [tx(1)];
    await makePopular(cache);
    await indexer.runCycle();

    const clients: TestClient[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) clients.push(await TestClient.authed(url, token));
    assert.equal(hub.connectionsFrom("127.0.0.1"), MAX_CONNECTIONS_PER_IP);

    const extra = await TestClient.connect(url); // the upgrade completes so the client can be told why
    const refusal = await extra.next<{ event: string; message: string }>();
    assert.equal(refusal.event, "error");
    assert.match(refusal.message, new RegExp(`too many connections from this address \\(at most ${MAX_CONNECTIONS_PER_IP} at once\\)`));
    const { code, reason } = await extra.closed();
    assert.equal(code, CLOSE_TOO_MANY_CONNECTIONS);
    assert.match(reason, /too many connections/);
    assert.equal(hub.connectionsFrom("127.0.0.1"), MAX_CONNECTIONS_PER_IP, "a refused connection isn't counted");

    // Every original connection still works end to end.
    for (const client of clients) {
      client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
      assert.equal((await client.next()).event, "subscribed");
    }
    adapter.land(tx(2));
    await indexer.runCycle();
    for (const client of clients) {
      const pushed = await client.next<{ event: string; transaction: { hash: string } }>();
      assert.equal(pushed.event, "new_transaction");
      assert.equal(pushed.transaction.hash, "0xtx2");
    }

    // Closing one frees exactly one slot.
    await clients.pop()!.close();
    await until(() => hub.connectionsFrom("127.0.0.1") === MAX_CONNECTIONS_PER_IP - 1);
    clients.push(await TestClient.authed(url, token));
    for (const client of clients) await client.close();
    await until(() => hub.connectionCount === 0);
  });
});

test("unauthenticated sockets count toward the per-IP cap too, and free their slot when they're closed", async () => {
  await withRig(
    async ({ hub, token, url }) => {
      const idle: TestClient[] = [];
      for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) idle.push(await TestClient.connect(url));
      const extra = await TestClient.connect(url);
      assert.equal((await extra.closed()).code, CLOSE_TOO_MANY_CONNECTIONS);

      // The idle ones hit the auth timeout, after which this IP can connect again.
      for (const client of idle) assert.equal((await client.closed()).code, CLOSE_AUTH_FAILED);
      await until(() => hub.connectionsFrom("127.0.0.1") === 0);
      const fresh = await TestClient.authed(url, token);
      await fresh.close();
    },
    { authTimeoutMs: 300 },
  );
});
