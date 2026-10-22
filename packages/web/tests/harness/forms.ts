/**
 * Form helpers for controls `render.ts`'s `type()` doesn't cover: textareas, selects and
 * checkboxes, plus finding a control by its placeholder or `aria-label` whatever its element
 * type. Same rule as `render.ts`: React only sees a change through the real DOM event a browser
 * would fire (`input` for text, `change` for a select), with the value set through the
 * element's own native setter.
 */
import { window } from "./env.ts";
import { act } from "react";

export type TextControl = HTMLInputElement | HTMLTextAreaElement;

/** Sets a text input's or textarea's value the way typing does. */
export async function fill(control: TextControl, value: string): Promise<void> {
  const proto = control instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setValue) throw new Error("no native value setter");
  await act(async () => {
    setValue.call(control, value);
    control.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

/** Picks an option of a `<select>` the way a user does (a real `change` event). */
export async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  if (![...select.options].some((o) => o.value === value)) throw new Error(`select has no option "${value}"`);
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  if (!setValue) throw new Error("no native select value setter");
  await act(async () => {
    setValue.call(select, value);
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

/** The text input or textarea whose placeholder starts with `prefix`. */
export function getByPlaceholder(prefix: string, root: ParentNode = window.document.body): TextControl {
  const match = [...root.querySelectorAll<TextControl>("input[placeholder], textarea[placeholder]")].find((c) =>
    (c.getAttribute("placeholder") ?? "").startsWith(prefix),
  );
  if (!match) throw new Error(`no control with a placeholder starting "${prefix}"`);
  return match;
}

/** Any form control (input, textarea, select) that an `aria-label` names exactly. */
export function getControl<T extends Element = TextControl>(ariaLabel: string, root: ParentNode = window.document.body): T {
  const matches = root.querySelectorAll<T>(`[aria-label="${ariaLabel}"]`);
  if (matches.length !== 1) throw new Error(`expected exactly one control labelled "${ariaLabel}", found ${matches.length}`);
  return matches[0] as T;
}

/** The `<section>`/`<aside>` an `aria-label` names (a region of the page to scope queries to). */
export function getRegion(ariaLabel: string, root: ParentNode = window.document.body): HTMLElement {
  const match = queryRegion(ariaLabel, root);
  if (!match) throw new Error(`no region labelled "${ariaLabel}"`);
  return match;
}

/** Like `getRegion`, but `null` when it isn't on screen (yet), for use inside `waitFor`. */
export function queryRegion(ariaLabel: string, root: ParentNode = window.document.body): HTMLElement | null {
  return root.querySelector<HTMLElement>(`section[aria-label="${ariaLabel}"], aside[aria-label="${ariaLabel}"]`);
}
