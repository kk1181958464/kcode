import assert from "node:assert/strict";
import test from "node:test";
import { mutationChangedFromOutput } from "./mutation-evidence";

test("uses actual database effect counts as mutation evidence", () => {
  assert.equal(
    mutationChangedFromOutput(
      '{"results":[{"affectedRows":0,"changedRows":0}]}',
    ),
    false,
  );
  assert.equal(
    mutationChangedFromOutput(
      '{"results":[{"affectedRows":1,"changedRows":1}]}',
    ),
    true,
  );
  assert.equal(mutationChangedFromOutput('{"rowCount":0}'), false);
  assert.equal(mutationChangedFromOutput('{"rowCount":2}'), true);
  assert.equal(
    mutationChangedFromOutput(
      '{"result":{"matchedCount":1,"modifiedCount":0}}',
    ),
    false,
  );
  assert.equal(
    mutationChangedFromOutput('{"result":{"deletedCount":1}}'),
    true,
  );
  assert.equal(mutationChangedFromOutput("not json"), false);
});
