import { useSyncExternalStore } from "react";

/**
 * "Reduce motion" preference, set from the header's Theme menu (ThemeCustomizer.tsx).
 *
 * Until the visitor picks, it follows the OS setting (`prefers-reduced-motion`), live; once they
 * flip the switch, their choice is saved to localStorage (per browser, like the theme) and wins.
 * It's applied as `data-reduce-motion` on <html>, which index.css uses to stop CSS animations and
 * transitions site-wide; things CSS can't reach (the home hero's GPU animation, smooth scrolling)
 * read `useReduceMotion()` / `scrollBehavior()` instead.
 */

const STORAGE_KEY = "osstrace.reduceMotion";
const QUERY = "(prefers-reduced-motion: reduce)";

function readStored(): boolean | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "true" ? true : raw === "false" ? false : null;
  } catch {
    return null;
  }
}

const media = typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
let chosen: boolean | null = readStored();
let effective = chosen ?? media?.matches ?? false;
const listeners = new Set<() => void>();

function apply(): void {
  effective = chosen ?? media?.matches ?? false;
  if (effective) document.documentElement.setAttribute("data-reduce-motion", "");
  else document.documentElement.removeAttribute("data-reduce-motion");
  for (const listener of listeners) listener();
}

apply();
// With no saved choice, track the OS setting as it changes.
media?.addEventListener?.("change", () => {
  if (chosen === null) apply();
});

export function setReduceMotion(value: boolean): void {
  chosen = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage blocked (private mode etc.): the choice just won't survive a reload.
  }
  apply();
}

/** Whether motion is reduced right now (the saved choice, else the OS setting), for code outside React. */
export function reduceMotion(): boolean {
  return effective;
}

export function useReduceMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => effective,
  );
}

/** `behavior` for scrollTo / scrollIntoView: a jump instead of a glide when motion is reduced. */
export function scrollBehavior(): ScrollBehavior {
  return effective ? "auto" : "smooth";
}
