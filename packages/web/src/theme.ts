import { useSyncExternalStore } from "react";

/**
 * Site-wide theme system: a dark/light toggle plus full per-color customization (the "Customize
 * theme" panel, ThemeCustomizer.tsx).
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
  { key: "ground", cssVar: "--color-ground", label: "Page background", category: "Backgrounds", defaultDark: "#0e1112", defaultLight: "#edf0ef" },
  { key: "groundDeep", cssVar: "--color-ground-deep", label: "Graph background", category: "Backgrounds", defaultDark: "#0e1112", defaultLight: "#edf0ef" },
  { key: "panel", cssVar: "--color-panel", label: "Card background", category: "Backgrounds", defaultDark: "#15191b", defaultLight: "#ffffff" },
  { key: "raised", cssVar: "--color-raised", label: "Raised surface", category: "Backgrounds", defaultDark: "#1c2124", defaultLight: "#f3f5f4" },
  { key: "line", cssVar: "--color-line", label: "Border", category: "Backgrounds", defaultDark: "#252b2e", defaultLight: "#dbe0df" },
  { key: "lineStrong", cssVar: "--color-line-strong", label: "Strong border", category: "Backgrounds", defaultDark: "#353d41", defaultLight: "#bcc4c3" },
  // Text
  { key: "ink", cssVar: "--color-ink", label: "Primary text", category: "Text", defaultDark: "#e6e8e6", defaultLight: "#121718" },
  { key: "inkDim", cssVar: "--color-ink-dim", label: "Secondary text", category: "Text", defaultDark: "#a0a8a7", defaultLight: "#4f5859" },
  { key: "inkFaint", cssVar: "--color-ink-faint", label: "Faint text", category: "Text", defaultDark: "#7f8988", defaultLight: "#646e6f" },
  // Accent
  { key: "signal", cssVar: "--color-signal", label: "Highlight accent", category: "Accent", defaultDark: "#4fc4cf", defaultLight: "#0b7380" },
  { key: "helium", cssVar: "--color-helium", label: "Primary action", category: "Accent", defaultDark: "#4fc4cf", defaultLight: "#0b7380" },
  // Status
  { key: "inbound", cssVar: "--color-inbound", label: "Inbound / success", category: "Status", defaultDark: "#78c793", defaultLight: "#1b7a45" },
  { key: "outbound", cssVar: "--color-outbound", label: "Outbound", category: "Status", defaultDark: "#e3a35d", defaultLight: "#a3590f" },
  { key: "warn", cssVar: "--color-warn", label: "Warning", category: "Status", defaultDark: "#dcbf62", defaultLight: "#876a07" },
  { key: "danger", cssVar: "--color-danger", label: "Danger", category: "Status", defaultDark: "#ef7b6f", defaultLight: "#b8322a" },
  { key: "info", cssVar: "--color-info", label: "Info", category: "Status", defaultDark: "#4fc4cf", defaultLight: "#0b7380" },
  { key: "private", cssVar: "--color-private", label: "Private label", category: "Status", defaultDark: "#a993d8", defaultLight: "#6e55b0" },
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
