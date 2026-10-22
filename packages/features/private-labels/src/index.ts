/**
 * Public API of @osstrace/private-labels. Import from here only — never from individual source files.
 */
export * from "./types.ts";
export * from "./store.ts";
export { PrivateLabelService, checkLabelText, type Authenticator, type PrivateLabelServiceOptions } from "./service.ts";
export { createPrivateLabelsHandler, type PrivateLabelsHttpOptions } from "./http.ts";
// Address shape checks are @osstrace/core's, not this package's own copy — re-exported here only
// so existing imports of these three names from this package keep working.
export { canonicalAddress, isChainId, SUPPORTED_CHAINS } from "@osstrace/core";
