import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { fill } from "./harness/forms.ts";
import { cleanup, click, consoleErrors, getButton, getByLabelText, render, settle, text, waitFor } from "./harness/render.ts";
import { startNewServer, type RunningNewServer } from "./harness/newServer.ts";

/**
 * The agent panel end to end against a real, booted `@osstrace/server`: the real
 * /api/tracer-agent routes, the real tool loop and tools editing the real scratch doc the page
 * sends, the real per-browser anon allowance (its httpOnly cookie kept by the fetch wrapper below,
 * as a browser would). The only stand-in is the model provider: the server's outbound fetch to
 * OpenRouter answers from a script in OpenRouter's own response shape, so no key or model is used.
 */

const WEB_ORIGIN = "http://localhost:5301";
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const A = "0x1111111111111111111111111111111111111111";

type Step = { content?: string; tools?: { name: string; args: unknown }[] };
const modelScript: Step[] = [];

/** The server's outbound fetch: OpenRouter-shaped answers from `modelScript`. Anything else (the
 *  canvas's node-balance lookups reaching chain providers) gets a plain 404 -- not a 503, which the
 *  providers treat as retryable and back off on, holding a request open past the test's end. */
const outbound = (async (input: string | URL) => {
  if (String(input) !== OPENROUTER) return new Response(JSON.stringify({ error: "no chain providers in this test" }), { status: 404 });
  const step = modelScript.shift() ?? { content: "(script exhausted)" };
  const tool_calls = (step.tools ?? []).map((t, i) => ({ id: `call_${i}_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }));
  return new Response(
    JSON.stringify({ id: "gen", object: "chat.completion", choices: [{ index: 0, finish_reason: tool_calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: step.content ?? null, ...(tool_calls.length ? { tool_calls } : {}) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

// What a browser does for the page and Node's fetch doesn't: send the Origin, keep cookies.
const jar = new Map<string, string>();
const realFetch = globalThis.fetch;

let server: RunningNewServer;
let TracerPage: ComponentType<{ source: unknown }>;
let QueryClientProvider: ComponentType<{ client: unknown }>;
let QueryClient: new (opts?: unknown) => unknown;

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await realFetch(input, { ...init, headers: { ...(init.headers as Record<string, string>), origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) } });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair!.indexOf("=");
      jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
    return res;
  }) as typeof fetch;
  server = await startNewServer([WEB_ORIGIN], { configOverrides: { tracerAgentApiKey: "test-only-agent-key-not-a-credential" }, fetchImpl: outbound });
  process.env["VITE_SERVER_URL"] = server.url;
  process.env["VITE_ENABLE_TRACER_AGENT"] = "true";
  (globalThis as Record<string, unknown>)["ResizeObserver"] = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  ({ TracerPage } = (await import("../src/tracer/TracerPage.tsx")) as unknown as { TracerPage: typeof TracerPage });
  ({ QueryClientProvider, QueryClient } = (await import("@tanstack/react-query")) as unknown as { QueryClientProvider: typeof QueryClientProvider; QueryClient: typeof QueryClient });
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env["VITE_SERVER_URL"];
  delete process.env["VITE_ENABLE_TRACER_AGENT"];
  await server.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
  modelScript.length = 0;
});
afterEach(cleanup);

const nodeCards = () => [...document.querySelectorAll<HTMLElement>("[data-node-id]")];
const panel = () => document.querySelector<HTMLElement>('aside[aria-label="Tracer agent"]')!;

async function say(message: string): Promise<void> {
  const before = panel().querySelectorAll('[data-role="agent-reply"]').length;
  await fill(getByLabelText<HTMLTextAreaElement>("Message the agent"), message);
  await click(panel().querySelector<HTMLButtonElement>('button[type="submit"][aria-label="Send"]')!);
  await waitFor(() => panel().querySelectorAll('[data-role="agent-reply"]').length > before || panel().querySelector('[role="status"]'), `the answer to "${message}"`);
}

test("real server: the agent's tools edit the scratch canvas the page sent, and the visitor allowance runs out for real", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  await render(createElement(QueryClientProvider, { client }, createElement(TracerPage, { source: { kind: "scratch", initial: { title: "", notes: "", shareable: false, nodes: [], edges: [] } } })));
  await click(getButton("Agent"));
  await waitFor(() => text(panel()).includes("0 of 5 messages used"), "the server's own allowance");

  // 1: add a node (a real tool call, run by the real server against the doc this page sent).
  modelScript.push({ tools: [{ name: "add_node", args: { chain: "ethereum", address: A } }] }, { content: "Added that wallet to the canvas." });
  await say("add 0x1111…");
  assert.ok(text(panel()).includes("Added that wallet to the canvas."));
  assert.equal(nodeCards().length, 1, "the node is on this canvas");
  assert.ok(text(panel()).includes("Added 0x1111…1111"));
  assert.ok(text(panel()).includes("1 of 5 messages used"));

  // 2: name it -- the server can only find the node because the page sent the canvas as it now is.
  modelScript.push({ tools: [{ name: "rename_node", args: { nodeId: `ethereum:${A}`, label: "Hot wallet" } }] }, { content: "Named it." });
  await say("call it hot wallet");
  await waitFor(() => nodeCards()[0]?.getAttribute("aria-label")?.includes("Hot wallet"), "the new name on the card");

  // 3: remove it.
  modelScript.push({ tools: [{ name: "remove_node", args: { nodeId: `ethereum:${A}` } }] }, { content: "Removed it." });
  await say("remove that node");
  await waitFor(() => nodeCards().length === 0, "the node gone");

  // 4, 5: plain answers use up the rest of the allowance; then the page offers a wallet, not an input.
  modelScript.push({ content: "Sure." });
  await say("thanks");
  modelScript.push({ content: "Anytime." });
  await say("bye");
  await settle(30);
  assert.ok(text(panel()).includes("5 of 5 messages used"), text(panel()));
  assert.ok(text(panel()).includes("Connect your wallet for unlimited messages"));
  assert.equal(panel().querySelector("textarea"), null);
  assert.deepEqual(consoleErrors, []);
});
