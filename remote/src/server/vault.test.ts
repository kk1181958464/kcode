import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptJson, encryptJson } from "./vault.js";

test("encrypts and authenticates cloud configuration", () => {
  const key = randomBytes(32);
  const value = { providers: [{ id: "openai", apiKey: "secret" }] };
  const encrypted = encryptJson(value, key);
  assert.ok(!encrypted.includes("secret"));
  assert.deepEqual(decryptJson(encrypted, key), value);
  assert.throws(() => decryptJson(encrypted, randomBytes(32)));
});
