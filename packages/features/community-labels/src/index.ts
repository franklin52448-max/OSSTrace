/**
 * Public API of @osstrace/community-labels. Other packages import from here only.
 *
 * - The Explorer/Visualizer need only `CommunityLabelReader` + `JsonFileSubmissionStore` +
 *   `communityLabelsPath` to show community/confirmed labels in lookups.
 * - A server that wants to host the submission/moderation routes mounts
 *   `createLabelSubmissionsHandler(new LabelSubmissionService(store, accounts))`.
 */
export * from "./types.ts";
export * from "./store.ts";
export * from "./reader.ts";
export * from "./service.ts";
export * from "./validate.ts";
export * from "./share.ts";
export { communityLabelsPath } from "./paths.ts";
export { createLabelSubmissionsHandler, type LabelSubmissionsHttpOptions } from "./http.ts";
