import test from "node:test";
import assert from "node:assert/strict";
import { gitExecutableCandidates, resolveGitExecutable } from "./executables";

test("resolves Git from PATH or a standard Windows installation", () => {
  const env = {
    Path: "C:\\Tools;C:\\Other",
    ProgramFiles: "C:\\Program Files",
  };
  const candidates = gitExecutableCandidates(env);
  const installed = candidates.find((value) =>
    /Program Files[\\/]Git[\\/]cmd[\\/]git\.exe$/i.test(value),
  );
  assert.ok(installed);
  assert.equal(
    resolveGitExecutable(env, (value) => value === installed),
    installed,
  );
});

test("falls back to the executable name when Git cannot be located", () => {
  assert.equal(
    resolveGitExecutable({}, () => false),
    "git",
  );
});
