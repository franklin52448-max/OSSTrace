import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo as NetAddress } from "node:net";
import { act, createElement, type ComponentType } from "react";
import { addTransfersEdit, applyTraceOps, makeAddressNode, type TraceDoc, type TraceOp, type Transfer } from "@osstrace/contract";
import { window } from "./harness/env.ts";
import { fill } from "./harness/forms.ts";
import { cleanup, click, consoleErrors, getButton, getByLabelText, render, settle, text, waitFor } from "./harness/render.ts";

/**
 * The Tracer's AI agent panel on the real Tracer page (a scratch canvas, the real optimistic
 * store, the real canvas), with the build flag turned on. The one thing stood in for is the
 * agent's server side: a local HTTP server answering GET /api/tracer-agent/status and POST
 * /api/tracer-agent/chat in the shapes @osstrace/server's route sends -- replies whose `ops` are
 * built here with the same contract edit builders the server's tools use, the 503 "no model key
 * configured" answer, and a visitor's 429 at the message limit -- so these run without a model or a
 * key. Everything after the response (ops onto the canvas, undo, the counter, the states) is the
 * real UI code.
 */

const SCRATCH = "scratch";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const TX = "0x" + "ab".repeat(32);

const transfer: Transfer = {
  id: `${TX}_0`,
  chain: "ethereum",
  txHash: TX,
  blockNumber: 21_000_000,
  blockTimestamp: "2026-10-01T12:00:00Z",
  from: { chain: "ethereum", address: A },
  to: { chain: "ethereum", address: B },
  tokenId: "native",
  tokenSymbol: "ETH",
  tokenName: "Ether",
  tokenDecimals: 18,
  amountRaw: "1500000000000000000",
  amount: "1.5",
  usd: 3900,
  priceSource: "test",
};

type Status = { configured: boolean; signedIn: boolean; messageLimit: number | null; messagesRemaining: number | null };
type ChatBody = { docId: string; message: string; doc?: TraceDoc };
/** A scripted answer to one chat request; a function gets the request (so `doc` can be built from what the page sent). */
type Scripted = { status: number; body: unknown } | ((req: ChatBody) => { status: number; body: unknown });

let status: Status | null;
const script: Scripted[] = [];
const chatRequests: ChatBody[] = [];

let server: Server;
let TracerPage: ComponentType<{ source: unknown }>;
let QueryClientProvider: ComponentType<{ client: unknown }>;
let QueryClient: new (opts?: unknown) => unknown;

/** A real-shaped success body: `ops` applied to what the page sent, `doc` the result (as the route returns). */
function turn(req: ChatBody, reply: string, toolCalls: unknown[], ops: TraceOp[], messagesRemaining: number | null) {
  const before: TraceDoc = { title: req.doc?.title ?? "", notes: req.doc?.notes ?? "", shareable: false, nodes: req.doc?.nodes ?? [], edges: req.doc?.edges ?? [] };
  const after = applyTraceOps(before, ops).doc;
  return { status: 200, body: { reply, toolCalls, messagesRemaining, ops, doc: after } };
}

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/api/auth/me") return json(401, { error: { code: "unauthorized", message: "not signed in" } });
      if (req.url === "/api/tracer-agent/status") return status ? json(200, status) : json(500, { error: { code: "internal", message: "status unavailable" } });
      if (req.url === "/api/tracer-agent/chat" && req.method === "POST") {
        const body = JSON.parse(raw) as ChatBody;
        chatRequests.push(body);
        const next = script.shift();
        if (!next) return json(500, { error: { code: "internal", message: "test script ran out" } });
        const r = typeof next === "function" ? next(body) : next;
        return json(r.status, r.body);
      }
      // Anything else the canvas asks for (node balances) has no stand-in: a plain 404.
      return json(404, { error: { code: "not_found", message: "no stand-in for this route" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env["VITE_SERVER_URL"] = `http://127.0.0.1:${(server.address() as NetAddress).port}`;
  process.env["VITE_ENABLE_TRACER_AGENT"] = "true";
  // jsdom has no ResizeObserver; the page only uses it to measure itself (0x0 here, which it handles).
  (globalThis as Record<string, unknown>)["ResizeObserver"] = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // The page reads bare `localStorage` (inspector width, viewport); in a browser that's the window's.
  // Node has its own global of that name (which only warns without a backing file), so the harness's
  // "don't shadow Node's globals" rule leaves it in place -- point it at jsdom's, like a browser.
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
  // Nor scrollIntoView (the sidebar scrolls the selected node's row into view; no layout here).
  window.HTMLElement.prototype.scrollIntoView = () => {};
  ({ TracerPage } = (await import("../src/tracer/TracerPage.tsx")) as unknown as { TracerPage: typeof TracerPage });
  ({ QueryClientProvider, QueryClient } = (await import("@tanstack/react-query")) as unknown as { QueryClientProvider: typeof QueryClientProvider; QueryClient: typeof QueryClient });
});

after(async () => {
  delete process.env["VITE_SERVER_URL"];
  delete process.env["VITE_ENABLE_TRACER_AGENT"];
  server.closeAllConnections(); // Node's fetch keeps sockets alive; close() alone would wait on them
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  consoleErrors.length = 0;
  script.length = 0;
  chatRequests.length = 0;
  status = { configured: true, signedIn: false, messageLimit: 5, messagesRemaining: 5 };
});
afterEach(cleanup);

async function renderScratch(initial: TraceDoc = { title: "", notes: "", shareable: false, nodes: [], edges: [] }): Promise<void> {
  // gcTime Infinity: no 5-minute cache-collection timers left behind to keep the test process alive.
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  await render(createElement(QueryClientProvider, { client }, createElement(TracerPage, { source: { kind: "scratch", initial } })));
}

const nodeCards = () => [...document.querySelectorAll<HTMLElement>("[data-node-id]")];
/** Edges drawn on the canvas, by their value badges (the sidebar collapses while a node is selected). */
const edgeBadges = () => [...document.querySelectorAll<HTMLElement>(".kit-edge-badge")];
const agentPanel = () => document.querySelector<HTMLElement>('aside[aria-label="Tracer agent"]');
const steps = () => [...agentPanel()!.querySelectorAll('[aria-label="What the agent did"] li[data-status]')].map((li) => `${li.getAttribute("data-status")}: ${text(li).trim()}`);

async function openAgent(): Promise<HTMLElement> {
  await click(getButton("Agent"));
  const panel = await waitFor(() => agentPanel(), "the agent panel");
  await settle(30); // the status check
  return panel;
}

async function say(message: string): Promise<void> {
  await fill(getByLabelText<HTMLTextAreaElement>("Message the agent"), message);
  const send = agentPanel()!.querySelector<HTMLButtonElement>('button[type="submit"][aria-label="Send"]');
  if (!send) throw new Error("no Send button");
  await click(send);
}

async function replies(n: number): Promise<void> {
  await waitFor(() => agentPanel()!.querySelectorAll('[data-role="agent-reply"]').length >= n, `reply ${n}`);
}

test("a reply's ops land on the real canvas through the normal edit path, and one Undo takes the turn back", async () => {
  script.push((req) => {
    const a = makeAddressNode(SCRATCH, { chain: "ethereum", address: A }, { x: 0, y: 0 });
    const b = makeAddressNode(SCRATCH, { chain: "ethereum", address: B }, { x: 400, y: 0 });
    const withNodes = applyTraceOps({ title: "", notes: "", shareable: false, nodes: [], edges: [] }, [{ type: "create_node", node: a }, { type: "create_node", node: b }]).doc;
    const found = addTransfersEdit({ traceId: SCRATCH, doc: withNodes, transfers: [transfer], positionFor: () => ({ x: 200, y: 0 }) });
    return turn(
      req,
      "I added both wallets and found one direct transfer between them.",
      [
        { tool: "add_node", args: { chain: "ethereum", address: A }, result: { ok: true, nodeId: a.id, chain: "ethereum", address: a.address, alreadyOnCanvas: false } },
        { tool: "add_node", args: { chain: "ethereum", address: B }, result: { ok: true, nodeId: b.id, chain: "ethereum", address: b.address, alreadyOnCanvas: false } },
        { tool: "find_connections", args: {}, result: { ok: true, mode: "direct", nodesAdded: 0, pairsCompared: 1, connections: [{ a: a.id, b: b.id }], edgesAdded: 1, note: "Each connection is a real transfer found on-chain and drawn as an edge." } },
        { tool: "get_doc_state", args: {}, result: { ok: true, nodes: [] } },
      ],
      [{ type: "create_node", node: a }, { type: "create_node", node: b }, ...found.doOps],
      4,
    );
  });
  await renderScratch();
  assert.equal(nodeCards().length, 0);
  await openAgent();
  assert.ok(text(agentPanel()!).includes("0 of 5 messages used"), "the server's own count, before any message");
  await say("find connections between A and B");
  await replies(1);

  // What the page sent: the scratch canvas itself, since the server has no copy of it.
  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0]!.docId, "scratch");
  assert.equal(chatRequests[0]!.message, "find connections between A and B");
  assert.deepEqual(chatRequests[0]!.doc, { title: "", notes: "", nodes: [], edges: [] });

  assert.ok(text(agentPanel()!).includes("I added both wallets"));
  assert.equal(nodeCards().length, 2, "the canvas itself changed");
  assert.equal(edgeBadges().length, 1);
  assert.ok(text(edgeBadges()[0]!).includes("$3,900"), text(edgeBadges()[0]!));
  assert.deepEqual(steps(), [
    "applied: Added 0x1111…1111",
    "applied: Added 0x2222…2222",
    "applied: Found 1 direct connection, drew 1 edge",
    "read: Read the canvas",
  ]);
  assert.ok(text(agentPanel()!).includes("1 of 5 messages used"));

  // The same undo stack a manual edit uses: one step takes the whole turn back off the canvas.
  const undo = document.querySelector<HTMLButtonElement>('button[aria-label^="Undo: Agent changes"]');
  assert.ok(undo, "the agent's turn is on the normal undo stack");
  await click(undo);
  await waitFor(() => nodeCards().length === 0, "the turn undone");
  assert.equal(edgeBadges().length, 0);
  assert.deepEqual(consoleErrors, []);
});

test("follow-ups send the canvas as it now is, and act on it (rename, then remove that node)", async () => {
  const a = makeAddressNode(SCRATCH, { chain: "ethereum", address: A }, { x: 0, y: 0 });
  script.push(
    (req) => turn(req, "Named it.", [{ tool: "rename_node", args: { chain: "ethereum", address: A, label: "Hot wallet" }, result: { ok: true, nodeId: a.id, label: "Hot wallet" } }], [{ type: "set_node_label", id: a.id, label: "Hot wallet" }], 4),
    (req) => turn(req, "Removed it.", [{ tool: "remove_node", args: { chain: "ethereum", address: A }, result: { ok: true, removedNodeId: a.id, edgesRemoved: 0 } }], [{ type: "delete_node", id: a.id }], 3),
  );
  await renderScratch({ title: "Case 7", notes: "", shareable: false, nodes: [a], edges: [] });
  await openAgent();
  await say("call A hot wallet");
  await replies(1);
  assert.equal(chatRequests[0]!.doc?.nodes.length, 1);
  assert.equal(chatRequests[0]!.doc?.title, "Case 7");
  await waitFor(() => nodeCards()[0]?.getAttribute("aria-label")?.includes("Hot wallet"), "the card shows its new name");
  assert.ok(steps()[0]!.includes('Renamed a node to "Hot wallet"'));

  await say("remove that node");
  await replies(2);
  assert.equal(chatRequests[1]!.doc?.nodes[0]?.label, "Hot wallet", "the second message carried the renamed node");
  await waitFor(() => nodeCards().length === 0, "the node removed from the canvas");
  assert.ok(text(agentPanel()!).includes("Removed a node"));
  assert.ok(text(agentPanel()!).includes("2 of 5 messages used"));
  assert.deepEqual(consoleErrors, []);
});

test("before the first message: says what the agent works from and what it can't answer, and every example maps onto a real tool", async () => {
  await renderScratch();
  const panel = await openAgent();
  const t = text(panel);
  assert.ok(t.includes("It works only from real transfers on Solana, Ethereum, BNB Chain, Robinhood Chain and Base."), t);
  assert.ok(t.includes("It can't tell you who owns an address, predict what a wallet will do, or help with anything outside tracing, and it says so rather than guess."), t);
  assert.ok(t.includes("It can't see what you've selected, so name the address."), t);
  assert.ok(t.includes("Add 0x… and expand its top counterparties"));
  assert.ok(t.includes("List the largest transfers into 0x… in the last 30 days"));
  // expand_node adds counterparties from both directions: no example may promise one direction of it.
  assert.ok(!t.includes("who it sent funds to"), "no example promises a direction expand_node doesn't have");
  assert.deepEqual(consoleErrors, []);
});

test("not configured (status): says so from the start, with no input and no request to the model", async () => {
  status = { configured: false, signedIn: false, messageLimit: 5, messagesRemaining: 5 };
  await renderScratch();
  const panel = await openAgent();
  await waitFor(() => text(panel).includes("The AI agent isn't turned on yet"), "the not-configured state");
  assert.equal(panel.querySelector("textarea"), null, "no input that can't work");
  assert.ok(!text(panel).includes("messages used"));
  assert.equal(chatRequests.length, 0);
  // "Check again" really asks again.
  status = { configured: true, signedIn: false, messageLimit: 5, messagesRemaining: 5 };
  await click(getButton("Check again", panel));
  await waitFor(() => panel.querySelector("textarea"), "the input once the server says it's on");
  assert.deepEqual(consoleErrors, []);
});

test("not configured (503 on send): invents nothing, changes nothing, keeps the user's message", async () => {
  status = null; // status unreadable: the panel lets the user try, and the send tells the truth
  script.push({ status: 503, body: { error: { code: "not_configured", message: "The Tracer AI agent isn't set up on this server yet (no model provider key is configured)." } } });
  await renderScratch();
  await openAgent();
  await say("find connections between A and B");
  await waitFor(() => text(agentPanel()!).includes("The AI agent isn't turned on yet"), "the not-configured state");
  const panel = agentPanel()!;
  assert.equal(panel.querySelector('[data-role="agent-reply"]'), null, "no reply bubble was made up");
  assert.equal(panel.querySelector("textarea"), null);
  assert.ok(text(panel).includes("find connections between A and B"), "the user's own message stays visible");
  assert.equal(nodeCards().length, 0);
  assert.deepEqual(consoleErrors, []);
});

test("a visitor's last free message: 5 of 5 used, and the input becomes a connect-wallet prompt", async () => {
  status = { configured: true, signedIn: false, messageLimit: 5, messagesRemaining: 1 };
  script.push((req) => turn(req, "Done.", [], [], 0));
  await renderScratch();
  await openAgent();
  assert.ok(text(agentPanel()!).includes("4 of 5 messages used"));
  await say("hi");
  await waitFor(() => text(agentPanel()!).includes("5 of 5 messages used"), "the counter at the limit");
  const panel = agentPanel()!;
  assert.ok(text(panel).includes("Connect your wallet for unlimited messages"), text(panel));
  assert.equal(panel.querySelector("textarea"), null, "no input box that would only fail");
  let opened = 0;
  const onOpen = () => opened++;
  window.addEventListener("osstrace:open-login", onOpen);
  // openLogin() does `window.dispatchEvent(new Event(...))`; the harness leaves `Event` as Node's
  // own, which jsdom's window rejects. A browser has one Event: give the click jsdom's for its duration.
  const NodeEvent = globalThis.Event;
  globalThis.Event = window.Event as unknown as typeof Event;
  try {
    await click(getButton("Connect wallet", panel));
  } finally {
    globalThis.Event = NodeEvent;
    window.removeEventListener("osstrace:open-login", onOpen);
  }
  assert.equal(opened, 1, "the button opens the real wallet connect flow");
  assert.deepEqual(consoleErrors, []);
});

test("a visitor who already used every message gets the prompt straight away; a 429 at the limit shows it too", async () => {
  status = { configured: true, signedIn: false, messageLimit: 5, messagesRemaining: 0 };
  await renderScratch();
  const panel = await openAgent();
  await waitFor(() => text(panel).includes("Connect your wallet for unlimited messages"), "the prompt from status alone");
  assert.equal(panel.querySelector("textarea"), null);
  await cleanup();

  status = { configured: true, signedIn: false, messageLimit: 5, messagesRemaining: 2 }; // stale: another tab used them
  script.push({ status: 429, body: { error: { code: "rate_limited", message: "You've used all 5 free Tracer agent messages. Connect a wallet to keep going -- signed-in use is unlimited." } } });
  await renderScratch();
  await openAgent();
  await say("hi");
  await waitFor(() => text(agentPanel()!).includes("Connect your wallet for unlimited messages"), "the limit prompt");
  assert.equal(agentPanel()!.querySelector('[data-role="agent-reply"]'), null);
  assert.deepEqual(consoleErrors, []);
});

test("signed in (unlimited): no counter; a failing tool is reported as failed; other errors stay usable", async () => {
  status = { configured: true, signedIn: true, messageLimit: null, messagesRemaining: null };
  script.push(
    (req) => turn(req, "I couldn't expand it.", [{ tool: "expand_node", args: { chain: "ethereum", address: A, hops: 1 }, result: { ok: false, error: "The chain data provider is rate limited right now." } }], [], null),
    { status: 409, body: { error: { code: "conflict", message: "Still working on your previous message." } } },
  );
  await renderScratch();
  await openAgent();
  await say("expand A");
  await replies(1);
  const panel = agentPanel()!;
  assert.ok(!text(panel).includes("messages used"), "unlimited: no counter");
  assert.deepEqual(steps(), ["failed: The chain data provider is rate limited right now."]);
  assert.equal(nodeCards().length, 0);
  await say("again");
  await waitFor(() => panel.querySelector('[role="alert"]'), "the error notice");
  assert.ok(text(panel.querySelector('[role="alert"]')!).includes("Still working on your previous message."));
  assert.ok(panel.querySelector("textarea"), "still usable");
  assert.deepEqual(consoleErrors, []);
});

test("resize: dragging the left edge resizes the panel within bounds, clamps past them, persists, and double-click resets", async () => {
  window.localStorage.removeItem("osstrace:tracer-agent-width");
  status = { configured: false, signedIn: false, messageLimit: null, messagesRemaining: null };
  await renderScratch();
  const panel = await openAgent();
  const handle = panel.querySelector<HTMLElement>('[aria-label="Resize agent panel"]');
  assert.ok(handle, "a resize handle");
  assert.equal(panel.style.width, "340px", "starts at the default width");

  const drag = async (fromX: number, toX: number) => {
    await act(async () => {
      handle!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: fromX, clientY: 10 }));
      window.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: toX, clientY: 10 }));
      window.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: toX, clientY: 10 }));
    });
  };

  // Dragging the left edge left (lower clientX) widens the panel -- it docks on the page's right.
  await drag(300, 240);
  assert.equal(panel.style.width, "400px");
  assert.equal(window.localStorage.getItem("osstrace:tracer-agent-width"), "400", "saved for next time");

  // Clamped at both ends, even when the drag goes well past them.
  await drag(300, -5000);
  assert.equal(panel.style.width, "640px", "clamped at the max");
  await drag(300, 5000);
  assert.equal(panel.style.width, "280px", "clamped at the min");

  await act(async () => handle!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })));
  assert.equal(panel.style.width, "340px", "double-click resets to the default");
  assert.equal(window.localStorage.getItem("osstrace:tracer-agent-width"), null, "and clears the saved value");
  assert.deepEqual(consoleErrors, []);
});
