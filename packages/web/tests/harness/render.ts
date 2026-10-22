/**
 * Rendering and interaction helpers over the real react-dom client and the jsdom from `env.ts`.
 * No testing framework: these are the handful of operations the tests need, done the way a
 * browser does them (real DOM events, real form submission, label → control association).
 */
import { window } from "./env.ts";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

/** Every console.error during a test (React reports act() misuse and render errors here). */
export const consoleErrors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  consoleErrors.push(args.map(String).join(" "));
  originalError(...args);
};

export interface Rendered {
  container: HTMLElement;
  unmount(): Promise<void>;
}

const mounted = new Set<Rendered>();

export async function render(element: ReactElement): Promise<Rendered> {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  const rendered: Rendered = {
    container,
    async unmount() {
      if (!mounted.delete(rendered)) return;
      await act(async () => root.unmount());
      container.remove();
    },
  };
  mounted.add(rendered);
  return rendered;
}

/**
 * Unmounts everything still rendered. Use as `afterEach(cleanup)`: a test that fails before its
 * own unmount would otherwise leave components running (e.g. the live stream's reconnect timer)
 * and keep the test process alive.
 */
export async function cleanup(): Promise<void> {
  for (const rendered of [...mounted]) await rendered.unmount();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lets real time pass (network I/O, timers) inside act(), so every React update it causes is
 * flushed before the test looks at the DOM.
 */
export async function settle(ms = 20): Promise<void> {
  await act(async () => sleep(ms));
}

/**
 * Awaits `promise` inside act(), so React updates that real I/O causes meanwhile (a response
 * landing, a session restoring) are applied before the test moves on, not outside act().
 */
export async function during<T>(promise: Promise<T>): Promise<T> {
  return act(async () => promise);
}

/** Waits until `check` returns something truthy (and returns it), failing after `timeoutMs`. */
export async function waitFor<T>(check: () => T | null | undefined | false, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle();
  }
}

/** Types into an input the way a user does: React only sees the change through a real input event. */
export async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("no HTMLInputElement value setter");
    setValue.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

/** A real click: on a submit button this runs the browser's validation + form submission steps. */
export async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

/**
 * Submits a form programmatically (`form.requestSubmit()`: validation, then a real submit event).
 * Unlike clicking, this works while the form's submit button is disabled.
 */
export async function requestSubmit(form: HTMLFormElement): Promise<void> {
  await act(async () => form.requestSubmit());
}

/** The submit button inside `form`. */
export function getSubmitButton(form: HTMLFormElement): HTMLButtonElement {
  const button = form.querySelector('button[type="submit"]');
  if (!(button instanceof window.HTMLButtonElement)) throw new Error("form has no submit button");
  return button;
}

export function text(root: ParentNode = window.document.body): string {
  return (root.textContent ?? "").replace(/\s+/g, " ");
}

/** The button whose visible text is exactly `name`. */
export function getButton(name: string, root: ParentNode = window.document.body): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((b) => text(b).trim() === name);
  if (!match) throw new Error(`no button named "${name}"`);
  return match;
}

/**
 * The form control a `<label>` names, found the way assistive tech finds it: through the label's
 * own text and the DOM's label → control association (`label.control`, which resolves for any
 * labelable element — input, select or textarea), never a test id or class. Matches when the
 * label's visible text starts with `labelText`.
 */
export function getByLabelText<T extends Element = HTMLInputElement>(labelText: string, root: ParentNode = window.document.body): T {
  for (const label of root.querySelectorAll("label")) {
    const own = text(label).trim();
    const control = label.control;
    if (
      own.startsWith(labelText) &&
      (control instanceof window.HTMLInputElement || control instanceof window.HTMLSelectElement || control instanceof window.HTMLTextAreaElement)
    ) {
      return control as unknown as T;
    }
  }
  throw new Error(`no control labelled "${labelText}"`);
}

/** The control an `aria-label` names (for inputs that are labelled that way). */
export function getByAriaLabel(name: string, root: ParentNode = window.document.body): HTMLInputElement {
  const match = root.querySelector(`input[aria-label="${name}"]`);
  if (!(match instanceof window.HTMLInputElement)) throw new Error(`no input with aria-label "${name}"`);
  return match;
}

export function getAllByRole(role: string, root: ParentNode = window.document.body): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
}
