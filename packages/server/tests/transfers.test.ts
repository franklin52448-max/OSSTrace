import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../src/lib/errors.ts";
import { ETH_A, ETH_B, ETH_C, ethTransfer, makeApp, signup, type Client, type TestApp } from "./helpers.ts";

describe("transfers, counterparties and sync", () => {
  let t: TestApp;
  let c: Client;
  const base = Math.floor(Date.now() / 1000) - 86400;
  beforeEach(async () => {
    t = await makeApp();
    c = await signup(t.app, "analyst");
  });
  afterEach(async () => t.close());

  it("keyset cursor pages through every row exactly once (time and usd sorts)", async () => {
    const rows = Array.from({ length: 53 }, (_, i) => ethTransfer(i % 2 ? ETH_A : ETH_B, i % 2 ? ETH_B : ETH_A, base + Math.floor(i / 3), { amountRaw: String((i + 1) * 1e16) }));
    t.ctx.store.upsert(rows);
    t.ctx.db.run("INSERT INTO address_sync (chain, address, streams_json, covered_from, complete, head_at, updated_at) VALUES ('ethereum', ?, '{\"main\":{\"started\":true,\"cursor\":null,\"oldest\":0,\"newest\":0,\"done\":true}}', 0, 1, ?, ?)", ETH_A, new Date().toISOString(), new Date().toISOString());
    await t.ctx.sync.priceAddress("ethereum", ETH_A);
    for (const sort of ["time", "usd", "value"]) {
      for (const dir of ["desc", "asc"]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const r: any = (await c.get(`/api/transfers?base=ethereum:${ETH_A}&limit=7&sortKey=${sort}&sortDir=${dir}${cursor ? `&cursor=${cursor}` : ""}`)).json();
          expect(r.count).toEqual({ value: 53, capped: false });
          seen.push(...r.transfers.map((x: { id: string }) => x.id));
          cursor = r.nextCursor;
          pages++;
        } while (cursor && pages < 20);
        expect(new Set(seen).size, `${sort} ${dir}`).toBe(53);
        expect(pages).toBe(8);
      }
    }
    const first = (await c.get(`/api/transfers?base=ethereum:${ETH_A}&limit=3&sortKey=usd&sortDir=desc`)).json();
    expect(first.transfers[0].usd).toBeGreaterThanOrEqual(first.transfers[1].usd);
    expect((await c.get(`/api/transfers?base=ethereum:${ETH_A}&cursor=garbage`)).statusCode).toBe(400);
  });

  it("flow / counterparty / usd / token / time filters; count caps at 10,000", async () => {
    t.ctx.store.upsert([
      ethTransfer(ETH_B, ETH_A, base + 10),
      ethTransfer(ETH_A, ETH_B, base + 20),
      ethTransfer(ETH_A, ETH_C, base + 30, { amountRaw: "1000" }),
      ethTransfer(ETH_A, ETH_A, base + 40),
    ]);
    await t.ctx.sync.priceAddress("ethereum", ETH_A);
    const q = async (qs: string) => (await c.get(`/api/transfers?base=${ETH_A}&${qs}`)).json();
    expect((await q("flow=in")).count.value).toBe(1);
    expect((await q("flow=out")).count.value).toBe(2);
    expect((await q("flow=self")).count.value).toBe(1);
    expect((await q("flow=all")).count.value).toBe(4);
    expect((await q(`counterparties=ethereum:${ETH_C}`)).count.value).toBe(1);
    expect((await q("usdGte=1")).count.value).toBe(3);
    expect((await q("tokens=native&valueLte=0.5")).count.value).toBe(1);
    expect((await q(`timeGte=${new Date((base + 25) * 1000).toISOString()}`)).count.value).toBe(2);
    expect((await q(`timeLte=${(base + 15) * 1000}`)).count.value).toBe(1);
    expect((await c.get("/api/transfers")).statusCode).toBe(400);
    expect((await c.get("/api/transfers?base=notanaddress")).statusCode).toBe(400);

    const many = Array.from({ length: 10_005 }, (_, i) => ethTransfer(ETH_C, ETH_B, base + i));
    t.ctx.store.upsert(many);
    const capped = (await c.get(`/api/transfers?base=ethereum:${ETH_B}&limit=1`)).json();
    expect(capped.count).toEqual({ value: 10_000, capped: true });
  });

  it("counterparties group by counterparty, exclude self, sum usd and counts per flow", async () => {
    t.ctx.store.upsert([ethTransfer(ETH_B, ETH_A, base), ethTransfer(ETH_B, ETH_A, base + 1), ethTransfer(ETH_A, ETH_C, base + 2), ethTransfer(ETH_A, ETH_A, base + 3)]);
    await t.ctx.sync.priceAddress("ethereum", ETH_A);
    const r = (await c.get(`/api/address/ethereum/${ETH_A}/counterparties?flow=all`)).json();
    expect(r.counterparties).toEqual([
      expect.objectContaining({ address: expect.objectContaining({ address: ETH_B }), usd: 4000, transactionCount: 2, flow: "in", chains: ["ethereum"] }),
      expect.objectContaining({ address: expect.objectContaining({ address: ETH_C }), usd: 2000, transactionCount: 1, flow: "out" }),
    ]);
    expect(r.sync.provider).toBe("Fake ethereum");
  });

  it("request-driven sync: pages until the window is covered, reports partial, caches, and maps provider failures", async () => {
    const now = Math.floor(Date.now() / 1000);
    // 30 transfers, one per hour, page size 5: a 24h window needs ~5 pages.
    t.eth.add(Array.from({ length: 30 }, (_, i) => ethTransfer(ETH_B, ETH_A, now - i * 3600 - 10)));
    const noWindow = (await c.get(`/api/transfers?base=${ETH_A}&limit=50`)).json();
    expect(noWindow.transfers).toHaveLength(5); // head page only
    expect(noWindow.sync.state).toBe("partial");
    const day = (await c.get(`/api/transfers?base=${ETH_A}&limit=50&timeLast=24h`)).json();
    expect(day.transfers.length).toBe(24);
    expect(day.sync.state).toBe("ready");
    expect(Date.parse(day.sync.coveredFrom)).toBeLessThanOrEqual((now - 86400) * 1000);
    const all = (await c.get(`/api/transfers?base=${ETH_A}&limit=50&timeLast=1y`)).json();
    expect(all.transfers).toHaveLength(30);
    expect(all.sync.state).toBe("ready"); // history exhausted

    // Cached data survives a provider outage: state "error" with a message, data still served.
    t.eth.fail = new ProviderError("fake-ethereum", "fake-ethereum is rate limited", 7);
    t.ctx.db.run("UPDATE address_sync SET head_at = '2000-01-01T00:00:00.000000Z'");
    const cached = (await c.get(`/api/transfers?base=${ETH_A}&limit=50&timeLast=1y`)).json();
    expect(cached.transfers).toHaveLength(30);
    expect(cached.sync.state).toBe("error");
    expect(cached.sync.message).toMatch(/rate limited/);

    // Nothing cached + provider down = provider_error, never an empty "success".
    const fresh = await c.get(`/api/transfers?base=${ETH_C}`);
    expect(fresh.statusCode).toBe(502);
    expect(fresh.json()).toEqual({ error: { code: "provider_error", message: "fake-ethereum is rate limited", provider: { id: "fake-ethereum", retryAfterSec: 7 } } });
    expect(fresh.headers["retry-after"]).toBe("7");
  });

  it("multi-stream providers: one failing stream degrades to partial instead of failing the request", async () => {
    const t2 = await makeApp({}, { ethStreams: ["transactions", "internal"] });
    const c2 = await signup(t2.app, "multi");
    const now = Math.floor(Date.now() / 1000);
    t2.eth.add([ethTransfer(ETH_B, ETH_A, now - 10)], "transactions");
    const orig = t2.eth.fetchStreamPage.bind(t2.eth);
    t2.eth.fetchStreamPage = async (a, s, cur, b) => {
      if (s === "internal") throw new ProviderError("fake-ethereum", "fake-ethereum timed out", 5);
      return orig(a, s, cur, b);
    };
    const r = (await c2.get(`/api/transfers?base=${ETH_A}&timeLast=7d`)).json();
    expect(r.transfers).toHaveLength(1);
    expect(r.sync.state).toBe("partial");
    expect(r.sync.message).toMatch(/internal: fake-ethereum timed out/);
    await t2.close();
  });

  it("a chain whose provider changed: streams saved by the old provider are dropped, not left 'not loaded yet' forever", async () => {
    const now = Math.floor(Date.now() / 1000);
    // What a failed lookup under BNB's old Etherscan provider left behind: five streams, none started.
    const old = Object.fromEntries(["transactions", "internal-transactions", "token-transfers", "nft-transfers", "multi-token-transfers"].map((s) => [s, { started: false, cursor: null, oldest: null, newest: null, done: false, failUntil: Date.now() + 300_000, failMsg: "Etherscan refused BNB Smart Chain" }]));
    t.ctx.db.run(
      "INSERT INTO address_sync (chain, address, streams_json, covered_from, complete, head_at, last_error, updated_at) VALUES ('bnb', ?, ?, NULL, 0, NULL, 'Etherscan refused BNB Smart Chain', ?)",
      ETH_A,
      JSON.stringify(old),
      new Date().toISOString(),
    );
    t.bnb.add([ethTransfer(ETH_B, ETH_A, now - 10, { chain: "bnb" })]);
    const r = (await c.get(`/api/transfers?base=bnb:${ETH_A}&timeLast=7d`)).json();
    expect(r.transfers).toHaveLength(1);
    expect(r.sync.state).toBe("ready");
    expect(r.sync.message).toBeUndefined();
    const saved = JSON.parse(t.ctx.db.get<{ s: string }>("SELECT streams_json AS s FROM address_sync WHERE chain = 'bnb' AND address = ?", ETH_A)!.s);
    expect(Object.keys(saved)).toEqual(["main"]);
  });
});
