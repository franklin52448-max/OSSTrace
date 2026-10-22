import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { InMemoryCache, JsonFileLabelStore, type ChainAdapter, type ChainId } from "@osstrace/core";
import { WebSocket } from "ws";
import { LOOKUP_POPULARITY_TOPIC } from "../src/cachedLookup.ts";
import { InMemoryEventBus } from "../src/events.ts";
import { Indexer } from "../src/indexing.ts";
import { attachStream, MAX_SUBSCRIPTIONS_PER_CLIENT, StreamHub } from "../src/stream.ts";
import { ScriptedAdapter, TestClient, tx, withTempDir } from "./helpers.ts";

/**
 * End to end over a real socket: a real HTTP server with the stream attached, a real `ws` client,
 * the real Indexer and InMemoryEventBus. The only stand-in is the chain adapter (a scripted
 * history), and the indexer's timer — each "cycle" is triggered by calling runCycle() directly.
 */
interface Rig {
  adapter: ScriptedAdapter;
  cache: InMemoryCache;
  indexer: Indexer;
  hub: StreamHub;
  url: string;
  clock: { ms: number };
}

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
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
    const hub = await StreamHub.create(bus, { now });
    const server: Server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const stream = attachStream(server, hub);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      await run({ adapter, cache, indexer, hub, url: `ws://127.0.0.1:${port}/stream`, clock });
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
  await withRig(async ({ adapter, cache, indexer, url }) => {
    adapter.history = [tx(2), tx(1)];
    await makePopular(cache);
    await indexer.runCycle(); // baseline

    const client = await TestClient.connect(url);
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
  await withRig(async ({ url }) => {
    const client = await TestClient.connect(url);
    client.send({ subscribe: { chain: "ethereum", address: "0xwatched" } });
    const ack = await client.next<{ live: boolean; reason: string }>();
    assert.equal(ack.live, false);
    assert.match(ack.reason, /No indexer cycle has reached this server/);
    await client.close();
  });
});

test("an address the indexer doesn't refresh is told so, then gets a status event and pushes once it's indexed", async () => {
  await withRig(async ({ adapter, cache, indexer, url }) => {
    await makePopular(cache, "ethereum:0xsomeoneelse");
    await indexer.runCycle();

    const client = await TestClient.connect(url);
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
  await withRig(async ({ adapter, cache, indexer, url }) => {
    adapter.unavailable = "no ETHERSCAN_API_KEY configured";
    await makePopular(cache);
    await indexer.runCycle();
    const client = await TestClient.connect(url);
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
  await withRig(async ({ adapter, cache, indexer, url, clock }) => {
    adapter.history = [tx(1)];
    await makePopular(cache);
    await indexer.runCycle();
    const client = await TestClient.connect(url);
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
  await withRig(async ({ adapter, cache, indexer, url }) => {
    adapter.history = [tx(1)];
    await makePopular(cache);
    await indexer.runCycle();

    const watcher = await TestClient.connect(url);
    const bystander = await TestClient.connect(url);
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
  await withRig(async ({ hub, url }) => {
    const a = await TestClient.connect(url);
    const b = await TestClient.connect(url);
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
  await withRig(async ({ adapter, cache, indexer, url }) => {
    adapter.history = [tx(1)];
    await makePopular(cache);
    await indexer.runCycle();
    const client = await TestClient.connect(url);
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
  await withRig(async ({ url }) => {
    const client = await TestClient.connect(url);
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
  await withRig(async ({ url }) => {
    const client = await TestClient.connect(url);
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
