/**
 * Public API of @osstrace/bounties. Other packages import from here only.
 *
 * A server that wants to host the bounty board mounts
 * `createBountiesHandler(new BountyService(new JsonFileBountyStore(bountiesPath()), accounts))`.
 */
export * from "./types.ts";
export * from "./store.ts";
export * from "./service.ts";
export * from "./validate.ts";
export { bountiesPath } from "./paths.ts";
export { createBountiesHandler, type BountiesHttpOptions } from "./http.ts";
