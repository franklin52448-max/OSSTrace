/**
 * Public API of @opentrace/private-labels. Import from here only — never from individual source files.
 */
export * from "./types.ts";
export * from "./store.ts";
export { PrivateLabelService, checkLabelText, type Authenticator, type PrivateLabelServiceOptions } from "./service.ts";
export { createPrivateLabelsHandler, type PrivateLabelsHttpOptions } from "./http.ts";
export { canonicalAddress, isChainId, SUPPORTED_CHAINS } from "./address.ts";
