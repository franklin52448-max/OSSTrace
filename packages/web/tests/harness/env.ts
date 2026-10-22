/**
 * Test environment for the web UI: a real DOM (jsdom) on `globalThis`, plus a Node module hook
 * that compiles `src/*.tsx` the way Vite does, so a test can import the real components.
 *
 * Import this before anything that loads React or react-dom (`render.ts` does it for you):
 * react-dom decides whether it has a DOM when it's first evaluated.
 *
 * Only two things are swapped compared with the browser build:
 * - JSX/TS is compiled with Oxc (via rolldown, the same transformer Vite 8 uses), in-process.
 * - `import.meta.env` is built from `process.env`'s `VITE_*` variables, as Vite does at build time,
 *   so a test points the UI at its own real API servers by setting `VITE_EXPLORER_URL` etc.
 *   before importing a component.
 * `fetch` and `WebSocket` stay Node's own: requests from the UI are real HTTP.
 */
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { transformSync } from "rolldown/experimental";

/** Where the web app thinks it's served from (its real dev-server origin). */
export const WEB_ORIGIN = "http://localhost:5301";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: `${WEB_ORIGIN}/`,
  pretendToBeVisual: true,
});
export const window = dom.window;

// Expose the DOM the way a browser does. Anything Node already has (fetch, WebSocket, URL, Event,
// timers, ...) is left as Node's: the UI's network calls must go over real sockets.
const target = globalThis as Record<string, unknown>;
target["window"] = window;
target["document"] = window.document;
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  Object.defineProperty(globalThis, key, {
    configurable: true,
    get: () => (window as unknown as Record<string, unknown>)[key],
  });
}
// Tells React this is a test environment that wraps updates in act().
target["IS_REACT_ACT_ENVIRONMENT"] = true;

const SRC_DIR = new URL("../../src/", import.meta.url).href;

function viteEnv(): Record<string, string | boolean> {
  const env: Record<string, string | boolean> = { MODE: "test", DEV: true, PROD: false, SSR: false, BASE_URL: "/" };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITE_") && value !== undefined) env[key] = value;
  }
  return env;
}

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(SRC_DIR) || !/\.tsx?$/.test(url)) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    const result = transformSync(filename, readFileSync(filename, "utf8"), {
      lang: url.endsWith(".tsx") ? "tsx" : "ts",
      sourceType: "module",
      jsx: { runtime: "automatic" },
    });
    if (result.errors.length > 0) {
      throw new Error(`compiling ${filename}:\n${result.errors.map((e) => e.message).join("\n")}`);
    }
    // Same line as the module's first line, so line numbers in stack traces don't shift.
    const env = `import.meta.env = ${JSON.stringify(viteEnv())};`;
    return { format: "module", source: env + result.code, shortCircuit: true };
  },
});
