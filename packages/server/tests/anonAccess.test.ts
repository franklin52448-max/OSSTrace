import { describe, expect, it } from "vitest";
import { ANON_TX_CAP } from "../src/services/transfers.ts";
import { ETH_A, ETH_B, ethTransfer, makeApp, signup, Client, type TestApp } from "./helpers.ts";

/** Anon (signed-out) access to real chain data, and the ~100k-transaction depth cap that applies
 * only to it (ADR 0024). Connecting a wallet removes the cap and unlocks account-only features
 * (saving, entities) -- none of that is re-tested here, just the anon boundary itself. */
describe("anon mode: signed-out access + the anon transaction cap", () => {
  const base = Math.floor(Date.now() / 1000) - 86400;

  async function setup(): Promise<TestApp> {
    return makeApp();
  }

  it("address info, balances, counterparties and transfers all work with no session at all", async () => {
    const t = await setup();
    const anon = new Client(t.app);
    t.ctx.store.upsert([ethTransfer(ETH_B, ETH_A, base)]);
    await t.ctx.sync.priceAddress("ethereum", ETH_A);

    const info = await anon.get(`/api/address/ethereum/${ETH_A}`);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ address: ETH_A, chain: "ethereum", label: null });

    const balances = await anon.get(`/api/address/ethereum/${ETH_A}/balances`);
    expect(balances.statusCode).toBe(200);

    const cps = await anon.get(`/api/address/ethereum/${ETH_A}/counterparties?flow=all`);
    expect(cps.statusCode).toBe(200);
    expect(cps.json().counterparties).toHaveLength(1);

    const transfers = await anon.get(`/api/transfers?base=ethereum:${ETH_A}`);
    expect(transfers.statusCode).toBe(200);
    expect(transfers.json().transfers).toHaveLength(1);

    await t.close();
  });

  it("anon still has no private labels merged in -- another signed-in user's label on the same address never appears", async () => {
    const t = await setup();
    const owner = await signup(t.app, "label_owner");
    t.ctx.store.upsert([ethTransfer(ETH_B, ETH_A, base)]);
    await t.ctx.sync.priceAddress("ethereum", ETH_A);
    const created = await owner.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "My private name" });
    expect(created.statusCode).toBe(201);

    const anon = new Client(t.app);
    const info = await anon.get(`/api/address/ethereum/${ETH_A}`);
    expect(info.json().label).toBeNull();

    await t.close();
  });

  it("an entity: reference is rejected for an anon caller with a clear error, not a silent empty result", async () => {
    const t = await setup();
    const anon = new Client(t.app);
    const r = await anon.get(`/api/transfers?base=entity:anything`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/sign in/i);
    await t.close();
  });

  it("anon callers are capped at ANON_TX_CAP transactions per address; signed-in callers never are", async () => {
    const t = await setup();
    const anon = new Client(t.app);
    const signedIn = await signup(t.app, "regular_user");

    // Seed the address past the cap directly (bulk insert, not a real sync) so this test is fast and
    // isolates the cap check itself from the sync machinery already covered elsewhere.
    const many = Array.from({ length: ANON_TX_CAP + 5 }, (_, i) => ethTransfer(ETH_B, ETH_A, base - i));
    t.ctx.store.upsert(many);

    const anonResp = await anon.get(`/api/address/ethereum/${ETH_A}/counterparties?flow=all`);
    expect(anonResp.statusCode).toBe(200);
    expect(anonResp.json().sync.anonCapped).toBe(true);

    const signedResp = await signedIn.get(`/api/address/ethereum/${ETH_A}/counterparties?flow=all`);
    expect(signedResp.statusCode).toBe(200);
    expect(signedResp.json().sync.anonCapped).toBeFalsy();

    await t.close();
  });

  it("an address under the cap is not flagged, even for an anon caller", async () => {
    const t = await setup();
    const anon = new Client(t.app);
    t.ctx.store.upsert([ethTransfer(ETH_B, ETH_A, base)]);
    await t.ctx.sync.priceAddress("ethereum", ETH_A);

    const r = await anon.get(`/api/address/ethereum/${ETH_A}/counterparties?flow=all`);
    expect(r.json().sync.anonCapped).toBeFalsy();

    await t.close();
  });
});
