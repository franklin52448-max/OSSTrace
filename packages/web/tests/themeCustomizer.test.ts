import { afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, Fragment, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { click, cleanup, consoleErrors, getByAriaLabel, render, text, type, waitFor } from "./harness/render.ts";

// ThemeToggle + ThemeCustomizer against the real theme.ts store (see theme.test.ts for that
// module's own tests) — this file is about the React wiring: do the header controls actually
// read/drive useTheme(), and does the popover render and edit every token it claims to.

let ThemeToggle: ComponentType;
let ThemeCustomizer: ComponentType;
type ThemeModule = typeof import("../src/theme.ts");
let theme: ThemeModule;

before(async () => {
  theme = await import("../src/theme.ts");
  ({ ThemeToggle, default: ThemeCustomizer } = await import("../src/ThemeCustomizer.tsx"));
});

// theme.ts's store is one module-level singleton (imported once, above) shared by every test in
// this file — unlike theme.test.ts, which gives each of its tests a fresh copy. So instead of
// touching the DOM directly, put the *real* store back to its default through its own real API:
// that repaints <html> correctly too, the same way a user picking "Dark" again would.
afterEach(async () => {
  await cleanup();
  theme.setPreset("dark");
  window.localStorage.clear();
  consoleErrors.length = 0;
});

/** Both header controls together, as App.tsx actually renders them side by side. */
async function renderHeader() {
  const rendered = await render(createElement(Fragment, null, createElement(ThemeToggle), createElement(ThemeCustomizer)));
  return rendered.container;
}

function toggleButton(root: ParentNode): HTMLButtonElement {
  const match = root.querySelector('button[aria-label^="Switch to"]');
  if (!(match instanceof window.HTMLButtonElement)) throw new Error("no theme toggle button");
  return match;
}

function customizeButton(root: ParentNode): HTMLButtonElement {
  const match = root.querySelector('button[aria-label="Customize theme"]');
  if (!(match instanceof window.HTMLButtonElement)) throw new Error("no customize-theme button");
  return match;
}

test("starts in Dark: the toggle offers to switch to light, and <html> is painted dark", async () => {
  const root = await renderHeader();
  assert.equal(toggleButton(root).getAttribute("aria-label"), "Switch to light mode");
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");
  assert.deepEqual(consoleErrors, []);
});

test("clicking the toggle flips to Light and the button now offers to switch back", async () => {
  const root = await renderHeader();
  await click(toggleButton(root));
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(toggleButton(root).getAttribute("aria-label"), "Switch to dark mode");
  await click(toggleButton(root));
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");
});

test("the customize popover is closed by default and opens on click, listing every token's category", async () => {
  const root = await renderHeader();
  assert.equal(text(root).includes("Customize theme"), false);
  await click(customizeButton(root));
  assert.ok(text(root).includes("Customize theme"));
  for (const category of ["Backgrounds", "Text", "Accent", "Status"]) assert.ok(text(root).includes(category), category);
  assert.ok(text(root).includes("Page background"));
  assert.ok(text(root).includes("Primary action"));
});

test("Escape closes the popover", async () => {
  const root = await renderHeader();
  await click(customizeButton(root));
  assert.ok(text(root).includes("Customize theme"));
  await act(async () => {
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(text(root).includes("Customize theme"), false);
});

test("a pointerdown outside the popover closes it (the real event it listens for, not just a click)", async () => {
  const root = await renderHeader();
  await click(customizeButton(root));
  assert.ok(text(root).includes("Customize theme"));
  await act(async () => {
    window.document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
  });
  assert.equal(text(root).includes("Customize theme"), false);
});

test("editing a token's color input repaints just that token's CSS variable and shows a reset button", async () => {
  const root = await renderHeader();
  await click(customizeButton(root));
  const signalInput = getByAriaLabel("Highlight accent", root);
  assert.equal(signalInput.type, "color");
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-signal"), "#4fc4cf"); // dark default

  await type(signalInput, "#ff00ff");
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-signal"), "#ff00ff");
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-ink"), "#e6e8e6"); // untouched

  const resetButton = await waitFor(
    () => root.querySelector('button[aria-label="Reset Highlight accent"]:not([disabled])') as HTMLButtonElement | null,
    "the per-token reset button to appear",
  );
  await click(resetButton);
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-signal"), "#4fc4cf");
});

test("picking the Light preset in the panel repaints <html> and the toggle agrees", async () => {
  const root = await renderHeader();
  await click(customizeButton(root));
  const lightButton = [...root.querySelectorAll("button")].find((b) => text(b).trim() === "Light");
  assert.ok(lightButton);
  await click(lightButton!);
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(toggleButton(root).getAttribute("aria-label"), "Switch to dark mode");
});

test("Reset all to preset defaults is disabled with nothing overridden, enabled once something is, and clears it", async () => {
  const root = await renderHeader();
  await click(customizeButton(root));
  const resetAll = [...root.querySelectorAll("button")].find((b) => text(b).trim() === "Reset all to preset defaults") as HTMLButtonElement;
  assert.equal(resetAll.disabled, true);

  await type(getByAriaLabel("Highlight accent", root), "#ff00ff");
  assert.equal(resetAll.disabled, false);

  await click(resetAll);
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-signal"), "#4fc4cf");
  assert.equal(resetAll.disabled, true);
});

test("a choice made in the panel survives into a freshly rendered pair of controls (persisted, not component-local state)", async () => {
  const root = await renderHeader();
  await click(customizeButton(root));
  await type(getByAriaLabel("Primary action", root), "#123456");

  const second = await renderHeader();
  assert.equal(toggleButton(second).getAttribute("aria-label"), "Switch to light mode"); // still Dark, the preset was never changed
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-helium"), "#123456");
});
