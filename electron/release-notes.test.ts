import assert from "node:assert/strict";
import test from "node:test";
import { releaseNotesText } from "./release-notes";

test("converts GitHub release HTML to readable text", () => {
  assert.equal(
    releaseNotesText(
      '<p><strong>Full Changelog</strong>: <a href="https://example.com">v0.1.1...v0.1.2</a></p>',
    ),
    "Full Changelog: v0.1.1...v0.1.2",
  );
});

test("removes executable markup and decodes entities", () => {
  assert.equal(
    releaseNotesText("<p>Fix &amp; improve</p><script>alert(1)</script>"),
    "Fix & improve",
  );
});
