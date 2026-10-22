/**
 * Public API of @osstrace/private-labels. Import from here only — never from individual source files.
 */
export * from "./types.ts";
export * from "./store.ts";
export { PrivateLabelService, checkLabelText, type Authenticator, type PrivateLabelServiceOptions } from "./service.ts";
export { createPrivateLabelsHandler, type PrivateLabelsHttpOptions } from "./http.ts";
// So another server that reads a user's own private labels (community-labels' "share as Community
// label", ADR 0017) resolves exactly the same file this package's server writes.
export { privateLabelsStorePath } from "./bootstrap.ts";
// Address shape checks are @osstrace/core's, not this package's own copy — re-exported here only
// so existing imports of these three names from this package keep working.
export { canonicalAddress, isChainId, SUPPORTED_CHAINS } from "@osstrace/core";
