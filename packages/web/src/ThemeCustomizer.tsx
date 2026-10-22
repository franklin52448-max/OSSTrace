// Header theme menu: pick one of the presets (Dark, Light, Nord), turn Reduce motion on or off, and
// optionally retint any themed color live under "Customize colors" (../theme.ts and ../motion.ts
// own the state and persistence — this file only renders them).
import { useEffect, useRef, useState } from "react";
import {
  THEME_CATEGORIES,
  THEME_PRESETS,
  THEME_TOKENS,
  hasOverride,
  presetValue,
  resetAllOverrides,
  resetToken,
  resolvedValue,
  setPreset,
  setTokenValue,
  useTheme,
  type ThemePreset,
  type ThemeToken,
} from "./theme.ts";
import { setReduceMotion, useReduceMotion } from "./motion.ts";
import { Button, cx } from "./prism/components.tsx";
import { IconArrowBackUp, IconCheck, IconChevronDown, IconPalette } from "./prism/icons.tsx";

const tokenByKey = (key: string): ThemeToken => THEME_TOKENS.find((t) => t.key === key)!;

export default function ThemeCustomizer() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
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
      <Button transparent circle className="small" aria-expanded={open} aria-label="Theme" onClick={() => setOpen((o) => !o)}>
        <IconPalette />
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Theme"
          className="card absolute right-0 top-[calc(100%+10px)] z-40 max-h-[calc(100vh-6rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto p-2"
        >
          <div className="px-2.5 pb-1.5 pt-1 text-xs text-ink-faint">Theme</div>
          <div role="radiogroup" aria-label="Theme preset" className="space-y-0.5">
            {THEME_PRESETS.map((preset) => (
              <PresetOption key={preset.key} preset={preset} selected={theme.preset === preset.key} />
            ))}
          </div>

          <div className="mt-2 border-t border-line pt-2">
            <ReduceMotionSwitch />
            <button
              type="button"
              aria-expanded={customizing}
              onClick={() => setCustomizing((c) => !c)}
              className="flex w-full items-center justify-between rounded-[10px] px-2.5 py-2 text-left text-sm font-medium text-ink-dim transition-colors duration-150 hover:bg-[var(--helium-elevated-10)] hover:text-ink"
            >
              Customize colors
              <IconChevronDown className={cx("!h-4 !w-4 text-ink-faint transition-transform duration-200", customizing && "rotate-180")} />
            </button>
            {customizing && (
              <div className="px-2.5 pb-1.5">
                <p className="mt-1 text-xs leading-relaxed text-ink-faint">Tweaks sit on top of the theme above and are saved on this device only.</p>
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
                  Reset all to theme defaults
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Stops animations and transitions site-wide, the home hero included. */
function ReduceMotionSwitch() {
  const reduced = useReduceMotion();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={reduced}
      onClick={() => setReduceMotion(!reduced)}
      className="flex w-full items-center justify-between gap-3 rounded-[10px] px-2.5 py-2 text-left text-sm font-medium text-ink-dim transition-colors duration-150 hover:bg-[var(--helium-elevated-10)] hover:text-ink"
    >
      <span>
        Reduce motion
        <span className="block text-xs font-normal text-ink-faint">Pauses the home animation and page transitions.</span>
      </span>
      <span
        aria-hidden="true"
        className={cx(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200",
          reduced ? "bg-helium" : "bg-[var(--helium-elevated-15)]",
        )}
      >
        <span className={cx("h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200", reduced ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
    </button>
  );
}

/** A preset row with a small preview of its own surfaces, text and accent. */
function PresetOption({ preset, selected }: { preset: ThemePreset; selected: boolean }) {
  const color = (key: string): string => presetValue(preset, tokenByKey(key));
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => setPreset(preset.key)}
      className={cx(
        "flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left text-sm font-medium text-ink transition-colors duration-150 hover:bg-[var(--helium-elevated-10)]",
        selected && "bg-[var(--helium-elevated-7)]",
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-11 shrink-0 items-end gap-1 overflow-hidden rounded-[6px] border p-1"
        style={{ background: color("ground"), borderColor: color("lineStrong") }}
      >
        <span className="h-full flex-1 rounded-[3px]" style={{ background: color("panel"), boxShadow: `inset 0 0 0 1px ${color("line")}` }} />
        <span className="flex h-full w-2.5 flex-col justify-end gap-0.5">
          <span className="h-1.5 rounded-full" style={{ background: color("ink") }} />
          <span className="h-1.5 rounded-full" style={{ background: color("helium") }} />
        </span>
      </span>
      <span className="flex-1">{preset.label}</span>
      <IconCheck className={cx("!h-4 !w-4 text-ink-dim", !selected && "invisible")} />
    </button>
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
