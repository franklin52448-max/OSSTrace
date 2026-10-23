import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { cleanup, consoleErrors, render, settle, text } from "./harness/render.ts";

/**
 * The Tracer page with VITE_ENABLE_TRACER_AGENT unset -- every build's default. The agent panel
 * isn't announced yet: with the flag off there must be no toolbar button, no panel and no request
 * to the agent endpoint, whatever else the page does. (That a production build with the flag off
 * doesn't even contain the panel's code is checked against a real `vite build`, see flag.ts.)
 */

let TracerPage: ComponentType<{ source: unknown }>;
let QueryClientProvider: ComponentType<{ client: unknown }>;
let QueryClient: new (opts?: unknown) => unknown;
const requested: string[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  delete process.env["VITE_ENABLE_TRACER_AGENT"];
  process.env["VITE_SERVER_URL"] = "http://127.0.0.1:9"; // nothing listens: every call just fails fast
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested.push(String(input));
    return realFetch(input, init);
  }) as typeof fetch;
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
  await cleanup();
  globalThis.fetch = realFetch;
  delete process.env["VITE_SERVER_URL"];
});

test("flag unset: no Agent button, no agent panel, no agent request", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: Infinity } } });
  const initial = { title: "", notes: "", shareable: false, nodes: [], edges: [] };
  await render(createElement(QueryClientProvider, { client }, createElement(TracerPage, { source: { kind: "scratch", initial } })));
  await settle(50);
  assert.ok(text().includes("Find connections"), "the rest of the toolbar is there");
  assert.ok(![...document.querySelectorAll("button")].some((b) => text(b).trim() === "Agent"), "no Agent toggle");
  assert.equal(document.querySelector('aside[aria-label="Tracer agent"]'), null);
  assert.ok(!requested.some((u) => u.includes("tracer-agent")), requested.join("\n"));
  assert.ok(!consoleErrors.some((e) => /tracer-agent/i.test(e)));
});
