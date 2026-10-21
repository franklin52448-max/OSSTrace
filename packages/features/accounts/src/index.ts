/**
 * Public API of @osstrace/accounts. Other packages (Wave 2's moderation + private labels) import
 * from here only — never from this package's individual source files.
 */
export * from "./types.ts";
export * from "./store.ts";
export * from "./service.ts";
export { createAccountsHandler, bearerToken, type AccountsHttpOptions } from "./http.ts";
// So a server in another package (e.g. community label moderation) opens exactly the same
// accounts file as this package's own server and CLI, instead of re-deriving the path.
export { accountsStorePath, buildAccountService } from "./bootstrap.ts";
export { checkEmail, checkPassword, normalizeEmail, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password.ts";
