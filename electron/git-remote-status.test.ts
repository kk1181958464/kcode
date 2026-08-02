import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGitRemoteHead,
  validateGitBranchName,
  validateGitRemoteName,
} from "./git-remote-status";

test("validates safe Git remote and branch names", () => {
  assert.equal(validateGitRemoteName(""), "origin");
  assert.equal(validateGitRemoteName("upstream"), "upstream");
  assert.equal(validateGitBranchName("release/v0.2.52"), "release/v0.2.52");
  assert.throws(() => validateGitRemoteName("--upload-pack=bad"), /无效/);
  assert.throws(() => validateGitBranchName("main..other"), /无效/);
});

test("parses SHA-1 and SHA-256 ls-remote output", () => {
  assert.equal(
    parseGitRemoteHead(
      "0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n",
    ),
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(
    parseGitRemoteHead(`${"a".repeat(64)}\trefs/heads/main`),
    "a".repeat(64),
  );
  assert.throws(() => parseGitRemoteHead(""), /有效的提交编号/);
});
