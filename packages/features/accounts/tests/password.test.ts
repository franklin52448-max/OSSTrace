import { test } from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import {
  checkEmail,
  checkPassword,
  hashPassword,
  needsRehash,
  normalizeEmail,
  verifyPassword,
} from "../src/password.ts";

test("hashPassword produces a real argon2id hash with the configured cost, not the password", async () => {
  const hash = await hashPassword("a perfectly fine password");
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  assert.ok(!hash.includes("a perfectly fine password"));
});

test("verifyPassword accepts the right password and rejects wrong ones", async () => {
  const hash = await hashPassword("a perfectly fine password");
  assert.equal(await verifyPassword(hash, "a perfectly fine password"), true);
  assert.equal(await verifyPassword(hash, "a perfectly fine passwor"), false);
  assert.equal(await verifyPassword(hash, "A perfectly fine password"), false);
  assert.equal(await verifyPassword(hash, ""), false);
});

test("hashes are salted: the same password hashes differently each time, and both verify", async () => {
  const a = await hashPassword("same password twice");
  const b = await hashPassword("same password twice");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(a, "same password twice"), true);
  assert.equal(await verifyPassword(b, "same password twice"), true);
});

test("verifyPassword returns false (doesn't throw) on a malformed hash", async () => {
  assert.equal(await verifyPassword("not-a-hash", "whatever password"), false);
  assert.equal(await verifyPassword("", "whatever password"), false);
});

test("needsRehash flags a hash made with weaker parameters than the current config", async () => {
  const weak = await argon2.hash("upgrade me please", { type: argon2.argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 });
  assert.equal(needsRehash(weak), true);
  assert.equal(needsRehash(await hashPassword("upgrade me please")), false);
});

test("password policy is length-only, with a min and a max", () => {
  assert.notEqual(checkPassword("short"), null);
  assert.notEqual(checkPassword(12345678901), null);
  assert.equal(checkPassword("ten chars!"), null);
  assert.equal(checkPassword("x".repeat(256)), null);
  assert.notEqual(checkPassword("x".repeat(257)), null);
});

test("email is normalized and shape-checked", () => {
  assert.equal(normalizeEmail("  Alice@Example.COM "), "alice@example.com");
  assert.equal(checkEmail("alice@example.com"), null);
  assert.notEqual(checkEmail("alice"), null);
  assert.notEqual(checkEmail("alice@localhost"), null);
  assert.notEqual(checkEmail("a b@example.com"), null);
  assert.notEqual(checkEmail(undefined), null);
});
