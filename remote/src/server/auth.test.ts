import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionToken,
  hashPassword,
  normalizeUsername,
  tokenHash,
  validatePassword,
  verifyPassword,
} from "./auth.js";

test("normalizes valid account names and rejects weak credentials", () => {
  assert.equal(normalizeUsername("  User.Name  "), "user.name");
  assert.equal(
    validatePassword("correct-horse-battery"),
    "correct-horse-battery",
  );
  assert.throws(() => normalizeUsername("a"), /3-64/);
  assert.throws(() => validatePassword("short"), /10-128/);
});

test("hashes passwords with scrypt and verifies without storing plaintext", async () => {
  const record = await hashPassword("correct-horse-battery");
  assert.notEqual(record.hash, "correct-horse-battery");
  assert.equal(
    await verifyPassword("correct-horse-battery", record.salt, record.hash),
    true,
  );
  assert.equal(
    await verifyPassword("incorrect-password", record.salt, record.hash),
    false,
  );
});

test("stores only a deterministic hash of random session tokens", () => {
  const token = createSessionToken();
  assert.ok(token.length >= 40);
  assert.equal(tokenHash(token), tokenHash(token));
  assert.notEqual(tokenHash(token), token);
});
