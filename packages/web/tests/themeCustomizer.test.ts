import { afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { click, cleanup, consoleErrors, getByAriaLabel, render, text, type, waitFor } from "./harness/render.ts";

// The header's Theme menu against the real theme.ts store (see theme.test.ts for that module's own
// tests) — this file is about the React wiring: does the menu actually read/drive useTheme(), and
// does "Customize colors" render and edit every token it claims to.

let ThemeCustomizer: ComponentType;
type ThemeModule = typeof import("../src/theme.ts");
let theme: ThemeModule;
type MotionModule = typeof import("../src/motion.ts");
let motion: MotionModule;

before(async () => {
  theme = await import("../src/theme.ts");
  motion = await import("../src/motion.ts");
  ({ default: ThemeCustomizer } = await import("../src/ThemeCustomizer.tsx"));
});

// theme.ts's store is one module-level singleton (imported once, above) shared by every test in
// this file — unlike theme.test.ts, which gives each of its tests a fresh copy. So instead of
// touching the DOM directly, put the *real* store back to its default through its own real API:
// that repaints <html> correctly too, the same way a user picking "Dark" again would.
afterEach(async () => {
  await cleanup();
  theme.setPreset("dark");
  motion.setReduceMotion(false);
  window.localStorage.clear();
  consoleErrors.length = 0;
});

async function renderMenu() {
  const rendered = await render(createElement(ThemeCustomizer));
  return rendered.container;
}

function menuButton(root: ParentNode): HTMLButtonElement {
  const match = root.querySelector('button[aria-label="Theme"]');
  if (!(match instanceof window.HTMLButtonElement)) throw new Error("no theme menu button");
  return match;
}

function presetOption(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll('[role="radio"]')].find((el) => text(el).trim() === label);
  if (!(match instanceof window.HTMLButtonElement)) throw new Error(`no "${label}" theme option`);
  return match;
}

function buttonNamed(root: ParentNode, name: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((b) => text(b).trim() === name);
  if (!match) throw new Error(`no button "${name}"`);
  return match;
}

async function openCustomize(root: ParentNode): Promise<void> {
  await click(menuButton(root));
  await click(buttonNamed(root, "Customize colors"));
}

const htmlVar = (name: string): string => window.document.documentElement.style.getPropertyValue(name);

test("the menu is closed by default and opens on click with the three presets, Dark selected", async () => {
  const root = await renderMenu();
  assert.equal(root.querySelector('[role="dialog"]'), null);
  await click(menuButton(root));
  assert.ok(root.querySelector('[role="dialog"]'));
  const options = [...root.querySelectorAll('[role="radio"]')].map((el) => text(el).trim());
  assert.deepEqual(options, ["Dark", "Light", "Nord"]);
  assert.equal(presetOption(root, "Dark").getAttribute("aria-checked"), "true");
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");
  assert.deepEqual(consoleErrors, []);
});

test("picking Light repaints <html> light; picking Nord repaints it with Nord's own colors in dark mode", async () => {
  const root = await renderMenu();
  await click(menuButton(root));

  await click(presetOption(root, "Light"));
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(presetOption(root, "Light").getAttribute("aria-checked"), "true");
  assert.equal(htmlVar("--color-ground"), "#f7f7f8");

  await click(presetOption(root, "Nord"));
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(presetOption(root, "Nord").getAttribute("aria-checked"), "true");
  assert.equal(presetOption(root, "Light").getAttribute("aria-checked"), "false");
  assert.equal(htmlVar("--color-ground"), "#2e3440");
  assert.equal(htmlVar("--color-signal"), "#88c0d0");
});

test("Escape closes the menu", async () => {
  const root = await renderMenu();
  await click(menuButton(root));
  await act(async () => {
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(root.querySelector('[role="dialog"]'), null);
});

test("a pointerdown outside the menu closes it (the real event it listens for, not just a click)", async () => {
  const root = await renderMenu();
  await click(menuButton(root));
  await act(async () => {
    window.document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
  });
  assert.equal(root.querySelector('[role="dialog"]'), null);
});

test("Customize colors is collapsed until asked for, then lists every token's category", async () => {
  const root = await renderMenu();
  await click(menuButton(root));
  assert.equal(text(root).includes("Page background"), false);
  await click(buttonNamed(root, "Customize colors"));
  for (const category of ["Backgrounds", "Text", "Accent", "Status"]) assert.ok(text(root).includes(category), category);
  assert.ok(text(root).includes("Page background"));
  assert.ok(text(root).includes("Primary action"));
});

test("editing a token's color input repaints just that token's CSS variable and shows a reset button", async () => {
  const root = await renderMenu();
  await openCustomize(root);
  const signalInput = getByAriaLabel("Highlight accent", root);
  assert.equal(signalInput.type, "color");
  assert.equal(htmlVar("--color-signal"), "#8ea2ff"); // dark default

  await type(signalInput, "#ff00ff");
  assert.equal(htmlVar("--color-signal"), "#ff00ff");
  assert.equal(htmlVar("--color-ink"), "#ededef"); // untouched

  const resetButton = await waitFor(
    () => root.querySelector('button[aria-label="Reset Highlight accent"]:not([disabled])') as HTMLButtonElement | null,
    "the per-token reset button to appear",
  );
  await click(resetButton);
  assert.equal(htmlVar("--color-signal"), "#8ea2ff");
});

test("a tweak sits on top of Nord's values, and resetting it goes back to Nord's, not Dark's", async () => {
  const root = await renderMenu();
  await openCustomize(root);
  await click(presetOption(root, "Nord"));
  await type(getByAriaLabel("Highlight accent", root), "#ff00ff");
  assert.equal(htmlVar("--color-signal"), "#ff00ff");
  await click(buttonNamed(root, "Reset all to theme defaults"));
  assert.equal(htmlVar("--color-signal"), "#88c0d0");
});

test("Reset all is disabled with nothing overridden, enabled once something is, and clears it", async () => {
  const root = await renderMenu();
  await openCustomize(root);
  const resetAll = buttonNamed(root, "Reset all to theme defaults");
  assert.equal(resetAll.disabled, true);

  await type(getByAriaLabel("Highlight accent", root), "#ff00ff");
  assert.equal(resetAll.disabled, false);

  await click(resetAll);
  assert.equal(htmlVar("--color-signal"), "#8ea2ff");
  assert.equal(resetAll.disabled, true);
});

test("a choice made in the menu survives into a freshly rendered menu (persisted, not component-local state)", async () => {
  const root = await renderMenu();
  await openCustomize(root);
  await type(getByAriaLabel("Primary action", root), "#123456");

  const second = await renderMenu();
  await click(menuButton(second));
  assert.equal(presetOption(second, "Dark").getAttribute("aria-checked"), "true"); // the preset was never changed
  assert.equal(htmlVar("--color-helium"), "#123456");
});

test("Reduce motion: off by default, the switch turns it on site-wide (on <html>), saves it, and turns it back off", async () => {
  window.localStorage.clear();
  motion.setReduceMotion(false);
  const root = await renderMenu();
  await click(menuButton(root));
  const toggle = root.querySelector('[role="switch"]');
  assert.ok(toggle instanceof window.HTMLButtonElement, "a Reduce motion switch");
  assert.ok(text(toggle).includes("Reduce motion"));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(window.document.documentElement.hasAttribute("data-reduce-motion"), false);

  await click(toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(window.document.documentElement.hasAttribute("data-reduce-motion"), true);
  assert.equal(window.localStorage.getItem("osstrace.reduceMotion"), "true");
  assert.equal(motion.scrollBehavior(), "auto", "scrolls jump instead of gliding");

  await click(toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(window.document.documentElement.hasAttribute("data-reduce-motion"), false);
  assert.equal(motion.scrollBehavior(), "smooth");
});

test("Reduce motion is independent of the theme: switching preset leaves it on", async () => {
  const root = await renderMenu();
  await click(menuButton(root));
  await click(root.querySelector('[role="switch"]') as HTMLButtonElement);
  await click(presetOption(root, "Nord"));
  assert.equal(window.document.documentElement.hasAttribute("data-reduce-motion"), true);
  assert.equal(root.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "true");
});
