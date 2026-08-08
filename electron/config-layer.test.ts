import assert from "node:assert/strict";
import test from "node:test";
import {
  configLayerFingerprint,
  resolveLayeredConfig,
} from "../src/config-layer";

test("resolves effective values while retaining their source layer", () => {
  const result = resolveLayeredConfig([
    { name: "defaults", values: { model: "default", confirm: true } },
    { name: "user", values: { model: "user" }, version: "u1" },
    { name: "task", values: { model: "task" } },
  ]);
  assert.equal(result.value.model, "task");
  assert.equal(result.origins.model, "task");
  assert.equal(result.origins.confirm, "defaults");
  assert.equal(result.versions.user, "u1");
});

test("fingerprints object keys independently of insertion order", () => {
  assert.equal(
    configLayerFingerprint({ b: 2, a: 1 }),
    configLayerFingerprint({ a: 1, b: 2 }),
  );
});
