// Vite doesn't polyfill Node's `Buffer` global the way webpack/CRA used to, but @solana/web3.js
// and its own dependencies (spl-token, spl-token-metadata) still reach for it at their own
// module-evaluation time, not just inside function bodies -- so this has to run, and finish,
// before any of them are imported anywhere. Import this file FIRST, with no imports of its own
// ahead of it, in any module that imports @solana/web3.js or @solana/spl-token.
import { Buffer } from "buffer";

if (!("Buffer" in globalThis)) (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
