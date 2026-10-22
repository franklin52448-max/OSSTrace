import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import type { IndexerEvent } from "../src/events.ts";
import { RedisEventBus } from "../src/redisEventBus.ts";
import { tx } from "./helpers.ts";

/**
 * Against a real Redis (REDIS_TEST_URL, default redis://127.0.0.1:6379) — the actual cross-process
 * path between `npm run dev:indexer` and the Explorer API. Two separate RedisEventBus instances
 * mean two separate connections, exactly like two processes. Skips cleanly if no Redis is reachable.
 */
const REDIS_URL = process.env["REDIS_TEST_URL"] ?? "redis://127.0.0.1:6379";

async function redisReachable(): Promise<boolean> {
  const { hostname, port } = new URL(REDIS_URL);
  return await new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port || 6379) });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const reachable = await redisReachable();

test("an event published by one connection reaches a subscriber on another", { skip: !reachable && `no Redis at ${REDIS_URL}`, timeout: 5000 }, async () => {
  const channel = `osstrace:test:${randomUUID()}`; // never collides with a real indexer's channel
  const indexerSide = new RedisEventBus(REDIS_URL, channel);
  const serverSide = new RedisEventBus(REDIS_URL, channel);
  try {
    const received = new Promise<IndexerEvent>((resolve) => {
      void serverSide.subscribe((event) => resolve(event));
    });
    // subscribe() resolves once Redis has confirmed the SUBSCRIBE, so a publish after it can't be missed.
    await serverSide.subscribe(() => {});

    const event: IndexerEvent = {
      type: "new_transactions",
      address: { chain: "ethereum", value: "0xwatched" },
      transactions: [tx(7)],
      windowOverflow: false,
      detectedAt: "2026-10-22T12:00:00.000Z",
    };
    await indexerSide.publish(event);
    assert.deepEqual(await received, event);
  } finally {
    await indexerSide.close();
    await serverSide.close();
  }
});
