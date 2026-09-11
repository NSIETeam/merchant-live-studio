import test from "node:test";
import assert from "node:assert/strict";
import { createAccessSecret, hashAccessSecret, verifyAccessSecret } from "../src/platform/identity/credentials.js";

test("new access credentials store salted verifiers and reject previous secrets after rotation", async () => {
  const first = createAccessSecret(), replacement = createAccessSecret();
  assert.equal(Buffer.from(first, "base64url").length, 32);
  assert.notEqual(first, replacement);
  const encoded = await hashAccessSecret(first), secondSalt = await hashAccessSecret(first);
  assert.notEqual(encoded, secondSalt);
  assert.equal(encoded.includes(first), false);
  assert.equal(await verifyAccessSecret(first, encoded), true);
  assert.equal(await verifyAccessSecret(replacement, encoded), false);
  const rotated = await hashAccessSecret(replacement);
  assert.equal(await verifyAccessSecret(first, rotated), false);
  assert.equal(await verifyAccessSecret(replacement, rotated), true);
});

test("malformed stored credential parameters and oversized input are rejected", async () => {
  const secret = createAccessSecret(), encoded = await hashAccessSecret(secret);
  for (const invalid of ["", "plain-secret", encoded + "$extra", encoded + "\n", encoded.replace("scrypt-v1", "scrypt-v999"), encoded.replace(/[a-f0-9]$/, "z"), "scrypt-v1$999999999$32$8", "x".repeat(10000)])
    assert.equal(await verifyAccessSecret(secret, invalid), false);
  for (const invalid of ["short", "x".repeat(257), "你".repeat(100)]) {
    await assert.rejects(hashAccessSecret(invalid), /长度无效/);
    assert.equal(await verifyAccessSecret(invalid, encoded), false);
  }
});
