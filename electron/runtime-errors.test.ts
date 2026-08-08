import assert from "node:assert/strict";
import test from "node:test";
import { classifyRuntimeError } from "../src/runtime-errors";

test("classifies transport and provider errors separately", () => {
  assert.deepEqual(classifyRuntimeError("ERR_INCOMPLETE_CHUNKED_ENCODING"), {
    kind: "transport",
    retryable: true,
    userAction: "retry",
  });
  assert.equal(
    classifyRuntimeError("upstream 503").kind,
    "provider_unavailable",
  );
});

test("does not recommend retrying invalid credentials", () => {
  const result = classifyRuntimeError("401 invalid api key");
  assert.equal(result.kind, "authentication");
  assert.equal(result.retryable, false);
  assert.equal(result.userAction, "change_provider");
});
