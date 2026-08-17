import { test } from "node:test";
import assert from "node:assert";
import { canonicalizeCommand, commandsMatch, extractCommandSignature } from "./command-canonicalize";

test("collapses whitespace", () => {
  assert.equal(canonicalizeCommand("npm   run   build"), "npm run build");
});

test("normalizes backslashes to forward slashes", () => {
  assert.equal(
    canonicalizeCommand("node_modules\\.bin\\tsc --noEmit"),
    "tsc --noEmit",
  );
});

test("strips simple surrounding quotes", () => {
  assert.equal(canonicalizeCommand("echo 'hello'"), "echo hello");
});

test("resolves node_modules/.bin/ prefix", () => {
  assert.equal(canonicalizeCommand("./node_modules/.bin/jest --coverage"), "jest --coverage");
});

test("strips env var prefixes", () => {
  assert.equal(canonicalizeCommand("CI=true NODE_ENV=test npm test"), "npm test");
});

test("preserves complex quoted args", () => {
  // Multi-word quoted args keep their quotes to remain a single logical arg
  assert.equal(
    canonicalizeCommand('grep "hello world" file.txt'),
    'grep "hello world" file.txt',
  );
});

test("lowercases executable and strips Windows extension", () => {
  assert.equal(
    canonicalizeCommand("C:\\Users\\test\\app.exe --flag"),
    "c:/users/test/app --flag",
  );
});

test("commandsMatch ignores insignificant differences", () => {
  assert.ok(commandsMatch("npm  run  test", "npm run test"));
  assert.ok(commandsMatch("NODE_ENV=test npm test", "npm test"));
  assert.ok(commandsMatch("./node_modules/.bin/tsc", "tsc"));
  assert.ok(commandsMatch("TSC.exe --noEmit", "tsc --noEmit"));
});

test("extractCommandSignature returns exe + subcommand", () => {
  assert.deepEqual(extractCommandSignature("npm run build"), ["npm", "run"]);
  assert.deepEqual(extractCommandSignature("git commit -m 'fix'"), ["git", "commit"]);
  assert.deepEqual(extractCommandSignature("NODE_ENV=test jest --coverage"), ["jest", "--coverage"].slice(0, 1));
  assert.deepEqual(
    extractCommandSignature(
      'powershell.exe -NoProfile -Command "git -C D:\\project commit -m test"',
    ),
    ["git", "commit"],
  );
});
