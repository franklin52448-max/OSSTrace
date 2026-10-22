# ADR 0021 — Site theming: dark/light mode plus full per-token customization

Status: Decided and implemented 2026-10-22, in `packages/web/src/theme.ts` and
`packages/web/src/ThemeCustomizer.tsx`.

## Context

OSSTrace is an open-source project: anyone can fork it, self-host it, or run it as their own
brand of on-chain intelligence tool. Until now the whole UI was one fixed dark palette — true
black surfaces, periwinkle accent — hardcoded as literal hex values in two places: Tailwind's
`@theme` block in `index.css` (drives the utility classes most views use, e.g. `bg-ground`,
`text-ink`) and a second, parallel set of CSS variables in `prism/prism.css` (drives the
ported Prism component library — `Button`, `Input`, `Dropdown`, `Toggle`, …) that happened to
hold matching values but had no structural connection to the first set.

The ask was twofold: a visitor-facing dark/light toggle, and a fuller "customize the site" panel
(mirroring the screenshot — presets plus per-color swatches, grouped) so a fork or self-hosted
instance can retint the whole UI without touching code. Both need to actually repaint the whole
app, not just a few spot-checked components, which first required collapsing the two parallel
palettes into one.

## Decision

### 1. One token list is the only palette — `prism.css` aliases into it, not the reverse

`packages/web/src/theme.ts` declares `THEME_TOKENS`: every customizable color as
`{ key, cssVar, label, category, defaultDark, defaultLight }`. Each token's `cssVar` is one of
Tailwind's existing `@theme` custom properties (`--color-ground`, `--color-ink`, `--color-helium`,
…) — nothing new was invented there, since the Tailwind utilities (`bg-ground`, `text-ink`,
`border-line`, …) used across every view already read those.

`prism/prism.css`'s own variable names (`--primary`, `--background`, `--helium-blue`,
`--helium-elevated`, `--tooltip-bg`, …) are now aliases onto the same tokens
(`--primary: var(--color-ink);`, `--helium-blue: var(--color-helium);`, …) instead of their own
literal hex values. Two values that stay genuinely constant across every theme — `--white`
(an on-accent color, e.g. a checkmark glyph on a blue button, never a themed surface) and the
hover/press shades for the primary action color — are left as a literal and a `color-mix()`
derivation off the accent token, respectively, rather than given their own customizable tokens:
nobody needs to independently retint "blue button, 12% darker."

This means there's exactly one place a theme — built-in or a fork's own — sets color. A
contributor who wants a new customizable surface adds a `--color-*` property to the `@theme`
block (or points more CSS at an existing one) and pushes one entry onto `THEME_TOKENS`; nothing
else changes.

### 2. Values are applied as inline styles on `<html>`, not a CSS class or `prefers-color-scheme`

`applyTheme(state)` calls `document.documentElement.style.setProperty(cssVar, value)` for every
token, plus `documentElement.style.colorScheme` and a `data-theme="dark"|"light"` attribute (a
hook for the rare case something can't be a plain CSS var and needs an attribute selector — e.g.
`:root[data-theme="light"] .foo {}` — not used by anything today). An inline style on the
document root beats any stylesheet rule in the cascade without needing `!important`, so the rest
of the CSS — present and future — never has to know a theme system exists; it just reads a
`var(--color-*)` the way it always did.

This also sidesteps `prefers-color-scheme`: OSSTrace defaults to Dark, matching the existing
design, and a visitor's own OS preference is not auto-applied — the toggle is explicit, which
also keeps the mental model simple (what you clicked is what's active, not "it depends on your
OS and whether you've overridden it").

### 3. State: `{ preset, overrides }`, each a localStorage-only, per-browser choice

```ts
interface ThemeState {
  preset: string;                       // a THEME_PRESETS key, e.g. "dark" | "light"
  overrides: Record<string, string>;    // per-token tweaks on top of the preset, by ThemeToken.key
}
```

Saved under `osstrace.theme` in `localStorage`, read once at module load (mirroring
`session.ts`'s own module-level store pattern) and applied before React ever mounts — `main.tsx`
imports `theme.ts` first, and ES module evaluation order guarantees it (and its side-effecting
`applyTheme()` call) runs before `App.tsx`'s own body, so there's no flash of the wrong theme on
a return visit.

There is deliberately no server-side "site theme": every visitor's choice is their own, same as
a browser's zoom level or any other local display preference. A site operator who wants to ship a
*different default* for every visitor changes `THEME_PRESETS`' `dark` entry (or adds a new
default preset) in code — that is a deploy-time choice, not a runtime one, and needs no new
mechanism.

### 4. Presets are a starting point; per-token overrides sit on top, and switching presets clears them

`THEME_PRESETS` ships two: `Dark` (the existing design, unchanged) and `Light` (a real
light palette — not Dark's values naively inverted, since several accent/status colors tuned for
contrast on black lose it on white and needed their own, separately-chosen light-mode values
cross-checked for contrast). Adding a third preset (seasonal, a fork's own brand) is one entry in
`THEME_PRESETS`, giving `values` for only the tokens it changes from its mode's defaults.

`resolvedValue(state, token)` is `overrides[token.key] ?? presetValue(activePreset, token)` — an
override always wins. Picking a different preset (via the quick toggle or the panel) clears
`overrides`: a tweak made under one mode (e.g. a near-black "ink" pick that's fine on Dark's
black background) would silently misread as broken after switching to the other, so there is no
attempt to carry tweaks across a mode switch.

### 5. The customize panel (`ThemeCustomizer.tsx`) is generated from the token list, not hand-built per field

The popover — preset buttons, then every token as `[swatch, label, hex, reset]` grouped by
`category` — renders by mapping over `THEME_TOKENS`/`THEME_CATEGORIES`/`THEME_PRESETS`. It has no
per-token or per-preset code, so the "add more" ask (anyone can extend what's customizable) is
satisfied by the token list alone, not by touching this component. Each swatch is a plain
`<input type="color">` (no color-picker library); its native OS/browser picker is the whole UI.

### 6. The one place color genuinely can't be a CSS var: the WebGPU/WebGL hero background

The home page's hero (`AeroShards`/`Ferrofluid`, ported from reactbits.dev) paints to a
`<canvas>` with its own GPU-side lighting model — a CSS custom property can't reach into a
compiled shader. Both already accepted a `lightMode?: boolean` prop upstream (unused until now);
`HeroBackground` now reads `useThemeMode()` and passes it through, which is enough for the
shaders' own light/dark lighting branches to produce a readable composite in both modes. The
headline text sitting on top of that canvas is pinned to a fixed white (`!text-white`, not
`text-ink`) rather than following the theme: the canvas carries a fixed black radial scrim behind
the text "for legibility" (pre-existing, by design) in both themes, so the text needs to stay
fixed-light to stay legible against it, independent of whether the rest of the page just went
light.

## What this does not do

- **No server-stored "my theme" per account.** Signing in doesn't carry a saved theme across
  devices; it's local-storage-only, as described above. A future "save my theme to my account"
  feature would be additive (read the account's stored `ThemeState` on sign-in, same shape).
- **No contrast-checked custom combinations.** The two built-in presets are picked for contrast;
  a visitor who, say, sets "Page background" and "Primary text" to two colors with poor contrast
  gets exactly that — same as any other dApp/site color picker. Nothing stops a visitor from
  making their own view unreadable; nothing *can*, without becoming a second opinion on their
  taste.
- **Doesn't reach every pixel.** The WebGPU/WebGL hero canvas's own internal colors (shard tint,
  the fluid's three gradient stops) are fixed; only its `lightMode` lighting branch is wired to
  the theme. Retinting the hero's own colors to follow an operator's custom accent is future work,
  not needed for the ask here (a usable light mode, not a themed hero).

## Consequences

- Every existing view got dark/light "for free" the moment `prism.css`'s own variables became
  aliases — no other `.tsx` file needed to change, confirmed by rendering every major view in
  both modes.
- A fork or self-hosted instance can offer its own default palette with a one-line change
  (`THEME_PRESETS`), or let visitors fully retint via the panel that already ships — "make this
  project easy to re-skin" (the stated goal) didn't need a second mechanism beyond what visitors
  themselves use.
- Two palettes existed before this (Tailwind's and Prism's own); collapsing them into aliases is
  the only invasive part of this change, and is a one-time cost — any future token addition is a
  single new line, not a two-palette sync.

## What would change this decision

- If OSSTrace ever needs a server-rendered page (no client JS) to show the correct theme on first
  byte, the localStorage-read-before-paint trick stops working and a cookie-based approach (read
  server-side) would replace it. Not a concern today — this is a client-rendered SPA throughout.
- If the hero's own colors (not just its lighting mode) need to follow a custom accent, the
  shader props (`shardColor`, `accentColor`, `colors`) would need to read `resolvedValue()` for
  the relevant tokens, the same way `HeroBackground` already reads the mode.
