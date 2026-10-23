import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ETH_A, ETH_B, ETH_C, makeApp, signup, SOL_A, type TestApp } from "./helpers.ts";

describe("labels, entities, tags", () => {
  let t: TestApp;
  beforeEach(async () => (t = await makeApp()));
  afterEach(async () => t.close());

  it("CSV export -> import into another account -> export is identical (round trip, incl. formula guard)", async () => {
    const a = await signup(t.app, "exporter");
    const csv = [
      "chain,address,name,note,entity,tags",
      `ethereum,${ETH_A.toLowerCase()},Hot wallet 1,"note, with comma",Big Exchange,cex;hot`,
      `ethereum,${ETH_B},=HYPERLINK("x"),,Big Exchange,cex`,
      `solana,${SOL_A},Sol treasury,,,"treasury"`,
    ].join("\n");
    const imp = (await a.post("/api/labels/import", { format: "csv", data: csv, onConflict: "update" })).json();
    expect(imp).toEqual({ created: 3, updated: 0, skipped: [] });
    const ents = (await a.get("/api/entities")).json();
    expect(ents).toHaveLength(1);
    expect(ents[0]).toMatchObject({ name: "Big Exchange", addressCount: 2 });
    const out1 = await a.get("/api/labels/export?format=csv");
    expect(out1.headers["content-disposition"]).toMatch(/attachment; filename="osstrace-labels-\d{8}\.csv"/);
    expect(out1.body).toContain(`'=HYPERLINK`); // neutralised for spreadsheets
    expect(out1.body).toContain(ETH_A); // canonical checksum form

    const b = await signup(t.app, "importer");
    const imp2 = (await b.post("/api/labels/import", { format: "csv", data: out1.body, onConflict: "update" })).json();
    expect(imp2).toEqual({ created: 3, updated: 0, skipped: [] });
    const out2 = await b.get("/api/labels/export?format=csv");
    expect(out2.body).toBe(out1.body);
    const evil = (await b.get(`/api/labels?q=HYPERLINK`)).json();
    expect(evil.labels[0].name).toBe('=HYPERLINK("x")'); // stored as typed

    // re-import is idempotent
    const again = (await b.post("/api/labels/import", { format: "csv", data: out1.body, onConflict: "update" })).json();
    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.skipped.every((s: { reason: string }) => s.reason === "unchanged")).toBe(true);

    // JSON round trip as well
    const j = await b.get("/api/labels/export?format=json");
    const c = await signup(t.app, "jsonuser");
    expect((await c.post("/api/labels/import", { format: "json", data: j.body, onConflict: "skip" })).json()).toMatchObject({ created: 3 });
    expect((await c.get("/api/labels/export?format=json")).body).toBe(j.body);
  });

  it("import reports per-row errors and honours onConflict", async () => {
    const a = await signup(t.app, "importer2");
    await a.post("/api/labels", { chain: "ethereum", address: ETH_C, name: "existing" });
    const csv = [
      "chain,address,name,note,entity,tags",
      `bitcoin,${ETH_A},x,,,`, // line 2: bad chain
      `ethereum,0x1234,x,,,`, // line 3: bad address
      `ethereum,${ETH_A},,,,`, // line 4: no name
      `solana,${ETH_A},x,,,`, // line 5: address/chain mismatch
      `ethereum,${ETH_C},renamed,,,`, // line 6: exists
      `ethereum,${ETH_B},ok,,,`, // line 7: fine
    ].join("\n");
    const skip = (await a.post("/api/labels/import", { format: "csv", data: csv, onConflict: "skip" })).json();
    expect(skip.created).toBe(1);
    expect(skip.skipped.map((s: { row: number }) => s.row)).toEqual([2, 3, 4, 5, 6]);
    expect(skip.skipped[5 - 2 + 0].reason).toMatch(/solana/);
    const upd = (await a.post("/api/labels/import", { format: "csv", data: csv, onConflict: "update" })).json();
    expect(upd.updated).toBe(1);
    expect((await a.get("/api/labels?q=renamed")).json().total).toBe(1);
    expect((await a.post("/api/labels/import", { format: "csv", data: "foo,bar\n1,2", onConflict: "skip" })).statusCode).toBe(400);
    expect((await a.post("/api/labels/import", { format: "json", data: "{}", onConflict: "skip" })).statusCode).toBe(400);
    const js = (await a.post("/api/labels/import", { format: "json", data: JSON.stringify([{ chain: "ethereum", address: "nope", name: "x" }, { chain: "solana", address: SOL_A, name: "s", tags: ["a", "b"] }]), onConflict: "skip" })).json();
    expect(js).toMatchObject({ created: 1, skipped: [{ row: 1 }] });
  });

  it("CRUD, unique per address, entity name joined into AddressInfo, deleting an entity detaches labels", async () => {
    const a = await signup(t.app, "crud");
    const tag = (await a.post("/api/tags", { name: "cex", color: "#ff0000" })).json();
    const ent = (await a.post("/api/entities", { name: "Exchange X", type: "exchange", website: "https://x.example", tagIds: [tag.id] })).json();
    const lab = await a.post("/api/labels", { chain: "ethereum", address: ETH_A.toLowerCase(), name: "Hot 1", entityId: ent.id, tagIds: [tag.id] });
    expect(lab.statusCode).toBe(201);
    expect(lab.json()).toMatchObject({ address: ETH_A, entityId: ent.id, tagIds: [tag.id] });
    expect((await a.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "dup" })).statusCode).toBe(409);
    const info = (await a.get(`/api/address/ethereum/${ETH_A}`)).json();
    expect(info).toMatchObject({ entity: { name: "Exchange X", source: "user" }, label: { name: "Hot 1" } });
    expect(info.tags).toEqual([{ id: tag.id, name: "cex", color: "#ff0000" }]);
    expect((await a.get("/api/tags")).json()[0].usageCount).toBe(2);
    const full = (await a.get(`/api/entities/${ent.id}`)).json();
    expect(full.addresses).toHaveLength(1);
    const hits = (await a.get("/api/search?q=exch")).json().hits;
    expect(hits.find((h: { type: string }) => h.type === "entity")).toMatchObject({ name: "Exchange X", addressCount: 1 });
    // Labelled address: the label hit replaces the address hit for that same chain only -- the same
    // 0x address on every other EVM chain is a different (unlabelled) account and is still offered.
    const dupHits = (await a.get(`/api/search?q=${ETH_A.toLowerCase()}`)).json().hits;
    expect(dupHits.map((h: { type: string; chain: string }) => `${h.type}:${h.chain}`)).toEqual([
      "address:bnb",
      "address:robinhood",
      "address:base",
      "address:arbitrum",
      "address:optimism",
      "address:zora",
      "address:lens",
      "address:story",
      "address:gnosis",
      "address:ronin",
      "address:rootstock",
      "label:ethereum",
    ]);
    expect(dupHits.every((h: { address: string }) => h.address === ETH_A)).toBe(true);
    expect(dupHits.at(-1)).toMatchObject({ type: "label", chain: "ethereum", address: ETH_A, name: "Hot 1" });
    // `limit` caps label/entity matches, never the pasted address's own per-chain hits -- so however
    // many EVM chains there are (more than any limit), they can't push that address's label out.
    const capped = (await a.get(`/api/search?q=${ETH_A.toLowerCase()}&limit=1`)).json().hits;
    expect(capped.map((h: { type: string; chain: string }) => `${h.type}:${h.chain}`)).toEqual(dupHits.map((h: { type: string; chain: string }) => `${h.type}:${h.chain}`));
    // Unlabelled address: an address hit with info, one per EVM chain (Ethereum first).
    const addrHit = (await a.get(`/api/search?q=${ETH_B}`)).json().hits;
    expect(addrHit).toEqual([
      expect.objectContaining({ type: "address", chain: "ethereum", address: ETH_B, info: expect.objectContaining({ label: null }) }),
      expect.objectContaining({ type: "address", chain: "bnb", address: ETH_B, info: expect.objectContaining({ label: null }) }),
      expect.objectContaining({ type: "address", chain: "robinhood", address: ETH_B, info: expect.objectContaining({ label: null }) }),
      expect.objectContaining({ type: "address", chain: "base", address: ETH_B, info: expect.objectContaining({ label: null }) }),
      ...(["arbitrum", "optimism", "zora", "lens", "story", "gnosis", "ronin", "rootstock"] as const).map((chain) => expect.objectContaining({ type: "address", chain, address: ETH_B, info: expect.objectContaining({ label: null }) })),
    ]);
    expect((await a.patch(`/api/labels/${lab.json().id}`, { name: "Hot 1b", note: "n" })).json()).toMatchObject({ name: "Hot 1b", note: "n" });
    expect((await a.del(`/api/entities/${ent.id}`)).statusCode).toBe(204);
    const after = (await a.get(`/api/labels`)).json();
    expect(after.total).toBe(1);
    expect(after.labels[0].entityId).toBeNull();
    expect((await a.del(`/api/tags/${tag.id}`)).statusCode).toBe(204);
    expect((await a.get(`/api/labels`)).json().labels[0].tagIds).toEqual([]);
  });

  it("label list paginates with a cursor and filters", async () => {
    const a = await signup(t.app, "pager");
    const rows = ["chain,address,name"];
    for (let i = 0; i < 25; i++) rows.push(`ethereum,0x${(i + 1).toString(16).padStart(40, "0")},L${i}`);
    expect((await a.post("/api/labels/import", { format: "csv", data: rows.join("\n"), onConflict: "skip" })).json().created).toBe(25);
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const r: { total: number; labels: { id: string }[]; nextCursor: string | null } = (await a.get(`/api/labels?limit=7${cursor ? `&cursor=${cursor}` : ""}`)).json();
      expect(r.total).toBe(25);
      for (const l of r.labels) seen.add(l.id);
      cursor = r.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(25);
    expect((await a.get("/api/labels?chain=solana")).json().total).toBe(0);
    expect((await a.get("/api/labels?q=L1")).json().total).toBe(11); // L1, L10-L19
  });
});
