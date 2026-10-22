// bs58@4 (the base58 codec @solana/web3.js uses) ships no type declarations. This declares the
// two functions this package calls, exactly as bs58's own README documents them.
declare module "bs58" {
  const bs58: {
    encode(source: Uint8Array): string;
    /** Throws on a character outside the base58 alphabet. */
    decode(source: string): Uint8Array;
  };
  export default bs58;
}
