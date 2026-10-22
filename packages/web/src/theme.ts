import { useSyncExternalStore } from "react";

/**
 * Site-wide theme system: three presets (Dark, Light, Nord) plus full per-color customization (the
 * header's Theme menu, ThemeCustomizer.tsx).
 *
 * The whole app is painted from one list of CSS custom properties — THEME_TOKENS. Tailwind's
 * `@theme` block in index.css declares each one's default, and the ported Prism component styles
 * in prism/prism.css alias their own variable names onto the same tokens (see the comment there) —
 * so there's exactly one palette, not two. Making something new customizable, or adding a new
 * built-in preset, never touches this file's logic:
 *   - New customizable color: add a `--color-*` custom property to the `@theme` block in index.css
 *     (or reference an existing one from more CSS), then push one entry onto THEME_TOKENS below.
 *   - New preset (e.g. a seasonal palette, a brand variant): push one entry onto THEME_PRESETS,
 *     giving `values` for only the tokens it changes from its mode's defaults.
 * ThemeCustomizer.tsx renders both lists generically; it has no per-token or per-preset code.
 *
 * A value is "applied" by setting it as an inline style on <html> (`documentElement.style`), which
 * beats any stylesheet rule in the cascade without needing `!important` — so the rest of the CSS
 * never has to know a theme system exists. State is `{ preset, overrides }`: overrides are
 * per-token tweaks on top of whichever preset is selected, saved to localStorage (per browser —
 * there is no server-side "site theme," every visitor's choice is their own). Switching preset
 * clears overrides, since a tweak made in one mode (e.g. a near-black "ink" pick while on Light)
 * would misread as broken in the other.
 */

export interface ThemeToken {
  key: string;
  cssVar: `--${string}`;
  label: string;
  category: string;
  defaultDark: string;
  defaultLight: string;
}

export const THEME_TOKENS: readonly ThemeToken[] = [
  // Backgrounds
  { key: "ground", cssVar: "--color-ground", label: "Page background", category: "Backgrounds", defaultDark: "#000000", defaultLight: "#f7f7f8" },
  { key: "groundDeep", cssVar: "--color-ground-deep", label: "Graph background", category: "Backgrounds", defaultDark: "#000000", defaultLight: "#f2f2f4" },
  { key: "panel", cssVar: "--color-panel", label: "Card background", category: "Backgrounds", defaultDark: "#0a0a0b", defaultLight: "#ffffff" },
  { key: "raised", cssVar: "--color-raised", label: "Raised surface", category: "Backgrounds", defaultDark: "#131315", defaultLight: "#f1f1f3" },
  { key: "line", cssVar: "--color-line", label: "Border", category: "Backgrounds", defaultDark: "#1c1c1f", defaultLight: "#e4e4e7" },
  { key: "lineStrong", cssVar: "--color-line-strong", label: "Strong border", category: "Backgrounds", defaultDark: "#2a2a2e", defaultLight: "#d4d4d8" },
  // Text
  { key: "ink", cssVar: "--color-ink", label: "Primary text", category: "Text", defaultDark: "#ededef", defaultLight: "#18181b" },
  { key: "inkDim", cssVar: "--color-ink-dim", label: "Secondary text", category: "Text", defaultDark: "#a1a1a8", defaultLight: "#52525b" },
  { key: "inkFaint", cssVar: "--color-ink-faint", label: "Faint text", category: "Text", defaultDark: "#75757c", defaultLight: "#6b6b74" },
  // Accent
  { key: "signal", cssVar: "--color-signal", label: "Highlight accent", category: "Accent", defaultDark: "#8ea2ff", defaultLight: "#3450d1" },
  { key: "helium", cssVar: "--color-helium", label: "Primary action", category: "Accent", defaultDark: "#3450d1", defaultLight: "#3450d1" },
  // Status
  { key: "inbound", cssVar: "--color-inbound", label: "Inbound / success", category: "Status", defaultDark: "#4ad6a0", defaultLight: "#15803d" },
  { key: "outbound", cssVar: "--color-outbound", label: "Outbound", category: "Status", defaultDark: "#f5a35c", defaultLight: "#c2410c" },
  { key: "warn", cssVar: "--color-warn", label: "Warning", category: "Status", defaultDark: "#f4c76a", defaultLight: "#a16207" },
  { key: "danger", cssVar: "--color-danger", label: "Danger", category: "Status", defaultDark: "#f47b7b", defaultLight: "#dc2626" },
  { key: "info", cssVar: "--color-info", label: "Info", category: "Status", defaultDark: "#7cc4f5", defaultLight: "#0369a1" },
  { key: "private", cssVar: "--color-private", label: "Private label", category: "Status", defaultDark: "#b7a6f8", defaultLight: "#7c3aed" },
];

/** Category display order, derived from THEME_TOKENS itself — add a token in a new category and it shows up with no further wiring. */
export const THEME_CATEGORIES: readonly string[] = [...new Set(THEME_TOKENS.map((t) => t.category))];

export type ThemeMode = "dark" | "light";

export interface ThemePreset {
  key: string;
  label: string;
  mode: ThemeMode;
  /** Only the tokens this preset changes from its mode's defaults, keyed by ThemeToken.key. */
  values?: Record<string, string>;
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  { key: "dark", label: "Dark", mode: "dark" },
  { key: "light", label: "Light", mode: "light" },
  {
    // Nord (https://www.nordtheme.com): Polar Night surfaces, Snow Storm text, Frost accents, Aurora states.
    key: "nord",
    label: "Nord",
    mode: "dark",
    values: {
      ground: "#2e3440",
      groundDeep: "#2b303b",
      panel: "#353c4a",
      raised: "#3b4252",
      line: "#434c5e",
      lineStrong: "#4c566a",
      ink: "#eceff4",
      inkDim: "#d8dee9",
      inkFaint: "#a7b0c0",
      signal: "#88c0d0",
      helium: "#5e81ac",
      inbound: "#a3be8c",
      outbound: "#d08770",
      warn: "#ebcb8b",
      danger: "#bf616a",
      info: "#81a1c1",
      private: "#b48ead",
    },
  },
];
const DEFAULT_PRESET: ThemePreset = THEME_PRESETS[0]!;

export interface ThemeState {
  preset: string;
  /** Per-token overrides on top of the preset, keyed by ThemeToken.key. */
  overrides: Record<string, string>;
}

const STORAGE_KEY = "osstrace.theme";
const DEFAULT_STATE: ThemeState = { preset: DEFAULT_PRESET.key, overrides: {} };

function findPreset(key: string): ThemePreset {
  return THEME_PRESETS.find((p) => p.key === key) ?? DEFAULT_PRESET;
}

export function presetValue(preset: ThemePreset, token: ThemeToken): string {
  return preset.values?.[token.key] ?? (preset.mode === "dark" ? token.defaultDark : token.defaultLight);
}

/** The value actually in effect for a token: its override if set, else the active preset's value. */
export function resolvedValue(state: ThemeState, token: ThemeToken): string {
  return state.overrides[token.key] ?? presetValue(findPreset(state.preset), token);
}

function readStored(): ThemeState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<ThemeState>;
    if (typeof parsed.preset !== "string" || !THEME_PRESETS.some((p) => p.key === parsed.preset)) return DEFAULT_STATE;
    const overrides: Record<string, string> = {};
    if (parsed.overrides && typeof parsed.overrides === "object") {
      for (const token of THEME_TOKENS) {
        const value = (parsed.overrides as Record<string, unknown>)[token.key];
        if (typeof value === "string") overrides[token.key] = value;
      }
    }
    return { preset: parsed.preset, overrides };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeStored(next: ThemeState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked (private mode etc.): the choice just won't survive a reload.
  }
}

/** Paints every token onto <html> as an inline custom property. Exported so main.tsx can apply the saved theme before first paint. */
export function applyTheme(state: ThemeState): void {
  const root = document.documentElement;
  for (const token of THEME_TOKENS) root.style.setProperty(token.cssVar, resolvedValue(state, token));
  const mode = findPreset(state.preset).mode;
  root.style.colorScheme = mode;
  root.setAttribute("data-theme", mode);
}

let state: ThemeState = readStored();
applyTheme(state);
const listeners = new Set<() => void>();

function setState(next: ThemeState): void {
  state = next;
  writeStored(next);
  applyTheme(next);
  for (const listener of listeners) listener();
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** The resolved dark/light mode of the active preset — for the few things that can't be a CSS var (e.g. the WebGPU/WebGL hero background's own lighting model). */
export function useThemeMode(): ThemeMode {
  return findPreset(useTheme().preset).mode;
}

export function setPreset(presetKey: string): void {
  if (!THEME_PRESETS.some((p) => p.key === presetKey)) return;
  setState({ preset: presetKey, overrides: {} });
}

export function setTokenValue(tokenKey: string, value: string): void {
  setState({ ...state, overrides: { ...state.overrides, [tokenKey]: value } });
}

export function resetToken(tokenKey: string): void {
  const rest = { ...state.overrides };
  delete rest[tokenKey];
  setState({ ...state, overrides: rest });
}

export function resetAllOverrides(): void {
  setState({ ...state, overrides: {} });
}

export function hasOverride(themeState: ThemeState, tokenKey: string): boolean {
  return tokenKey in themeState.overrides;
}
