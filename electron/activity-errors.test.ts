import test from "node:test";
import assert from "node:assert/strict";
import { conciseFailureOutput } from "./activity-errors";

test("extracts the last stderr line for an activity failure", () => {
  assert.equal(
    conciseFailureOutput("stdout\nstderr:\nfirst warning\ncommand not found"),
    "command not found",
  );
});

test("preserves credentials in concise failure output", () => {
  const detail = conciseFailureOutput(
    "stderr:\nAuthorization: Bearer abc123\npassword=secret-value",
  );
  assert.equal(detail, "password=secret-value");
});
