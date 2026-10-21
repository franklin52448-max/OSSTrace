/**
 * The address shape checks now live in `@osstrace/core` (`packages/core/src/addressFormat.ts`),
 * shared with community label submissions. Re-exported here so this package's imports, and its
 * README's description of where the chain-aware code is, stay valid.
 */
export { canonicalAddress, isRealAddress } from "@osstrace/core";
