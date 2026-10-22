import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt N=2^15, r=8, p=1, 16-byte random salt, 32-byte key. Format: scrypt$15$8$1$<salt b64>$<key b64>
const LOG_N = 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * 1024 * 1024;

function scrypt(pw: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(pw.normalize("NFKC"), salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N: 2 ** LOG_N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, logN, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length, {
    N: 2 ** Number(logN),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A real hash of a random secret: verifying against it costs the same as a real user (no username oracle). */
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(24).toString("base64")));
