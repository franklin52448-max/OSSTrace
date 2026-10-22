import { Redis } from "ioredis";
import type { IndexerEvent, IndexerEventBus } from "./events.ts";

export const INDEXER_EVENTS_CHANNEL = "osstrace:indexer-events";

/**
 * Redis pub/sub between the indexer process and the Explorer API process (which hosts the
 * websocket endpoint). Pub/sub is fire-and-forget: a message published while no API process is
 * subscribed is gone, which is correct here — a push is only meaningful to a client connected at
 * the moment it happens, and anyone reconnecting re-reads the current state over HTTP.
 *
 * A subscribed Redis connection can't issue normal commands, so publishing and subscribing use
 * two separate connections; the subscriber one is only opened if `subscribe` is ever called.
 */
export class RedisEventBus implements IndexerEventBus {
  readonly #url: string;
  readonly #channel: string;
  readonly #publisher: Redis;
  #subscriber: Redis | null = null;
  #ready: Promise<void> | null = null;
  readonly #handlers = new Set<(event: IndexerEvent) => void>();

  constructor(redisUrl: string, channel = INDEXER_EVENTS_CHANNEL) {
    this.#url = redisUrl;
    this.#channel = channel;
    this.#publisher = new Redis(redisUrl);
  }

  async publish(event: IndexerEvent): Promise<void> {
    await this.#publisher.publish(this.#channel, JSON.stringify(event));
  }

  async subscribe(handler: (event: IndexerEvent) => void): Promise<() => void> {
    this.#handlers.add(handler);
    // Every caller waits for Redis to confirm the one SUBSCRIBE, not just the first — otherwise a
    // second concurrent caller could publish-and-expect before the channel is actually listened to.
    this.#ready ??= this.#openSubscriber();
    await this.#ready;
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async #openSubscriber(): Promise<void> {
    const subscriber = new Redis(this.#url);
    this.#subscriber = subscriber;
    subscriber.on("message", (channel: string, message: string) => {
      if (channel !== this.#channel) return;
      let event: IndexerEvent;
      try {
        event = JSON.parse(message) as IndexerEvent;
      } catch {
        return; // Not ours / malformed — never let one bad message take the API process down.
      }
      for (const h of [...this.#handlers]) h(event);
    });
    await subscriber.subscribe(this.#channel);
  }

  async close(): Promise<void> {
    this.#handlers.clear();
    await Promise.all([this.#publisher.quit(), this.#subscriber?.quit()]);
  }
}
