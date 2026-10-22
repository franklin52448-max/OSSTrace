import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import bs58 from "bs58";
import { CommunityLabelReader } from "../src/reader.ts";
import { CHALLENGE_TTL_MS, eip191Hash, ethereumAddressOf, verifySelfAttestation } from "../src/selfAttestation.ts";
import { SELF_ATTESTATION_METHODOLOGY_URL } from "../src/service.ts";
import { validBody, withEnv } from "./helpers.ts";

// Self-attested labels (ADR 0019). Every keypair below is generated fresh, in memory, for this
// test run only: nothing here is a real wallet's secret. The only fixed values are published
// standard test vectors (RFC 8032, and secp256k1 private key 1), pinned so the verification is
// checked against something other than this code's own signing helpers.

/** A fresh Ethereum EOA: address plus an EIP-191 `personal_sign` the way a wallet does it. */
function ethWallet() {
  const secretKey = secp256k1.utils.randomPrivateKey();
  const address = ethereumAddressOf(secp256k1.getPublicKey(secretKey, false));
  return {
    address,
    sign(message: string, vOffset = 27): string {
      const sig = secp256k1.sign(eip191Hash(message), secretKey);
      return `0x${bytesToHex(sig.toCompactRawBytes())}${(sig.recovery + vOffset).toString(16).padStart(2, "0")}`;
    },
  };
}

/** A fresh Solana keypair: base58 address plus a wallet-style `signMessage` (Ed25519 over the UTF-8 bytes). */
function solWallet() {
  const secretKey = ed25519.utils.randomPrivateKey();
  const address = bs58.encode(ed25519.getPublicKey(secretKey));
  return {
    address,
    sign(message: string): string {
      return bs58.encode(ed25519.sign(utf8ToBytes(message), secretKey));
    },
  };
}

const MESSAGE = "OSSTrace wants you to self-attest a public label for an address you control.\n\nLabel: test wallet";

// --- Published vectors: the pieces the scheme is built from, checked against outside references.

test("vector: secp256k1 private key 1 has the well-known Ethereum address 0x7E5F…5Bdf", () => {
  const one = new Uint8Array(32);
  one[31] = 1;
  assert.equal(ethereumAddressOf(secp256k1.getPublicKey(one, false)), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
});

test('vector: the EIP-191 hash of "hello world" matches ethers\' hashMessage', () => {
  assert.equal(bytesToHex(eip191Hash("hello world")), "d9eba16ed0ecae432b71fe008c98cc872bb4cc214d3220a36f365326cf807d68");
});

test("vector: RFC 8032 Ed25519 test 1 (empty message) verifies as a Solana self-attestation", () => {
  // RFC 8032 section 7.1, TEST 1: public key and signature are published in the RFC.
  const publicKey = hexToBytes("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const signature = hexToBytes(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );
  assert.equal(verifySelfAttestation("solana", bs58.encode(publicKey), "", bs58.encode(signature)), true);
  assert.equal(verifySelfAttestation("solana", bs58.encode(publicKey), "x", bs58.encode(signature)), false);
});

// --- verifySelfAttestation on real, freshly generated keypairs.

test("ethereum: a real personal_sign signature by the address's key is accepted (v as 27/28 or 0/1)", () => {
  const wallet = ethWallet();
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE, wallet.sign(MESSAGE)), true);
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE, wallet.sign(MESSAGE, 0)), true);
  // Checksummed (mixed-case) input addresses are the same address.
  const checksummedLike = wallet.address.slice(0, 2) + wallet.address.slice(2).toUpperCase();
  assert.equal(verifySelfAttestation("ethereum", checksummedLike, MESSAGE, wallet.sign(MESSAGE)), true);
});

test("ethereum: wrong signature, wrong address, tampered message and malformed input are all rejected", () => {
  const wallet = ethWallet();
  const other = ethWallet();
  const good = wallet.sign(MESSAGE);
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE, other.sign(MESSAGE)), false, "signed by a different key");
  assert.equal(verifySelfAttestation("ethereum", other.address, MESSAGE, good), false, "claimed for a different address");
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE.replace("test wallet", "Binance"), good), false, "tampered message");
  assert.equal(verifySelfAttestation("ethereum", wallet.address, `${MESSAGE} `, good), false, "one extra byte");
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE, good.slice(0, -2) + "1d"), false, "v = 29");
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE, good.slice(0, 100)), false, "truncated");
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE, `0x${"zz".repeat(65)}`), false, "not hex");
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE, `0x${"00".repeat(65)}`), false, "all zero");
  assert.equal(verifySelfAttestation("ethereum", "0x1234", MESSAGE, good), false, "not an address");
});

test("ethereum: the malleated (high-s) twin of a valid signature is rejected", () => {
  const wallet = ethWallet();
  const good = hexToBytes(wallet.sign(MESSAGE).slice(2));
  const sig = secp256k1.Signature.fromCompact(good.subarray(0, 64));
  const n = secp256k1.CURVE.n;
  const highS = new secp256k1.Signature(sig.r, n - sig.s);
  const flippedV = good[64] === 27 ? 28 : 27;
  const malleated = `0x${bytesToHex(highS.toCompactRawBytes())}${flippedV.toString(16)}`;
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE, malleated), false);
});

test("solana: a real Ed25519 message signature by the address's key is accepted", () => {
  const wallet = solWallet();
  assert.equal(verifySelfAttestation("solana", wallet.address, MESSAGE, wallet.sign(MESSAGE)), true);
});

test("solana: wrong signature, wrong address, tampered message and malformed input are all rejected", () => {
  const wallet = solWallet();
  const other = solWallet();
  const good = wallet.sign(MESSAGE);
  assert.equal(verifySelfAttestation("solana", wallet.address, MESSAGE, other.sign(MESSAGE)), false, "signed by a different key");
  assert.equal(verifySelfAttestation("solana", other.address, MESSAGE, good), false, "claimed for a different address");
  assert.equal(verifySelfAttestation("solana", wallet.address, MESSAGE.replace("test wallet", "Binance"), good), false, "tampered message");
  assert.equal(verifySelfAttestation("solana", wallet.address, MESSAGE, "0OIl"), false, "not base58");
  assert.equal(verifySelfAttestation("solana", wallet.address, MESSAGE, bs58.encode(new Uint8Array(63))), false, "63 bytes");
  assert.equal(verifySelfAttestation("solana", "not-an-address", MESSAGE, good), false, "not an address");
  assert.equal(verifySelfAttestation("ethereum", wallet.address, MESSAGE, good), false, "right signature, wrong chain");
});

// --- The service flow: challenge → sign → submit, over the real stores.

test("full flow: challenge names the address, label, account and nonce; a valid signature makes a public self-attested label", async () => {
  await withEnv(async ({ service, account, store }) => {
    const { user, token } = await account("alice@example.com");
    const wallet = ethWallet();
    const issued = await service.requestSelfAttestation(token, { chain: "ethereum", address: wallet.address, name: "Alice's donation wallet" });
    assert.ok(issued.ok, JSON.stringify(issued));
    const { message, nonce, scheme } = issued.challenge;
    assert.equal(scheme, "eip191-personal-sign");
    assert.match(message, new RegExp(`^Address: ${wallet.address}$`, "m"));
    assert.match(message, /^Label: Alice's donation wallet$/m);
    assert.match(message, new RegExp(`^OSSTrace account: ${user.id}$`, "m"));
    assert.match(message, new RegExp(`^Nonce: ${nonce}$`, "m"));

    const submitted = await service.submitSelfAttestation(token, { nonce, signature: wallet.sign(message) });
    assert.ok(submitted.ok, JSON.stringify(submitted));
    assert.equal(submitted.submission.status, "self-attested");
    assert.equal(submitted.submission.submittedBy, user.id);

    const label = await new CommunityLabelReader(store).getLabel({ chain: "ethereum", value: wallet.address });
    assert.ok(label?.reviewStatus === "self-attested");
    assert.equal(label.name, "Alice's donation wallet");
    assert.equal(label.source.url, SELF_ATTESTATION_METHODOLOGY_URL);
    // Anyone can re-check the public label's proof without trusting this server.
    assert.equal(verifySelfAttestation("ethereum", label.address.value, label.attestation.message, label.attestation.signature), true);
  });
});

test("full flow on Solana", async () => {
  await withEnv(async ({ service, account }) => {
    const { token } = await account("alice@example.com");
    const wallet = solWallet();
    const issued = await service.requestSelfAttestation(token, { chain: "solana", address: wallet.address, name: "My validator vote account" });
    assert.ok(issued.ok);
    assert.equal(issued.challenge.scheme, "solana-ed25519");
    const submitted = await service.submitSelfAttestation(token, { nonce: issued.challenge.nonce, signature: wallet.sign(issued.challenge.message) });
    assert.ok(submitted.ok, JSON.stringify(submitted));
    assert.equal(submitted.submission.status === "self-attested" && submitted.submission.attestation.scheme, "solana-ed25519");
  });
});

test("you can't self-attest an address you don't control: signing someone else's challenge with your own key fails", async () => {
  await withEnv(async ({ service, account, store }) => {
    const { token } = await account("mallory@example.com");
    const victim = ethWallet();
    const mallorysKey = ethWallet();
    const issued = await service.requestSelfAttestation(token, { chain: "ethereum", address: victim.address, name: "Victim's wallet (scam)" });
    assert.ok(issued.ok);
    const result = await service.submitSelfAttestation(token, { nonce: issued.challenge.nonce, signature: mallorysKey.sign(issued.challenge.message) });
    assert.equal(!result.ok && result.error, "invalid_attestation");
    assert.deepEqual(await store.list(), []);
  });
});

test("challenges are single-use, expire, and belong to the account that asked for them", async () => {
  await withEnv(async ({ service, account, clock }) => {
    const alice = await account("alice@example.com");
    const bob = await account("bob@example.com");
    const wallet = ethWallet();
    const ask = () => service.requestSelfAttestation(alice.token, { chain: "ethereum", address: wallet.address, name: "mine" });

    // Replay: the same nonce + valid signature only works once.
    const first = await ask();
    assert.ok(first.ok);
    const signature = wallet.sign(first.challenge.message);
    assert.ok((await service.submitSelfAttestation(alice.token, { nonce: first.challenge.nonce, signature })).ok);
    const replay = await service.submitSelfAttestation(alice.token, { nonce: first.challenge.nonce, signature });
    assert.equal(!replay.ok && replay.error, "invalid_attestation");

    // Another account can't redeem alice's challenge, and trying doesn't burn it for her.
    const second = await ask();
    assert.ok(second.ok);
    const sig2 = wallet.sign(second.challenge.message);
    const stolen = await service.submitSelfAttestation(bob.token, { nonce: second.challenge.nonce, signature: sig2 });
    assert.equal(!stolen.ok && stolen.error, "invalid_attestation");
    assert.ok((await service.submitSelfAttestation(alice.token, { nonce: second.challenge.nonce, signature: sig2 })).ok);

    // A failed attempt uses the challenge up too.
    const third = await ask();
    assert.ok(third.ok);
    assert.equal((await service.submitSelfAttestation(alice.token, { nonce: third.challenge.nonce, signature: "0x00" })).ok, false);
    const retry = await service.submitSelfAttestation(alice.token, { nonce: third.challenge.nonce, signature: wallet.sign(third.challenge.message) });
    assert.equal(!retry.ok && retry.error, "invalid_attestation");

    // Expiry.
    const fourth = await ask();
    assert.ok(fourth.ok);
    clock.advance(CHALLENGE_TTL_MS);
    const late = await service.submitSelfAttestation(alice.token, { nonce: fourth.challenge.nonce, signature: wallet.sign(fourth.challenge.message) });
    assert.equal(!late.ok && late.error, "invalid_attestation");
    assert.match(!late.ok ? late.message : "", /expired/);
  });
});

test("the label name can't inject extra lines into the signed statement, and is validated like any name", async () => {
  await withEnv(async ({ service, account }) => {
    const { token } = await account("alice@example.com");
    const wallet = ethWallet();
    const sneaky = await service.requestSelfAttestation(token, {
      chain: "ethereum",
      address: wallet.address,
      name: "harmless\nAddress: 0x000000000000000000000000000000000000dead",
    });
    assert.ok(sneaky.ok);
    assert.equal(sneaky.challenge.message.match(/^Address: /gm)?.length, 1, "exactly one Address line");
    assert.match(sneaky.challenge.message, /^Label: harmless Address: 0x0+dead$/m);

    for (const name of ["", "x".repeat(121), "Binance ‮etoh‬", undefined]) {
      const bad = await service.requestSelfAttestation(token, { chain: "ethereum", address: wallet.address, name });
      assert.equal(!bad.ok && bad.error, "invalid_submission", JSON.stringify(name));
    }
    const badAddress = await service.requestSelfAttestation(token, { chain: "ethereum", address: "0x12", name: "x" });
    assert.equal(!badAddress.ok && badAddress.error, "invalid_submission");
    const anon = await service.requestSelfAttestation(null, { chain: "ethereum", address: wallet.address, name: "x" });
    assert.equal(!anon.ok && anon.error, "unauthenticated");
  });
});

test("display order: confirmed, then sourced community claims, then the owner's own self-attestation", async () => {
  await withEnv(async ({ service, account, store, clock }) => {
    const owner = await account("owner@example.com");
    const reporter = await account("reporter@example.com");
    const mod = await account("mod@example.com", "moderator");
    const wallet = ethWallet();
    const reader = new CommunityLabelReader(store);
    const address = { chain: "ethereum" as const, value: wallet.address };

    const issued = await service.requestSelfAttestation(owner.token, { chain: "ethereum", address: wallet.address, name: "Binance Hot Wallet" });
    assert.ok(issued.ok);
    assert.ok((await service.submitSelfAttestation(owner.token, { nonce: issued.challenge.nonce, signature: wallet.sign(issued.challenge.message) })).ok);
    assert.equal((await reader.getLabel(address))?.reviewStatus, "self-attested", "alone, it shows");

    clock.advance(1000);
    const report = await service.submit(reporter.token, validBody({ address: wallet.address, name: "Phishing wallet impersonating Binance" }));
    assert.ok(report.ok);
    assert.equal((await reader.getLabel(address))?.name, "Phishing wallet impersonating Binance", "a sourced third-party claim outranks the owner's own");

    assert.ok((await service.confirm(mod.token, report.submission.id)).ok);
    assert.equal((await reader.getLabel(address))?.reviewStatus, "confirmed");
  });
});

test("moderators can take a self-attestation down (reject) but not 'confirm' it; the proof is kept for audit", async () => {
  await withEnv(async ({ service, account, store }) => {
    const owner = await account("owner@example.com");
    const mod = await account("mod@example.com", "moderator");
    const wallet = solWallet();
    const issued = await service.requestSelfAttestation(owner.token, { chain: "solana", address: wallet.address, name: "Official Jupiter treasury" });
    assert.ok(issued.ok);
    const submitted = await service.submitSelfAttestation(owner.token, { nonce: issued.challenge.nonce, signature: wallet.sign(issued.challenge.message) });
    assert.ok(submitted.ok);

    const queue = await service.listForReview(mod.token, "self-attested");
    assert.ok(queue.ok);
    assert.deepEqual(queue.submissions.map((s) => s.id), [submitted.submission.id]);

    const confirm = await service.confirm(mod.token, submitted.submission.id);
    assert.equal(!confirm.ok && confirm.error, "not_confirmable");

    const rejected = await service.reject(mod.token, submitted.submission.id, "impersonates a project it isn't");
    assert.ok(rejected.ok);
    assert.equal(rejected.submission.status, "rejected");
    assert.ok(rejected.submission.status === "rejected" && rejected.submission.attestation?.signature);
    assert.equal(await new CommunityLabelReader(store).getLabel({ chain: "solana", value: wallet.address }), null);
  });
});

test("self-attestations count toward the submission rate limit", async () => {
  await withEnv(async ({ service, account }) => {
    const { token } = await account("alice@example.com");
    for (let i = 0; i < 10; i++) {
      const wallet = ethWallet();
      const issued = await service.requestSelfAttestation(token, { chain: "ethereum", address: wallet.address, name: `wallet ${i}` });
      assert.ok(issued.ok);
      assert.ok((await service.submitSelfAttestation(token, { nonce: issued.challenge.nonce, signature: wallet.sign(issued.challenge.message) })).ok);
    }
    const over = await service.submit(token, validBody());
    assert.equal(!over.ok && over.error, "rate_limited");
  });
});
