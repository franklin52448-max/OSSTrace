/**
 * Public API of @osstrace/case-management. Other packages import from here only.
 *
 * A server that wants to host case management mounts
 * `createCasesHandler(new CaseService(accounts, new JsonFileCaseStore(casesPath())))`.
 */
export * from "./types.ts";
export * from "./store.ts";
export * from "./service.ts";
export * from "./validate.ts";
export { casesPath } from "./paths.ts";
export { createCasesHandler, type CasesHttpOptions } from "./http.ts";
