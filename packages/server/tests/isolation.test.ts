import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addressNodeId, DEFAULT_VISUALIZER_STATE } from "@osstrace/contract";
import { ETH_A, ETH_B, makeApp, signup, type Client, type TestApp } from "./helpers.ts";

/** User B must not be able to see or touch any of user A's objects; every attempt is a 404 (not 403). */
describe("authorization isolation between users", () => {
  let t: TestApp;
  let a: Client;
  let b: Client;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await makeApp();
    a = await signup(t.app, "owner_a");
    b = await signup(t.app, "intruder_b");
    ids.trace = (await a.post("/api/traces", { initialAddress: ETH_A })).json().id;
    ids.view = (await a.post("/api/views", { name: "v", state: DEFAULT_VISUALIZER_STATE })).json().id;
    ids.tag = (await a.post("/api/tags", { name: "secret-tag" })).json().id;
    ids.entity = (await a.post("/api/entities", { name: "Secret Fund" })).json().id;
    ids.label = (await a.post("/api/labels", { chain: "ethereum", address: ETH_B, name: "secret label", entityId: ids.entity })).json().id;
    ids.method = (await a.post("/api/settings/notification-methods", { kind: "webhook", name: "hook", url: "https://hooks.example.com/x" })).json().id;
    ids.alert = (await a.post("/api/alerts", { name: "watch", targets: [{ type: "address", chain: "ethereum", address: ETH_A }], direction: "both", methodIds: [ids.method] })).json().id;
    for (const [k, v] of Object.entries(ids)) expect(v, k).toBeTruthy();
  });
  afterAll(async () => t.close());

  it("every read, write and delete on A's objects is a 404 for B", async () => {
    const node = { id: addressNodeId(ids.trace!, "ethereum", ETH_B), kind: "address", chain: "ethereum", address: ETH_B, currentPosition: { x: 0, y: 0 }, createdAt: "x" };
    const attempts: [string, Promise<{ statusCode: number }>][] = [
      ["GET trace", b.get(`/api/traces/${ids.trace}`)],
      ["batch trace", b.post(`/api/traces/${ids.trace}/batch`, { ops: [{ type: "create_node", node }] })],
      ["agg summary", b.post(`/api/traces/${ids.trace}/aggregate-summary`, { fromNodeID: "a", toNodeID: "b" })],
      ["refresh edge", b.post(`/api/traces/${ids.trace}/edges/x/refresh`)],
      ["DELETE trace", b.del(`/api/traces/${ids.trace}`)],
      ["GET view", b.get(`/api/views/${ids.view}`)],
      ["batch view", b.post(`/api/views/${ids.view}/batch`, { ops: [{ type: "set_name", name: "pwned", clientTimestamp: "2030-01-01T00:00:00.000Z" }] })],
      ["send view", b.post(`/api/views/${ids.view}/send-to-tracer`, {})],
      ["DELETE view", b.del(`/api/views/${ids.view}`)],
      ["PATCH label", b.patch(`/api/labels/${ids.label}`, { name: "pwned" })],
      ["DELETE label", b.del(`/api/labels/${ids.label}`)],
      ["GET entity", b.get(`/api/entities/${ids.entity}`)],
      ["PATCH entity", b.patch(`/api/entities/${ids.entity}`, { name: "pwned" })],
      ["DELETE entity", b.del(`/api/entities/${ids.entity}`)],
      ["PATCH tag", b.patch(`/api/tags/${ids.tag}`, { name: "pwned" })],
      ["DELETE tag", b.del(`/api/tags/${ids.tag}`)],
      ["PATCH method", b.patch(`/api/settings/notification-methods/${ids.method}`, { name: "pwned" })],
      ["test method", b.post(`/api/settings/notification-methods/${ids.method}/test`)],
      ["DELETE method", b.del(`/api/settings/notification-methods/${ids.method}`)],
      ["GET alert", b.get(`/api/alerts/${ids.alert}`)],
      ["PATCH alert", b.patch(`/api/alerts/${ids.alert}`, { name: "pwned" })],
      ["alert events", b.get(`/api/alerts/${ids.alert}/events`)],
      ["DELETE alert", b.del(`/api/alerts/${ids.alert}`)],
    ];
    for (const [name, p] of attempts) expect((await p).statusCode, name).toBe(404);
  });

  it("B cannot reference A's entities, tags or methods from B's own objects", async () => {
    expect((await b.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "x", entityId: ids.entity })).statusCode).toBe(400);
    expect((await b.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "x", tagIds: [ids.tag] })).statusCode).toBe(400);
    expect((await b.post("/api/alerts", { name: "x", targets: [{ type: "entity", entityId: ids.entity }], direction: "in" })).statusCode).toBe(400);
    expect((await b.post("/api/alerts", { name: "x", targets: [{ type: "address", chain: "ethereum", address: ETH_A }], direction: "in", methodIds: [ids.method] })).statusCode).toBe(400);
  });

  it("lists, search and label joins only show the caller's own data", async () => {
    expect((await b.get("/api/traces")).json()).toEqual([]);
    expect((await b.get("/api/views")).json()).toEqual([]);
    expect((await b.get("/api/labels")).json().labels).toEqual([]);
    expect((await b.get("/api/entities")).json()).toEqual([]);
    expect((await b.get("/api/tags")).json()).toEqual([]);
    expect((await b.get("/api/alerts")).json()).toEqual([]);
    expect((await b.get("/api/search?q=secret")).json().hits).toEqual([]);
    const info = (await b.get(`/api/address/ethereum/${ETH_B}`)).json();
    expect(info.label).toBeNull();
    expect(info.entity).toBeNull();
    const mine = (await a.get(`/api/address/ethereum/${ETH_B}`)).json();
    expect(mine.label.name).toBe("secret label");
    expect(mine.entity.name).toBe("Secret Fund");
    // A's objects are intact after B's attempts
    expect((await a.get(`/api/traces/${ids.trace}`)).statusCode).toBe(200);
    expect((await a.get(`/api/views/${ids.view}`)).json().name).toBe("v");
  });
});
