// Header theme controls: a one-click dark/light toggle, and the "Customize theme" popover that
// lets anyone retint every themed surface live (../theme.ts owns the token list and persistence —
// this file only renders it).
import { useEffect, useRef, useState } from "react";
import {
  THEME_CATEGORIES,
  THEME_PRESETS,
  THEME_TOKENS,
  hasOverride,
  resetAllOverrides,
  resetToken,
  resolvedValue,
  setPreset,
  setTokenValue,
  useTheme,
  useThemeMode,
  type ThemeToken,
} from "./theme.ts";
import { Button, cx } from "./prism/components.tsx";
import { IconArrowBackUp, IconMoon, IconPalette, IconSun, IconX } from "./prism/icons.tsx";

/** One click flips between the Dark and Light presets. Per-token tweaks reset on switch — see theme.ts. */
export function ThemeToggle() {
  const mode = useThemeMode();
  return (
    <Button
      transparent
      circle
      className="small"
      aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setPreset(mode === "dark" ? "light" : "dark")}
    >
      {mode === "dark" ? <IconSun /> : <IconMoon />}
    </Button>
  );
}

export default function ThemeCustomizer() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const anyOverridden = THEME_TOKENS.some((t) => hasOverride(theme, t.key));

  return (
    <div ref={rootRef} className="relative">
      <Button transparent circle className="small" aria-expanded={open} aria-label="Customize theme" onClick={() => setOpen((o) => !o)}>
        <IconPalette />
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Customize theme"
          className="card absolute right-0 top-[calc(100%+10px)] z-40 max-h-[calc(100vh-6rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="section-title">Customize theme</div>
            <Button transparent circle className="small !text-ink-faint" aria-label="Close" onClick={() => setOpen(false)}>
              <IconX />
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => setPreset(preset.key)}
                className={cx(
                  "flex items-center justify-center gap-2 rounded-ctl border px-3 py-2 text-sm font-medium transition-colors",
                  theme.preset === preset.key ? "border-signal/50 bg-signal/10 text-ink" : "border-line text-ink-dim hover:bg-raised",
                )}
              >
                {preset.mode === "dark" ? <IconMoon className="!h-4 !w-4" /> : <IconSun className="!h-4 !w-4" />}
                {preset.label}
              </button>
            ))}
          </div>

          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Pick a starting point, then fine-tune any color below. Saved on this device only.
          </p>

          {THEME_CATEGORIES.map((category) => (
            <div key={category} className="mt-4">
              <div className="section-title">{category}</div>
              <div className="mt-2 space-y-1.5">
                {THEME_TOKENS.filter((t) => t.category === category).map((token) => (
                  <TokenRow key={token.key} token={token} />
                ))}
              </div>
            </div>
          ))}

          <Button className="mt-4 w-full" disabled={!anyOverridden} onClick={() => resetAllOverrides()}>
            Reset all to preset defaults
          </Button>
        </div>
      )}
    </div>
  );
}

function TokenRow({ token }: { token: ThemeToken }) {
  const theme = useTheme();
  const value = resolvedValue(theme, token);
  const overridden = hasOverride(theme, token.key);
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="color"
        aria-label={token.label}
        value={value}
        onChange={(e) => setTokenValue(token.key, e.target.value)}
        className="h-7 w-7 shrink-0 cursor-pointer appearance-none rounded-md border border-line-strong bg-transparent p-0 [&::-webkit-color-swatch]:rounded-[5px] [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <span className="min-w-0 flex-1 truncate text-sm text-ink-dim">{token.label}</span>
      <span className="hash text-xs text-ink-faint">{value}</span>
      <button
        type="button"
        aria-label={`Reset ${token.label}`}
        disabled={!overridden}
        className="shrink-0 text-ink-faint transition-colors hover:text-ink disabled:opacity-0"
        onClick={() => resetToken(token.key)}
      >
        <IconArrowBackUp className="!h-3.5 !w-3.5" />
      </button>
    </div>
  );
}
