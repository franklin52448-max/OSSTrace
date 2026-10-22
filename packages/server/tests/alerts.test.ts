import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../src/lib/errors.ts";
import { ETH_A, ETH_B, ETH_C, ethTransfer, makeApp, signup, type Client, type TestApp } from "./helpers.ts";

describe("alerts worker", () => {
  let t: TestApp;
  let c: Client;
  beforeEach(async () => {
    t = await makeApp();
    c = await signup(t.app, "watcher");
  });
  afterEach(async () => t.close());

  const now = () => Math.floor(Date.now() / 1000);

  it("no backfill, fires once per (rule, transfer), filters direction/minUsd/tokens, delivers signed webhooks", async () => {
    // History that predates the rule must never fire.
    t.eth.add([ethTransfer(ETH_B, ETH_A, now() - 3600), ethTransfer(ETH_A, ETH_B, now() - 1800)]);
    const hook = (await c.post("/api/settings/notification-methods", { kind: "webhook", name: "ops", url: "https://hooks.example.com/osstrace", secret: "s3cret-key-123" })).json();
    const rule = (
      await c.post("/api/alerts", { name: "A inbound >= $100", targets: [{ type: "address", chain: "ethereum", address: ETH_A }], direction: "in", minUsd: 100, methodIds: [hook.id] })
    ).json();
    expect(rule).toMatchObject({ enabled: true, eventCount: 0, lastTriggeredAt: null, tokens: null });
    let r = await t.worker.tick();
    expect(r).toMatchObject({ rules: 1, addresses: 1, events: 0 });

    // New activity after the rule was armed (block time in the future relative to armed_at).
    const later = now() + 5;
    t.eth.add([
      ethTransfer(ETH_B, ETH_A, later), // inbound 1 ETH = $2000 -> fires
      ethTransfer(ETH_A, ETH_B, later), // outbound -> filtered by direction
      ethTransfer(ETH_C, ETH_A, later, { amountRaw: "10000000000000000" }), // 0.01 ETH = $20 -> below minUsd
    ]);
    r = await t.worker.tick();
    expect(r.events).toBe(1);
    expect(r.syncErrors).toBe(0);
    r = await t.worker.tick();
    expect(r.events).toBe(0); // once only

    const events = (await c.get(`/api/alerts/${rule.id}/events`)).json().events;
    expect(events).toHaveLength(1);
    expect(events[0].transfer).toMatchObject({ usd: 2000, amount: "1" });
    expect(events[0].matchedTarget).toEqual({ type: "address", chain: "ethereum", address: ETH_A });
    expect(events[0].deliveries.map((d: { status: string }) => d.status).sort()).toEqual(["sent", "sent"]); // in-app + webhook

    expect(t.sent).toHaveLength(1);
    const { body, headers } = t.sent[0]!;
    const expected = "sha256=" + createHmac("sha256", "s3cret-key-123").update(`${headers["x-osstrace-timestamp"]}.${body}`).digest("hex");
    expect(headers["x-osstrace-signature"]).toBe(expected);
    expect(JSON.parse(body)).toMatchObject({ type: "alert.event", event: { alertName: "A inbound >= $100" } });

    const inbox = (await c.get("/api/notifications?unread=1")).json();
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications[0]).toMatchObject({ alertName: "A inbound >= $100", alertId: rule.id, read: false });
    expect((await c.post("/api/notifications/read", { all: true })).statusCode).toBe(204);
    expect((await c.get("/api/notifications")).json().unreadCount).toBe(0);
    expect((await c.get(`/api/alerts/${rule.id}`)).json()).toMatchObject({ eventCount: 1 });
  });

  it("token filter, entity targets, disable/re-enable re-arms without backfill", async () => {
    const ent = (await c.post("/api/entities", { name: "Fund" })).json();
    await c.post("/api/labels", { chain: "ethereum", address: ETH_B, name: "fund wallet", entityId: ent.id });
    const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const rule = (await c.post("/api/alerts", { name: "fund usdc", targets: [{ type: "entity", entityId: ent.id }], direction: "both", tokens: [usdc.toLowerCase()] })).json();
    expect(rule.tokens).toEqual([usdc]);
    // Pretend the rule was armed an hour ago.
    t.ctx.db.run("UPDATE alerts SET armed_at = ? WHERE id = ?", new Date((now() - 3600) * 1000).toISOString(), rule.id);
    const erc20 = (id: string, at: number) => ethTransfer(ETH_A, ETH_B, at, { id, tokenId: usdc, tokenStandard: "erc20", tokenDecimals: 6, amountRaw: "5000000", priceCoin: `ethereum:${usdc}` });
    t.eth.add([erc20("0xaa_1", now() - 1800), ethTransfer(ETH_A, ETH_B, now() - 1800)]); // native one is filtered by tokens
    expect((await t.worker.tick()).events).toBe(1);
    // Disabled rules are not polled; activity while disabled never fires after re-enabling (re-armed at enable time).
    await c.patch(`/api/alerts/${rule.id}`, { enabled: false });
    t.eth.add([erc20("0xaa_2", now() - 60)]);
    expect((await t.worker.tick()).rules).toBe(0);
    await c.patch(`/api/alerts/${rule.id}`, { enabled: true });
    expect((await t.worker.tick()).events).toBe(0);
    t.eth.add([erc20("0xaa_3", now() + 5)]);
    expect((await t.worker.tick()).events).toBe(1);
    const evs = (await c.get(`/api/alerts/${rule.id}/events`)).json().events;
    expect(evs.map((e: { transfer: { id: string } }) => e.transfer.id).sort()).toEqual(["0xaa_1", "0xaa_3"]);
    expect(evs[0].matchedTarget).toEqual({ type: "entity", entityId: ent.id });
  });

  it("provider failures are logged and do not crash the tick; limits endpoint", async () => {
    await c.post("/api/alerts", { name: "x", targets: [{ type: "address", chain: "ethereum", address: ETH_A }], direction: "both" });
    t.eth.fail = new ProviderError("fake-ethereum", "fake-ethereum is rate limited", 5);
    const r = await t.worker.tick();
    expect(r).toMatchObject({ rules: 1, syncErrors: 1, events: 0 });
    t.eth.fail = null;
    expect((await t.worker.tick()).syncErrors).toBe(0);
    expect((await c.get("/api/alerts/limits")).json()).toEqual({ maxRules: 50, maxTargetsPerRule: 20, pollIntervalSec: 60 });
    const tooMany = Array.from({ length: 21 }, () => ({ type: "address", chain: "ethereum", address: ETH_A }));
    expect((await c.post("/api/alerts", { name: "x", targets: tooMany, direction: "in" })).statusCode).toBe(400);
  });

  it("webhook URLs that resolve to private addresses are refused; failed deliveries are recorded", async () => {
    const bad = await c.post("/api/settings/notification-methods", { kind: "webhook", name: "x", url: "https://internal.corp/hook" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/non-public/);
    expect((await c.post("/api/settings/notification-methods", { kind: "webhook", name: "x", url: "http://169.254.169.254/latest" })).statusCode).toBe(400);
    expect((await c.post("/api/settings/notification-methods", { kind: "webhook", name: "x", url: "file:///etc/passwd" })).statusCode).toBe(400);
    const methods = (await c.get("/api/settings/notification-methods")).json();
    expect(methods).toHaveLength(1);
    expect(methods[0].kind).toBe("in_app");
    expect((await c.del(`/api/settings/notification-methods/${methods[0].id}`)).statusCode).toBe(400);
  });
});
