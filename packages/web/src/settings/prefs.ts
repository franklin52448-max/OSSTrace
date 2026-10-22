import type { Preferences } from "@osstrace/contract";
import { useSettings } from "./api.ts";

/** Shown only until settings load; the server is the source of truth for preferences. */
export const PREFERENCE_DEFAULTS: Preferences = {
  theme: "dark",
  defaultChain: "ethereum",
  defaultUsdGte: 1,
  defaultTimeLast: "30d",
  flowDots: true,
  timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC",
};

export function usePrefs(): Preferences {
  const { data } = useSettings();
  return data?.preferences ?? PREFERENCE_DEFAULTS;
}
