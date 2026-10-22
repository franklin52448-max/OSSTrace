import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { window } from "./harness/env.ts";

/**
 * theme.ts keeps one module-level store (like session.ts's), with a side effect on import: it
 * reads localStorage and paints <html> before React ever mounts. So — exactly like session.test.ts
 * — each test that touches that store gets a fresh copy via a `?case=` import, reading
 * localStorage as it is at that moment, the same as a fresh page load would.
 */
type ThemeModule = typeof import("../src/theme.ts");

let loads = 0;
async function freshTheme(): Promise<ThemeModule> {
  return (await import(`../src/theme.ts?case=${++loads}`)) as ThemeModule;
}

afterEach(() => {
  window.localStorage.clear();
  window.document.documentElement.removeAttribute("style");
  window.document.documentElement.removeAttribute("data-theme");
});

// --- Pure functions: no module state, so no fresh-import dance needed -----------------------

test("resolvedValue: an override wins over the preset", async () => {
  const theme = await freshTheme();
  const token = theme.THEME_TOKENS.find((t) => t.key === "signal")!;
  const dark = theme.THEME_PRESETS.find((p) => p.key === "dark")!;
  const state = { preset: "dark", overrides: { signal: "#ff00ff" } };
  assert.equal(theme.resolvedValue(state, token), "#ff00ff");
  assert.equal(theme.presetValue(dark, token), token.defaultDark);
});

test("resolvedValue falls back to the preset's mode default with no override", async () => {
  const theme = await freshTheme();
  const token = theme.THEME_TOKENS.find((t) => t.key === "ink")!;
  assert.equal(theme.resolvedValue({ preset: "dark", overrides: {} }, token), token.defaultDark);
  assert.equal(theme.resolvedValue({ preset: "light", overrides: {} }, token), token.defaultLight);
});

test("hasOverride only reports keys actually present in overrides", async () => {
  const theme = await freshTheme();
  assert.equal(theme.hasOverride({ preset: "dark", overrides: { ink: "#000000" } }, "ink"), true);
  assert.equal(theme.hasOverride({ preset: "dark", overrides: {} }, "ink"), false);
});

test("every token has a distinct key and a real #rrggbb default for both modes", async () => {
  const theme = await freshTheme();
  const keys = theme.THEME_TOKENS.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, "token keys must be unique");
  for (const token of theme.THEME_TOKENS) {
    assert.match(token.defaultDark, /^#[0-9a-f]{6}$/i, `${token.key} defaultDark`);
    assert.match(token.defaultLight, /^#[0-9a-f]{6}$/i, `${token.key} defaultLight`);
  }
});

test("THEME_CATEGORIES covers every category exactly once, in first-seen order", async () => {
  const theme = await freshTheme();
  const seen = [...new Set(theme.THEME_TOKENS.map((t) => t.category))];
  assert.deepEqual(theme.THEME_CATEGORIES, seen);
});

// --- The module-level store: localStorage + <html> are the real, observable effects ----------

test("with nothing stored, defaults to the dark preset and paints it onto <html> on import", async () => {
  const theme = await freshTheme();
  const ground = theme.THEME_TOKENS.find((t) => t.key === "ground")!;
  assert.equal(window.document.documentElement.style.getPropertyValue(ground.cssVar), ground.defaultDark);
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(window.document.documentElement.style.colorScheme, "dark");
});

test("setPreset('light') repaints every token to its light default", async () => {
  const theme = await freshTheme();
  theme.setPreset("light");
  for (const token of theme.THEME_TOKENS) {
    assert.equal(window.document.documentElement.style.getPropertyValue(token.cssVar), token.defaultLight, token.key);
  }
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(window.document.documentElement.style.colorScheme, "light");
});

test("setPreset('nord') paints every token from Nord's own values, as a dark-mode theme", async () => {
  const theme = await freshTheme();
  theme.setPreset("nord");
  const nord = theme.THEME_PRESETS.find((p) => p.key === "nord")!;
  for (const token of theme.THEME_TOKENS) {
    assert.ok(nord.values?.[token.key], `Nord sets ${token.key} itself rather than borrowing Dark's`);
    assert.equal(window.document.documentElement.style.getPropertyValue(token.cssVar), nord.values[token.key], token.key);
  }
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");
  assert.deepEqual(JSON.parse(window.localStorage.getItem("osstrace.theme")!), { preset: "nord", overrides: {} });
  // And a reload brings it back.
  await freshTheme();
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-ground"), "#2e3440");
});

test("setPreset ignores an unknown preset key (no throw, nothing changes)", async () => {
  const theme = await freshTheme();
  const ground = theme.THEME_TOKENS.find((t) => t.key === "ground")!;
  theme.setPreset("not-a-real-preset");
  assert.equal(window.document.documentElement.style.getPropertyValue(ground.cssVar), ground.defaultDark);
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");
});

test("setTokenValue overrides one token without touching the rest, and persists to localStorage", async () => {
  const theme = await freshTheme();
  const signal = theme.THEME_TOKENS.find((t) => t.key === "signal")!;
  const ink = theme.THEME_TOKENS.find((t) => t.key === "ink")!;
  theme.setTokenValue("signal", "#ff00ff");
  assert.equal(window.document.documentElement.style.getPropertyValue(signal.cssVar), "#ff00ff");
  assert.equal(window.document.documentElement.style.getPropertyValue(ink.cssVar), ink.defaultDark);
  assert.deepEqual(JSON.parse(window.localStorage.getItem("osstrace.theme")!), { preset: "dark", overrides: { signal: "#ff00ff" } });
});

test("resetToken removes just that one override", async () => {
  const theme = await freshTheme();
  const signal = theme.THEME_TOKENS.find((t) => t.key === "signal")!;
  theme.setTokenValue("signal", "#ff00ff");
  theme.setTokenValue("ink", "#111111");
  theme.resetToken("signal");
  assert.equal(window.document.documentElement.style.getPropertyValue(signal.cssVar), signal.defaultDark);
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-ink"), "#111111");
});

test("resetAllOverrides clears every override but keeps the preset", async () => {
  const theme = await freshTheme();
  theme.setPreset("light");
  theme.setTokenValue("signal", "#ff00ff");
  theme.setTokenValue("ink", "#111111");
  theme.resetAllOverrides();
  const signal = theme.THEME_TOKENS.find((t) => t.key === "signal")!;
  assert.equal(window.document.documentElement.style.getPropertyValue(signal.cssVar), signal.defaultLight);
  assert.deepEqual(JSON.parse(window.localStorage.getItem("osstrace.theme")!), { preset: "light", overrides: {} });
});

test("switching preset clears any overrides made under the previous one", async () => {
  const theme = await freshTheme();
  theme.setTokenValue("ink", "#111111"); // near-black override, fine on Dark's default background
  theme.setPreset("light");
  const ink = theme.THEME_TOKENS.find((t) => t.key === "ink")!;
  assert.equal(window.document.documentElement.style.getPropertyValue(ink.cssVar), ink.defaultLight);
  assert.deepEqual(JSON.parse(window.localStorage.getItem("osstrace.theme")!).overrides, {});
});

test("a saved choice survives a reload (a fresh import reads localStorage, like a fresh page load)", async () => {
  const first = await freshTheme();
  first.setPreset("light");
  first.setTokenValue("helium", "#ff00ff");

  const second = await freshTheme();
  const helium = second.THEME_TOKENS.find((t) => t.key === "helium")!;
  assert.equal(window.document.documentElement.style.getPropertyValue(helium.cssVar), "#ff00ff");
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "light");
});

test("garbage in localStorage (wrong shape, unknown preset, corrupt JSON) falls back to the dark default rather than throwing", async () => {
  window.localStorage.setItem("osstrace.theme", "{not json");
  const a = await freshTheme();
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");

  window.localStorage.setItem("osstrace.theme", JSON.stringify({ preset: "not-a-preset", overrides: {} }));
  const b = await freshTheme();
  assert.equal(window.document.documentElement.getAttribute("data-theme"), "dark");

  // A non-string override value (localStorage can be hand-edited) is dropped, not trusted as a CSS value.
  window.localStorage.setItem("osstrace.theme", JSON.stringify({ preset: "dark", overrides: { ink: 123 } }));
  const c = await freshTheme();
  const ink = c.THEME_TOKENS.find((t) => t.key === "ink")!;
  assert.equal(window.document.documentElement.style.getPropertyValue(ink.cssVar), ink.defaultDark);
  void a;
  void b;
});
