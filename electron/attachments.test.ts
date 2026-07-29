import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_IMAGE_FILES,
  imageMediaType,
  isSupportedContextFile,
  mergeContextFiles,
} from "../src/attachments";
import {
  contextDialogDirectory,
  directoryFromFilePath,
} from "../src/context-directory";

test("context directory prefers the task and extracts dropped file parents", () => {
  assert.equal(contextDialogDirectory("D:\\task", "D:\\default"), "D:\\task");
  assert.equal(contextDialogDirectory("", "D:\\default"), "D:\\default");
  assert.equal(directoryFromFilePath("D:\\files\\note.md"), "D:\\files");
  assert.equal(directoryFromFilePath("C:\\note.md"), "C:\\");
  assert.equal(directoryFromFilePath("/tmp/note.md"), "/tmp");
  assert.equal(directoryFromFilePath("note.md"), undefined);
});

test("drop attachment rules recognize code files and image extensions", () => {
  assert.equal(isSupportedContextFile("component.vue"), true);
  assert.equal(isSupportedContextFile("D:\\app\\Component.VUE"), true);
  assert.equal(isSupportedContextFile("service.PHP"), true);
  assert.equal(isSupportedContextFile("styles.scss"), true);
  assert.equal(isSupportedContextFile("schema.prisma"), true);
  assert.equal(isSupportedContextFile("Dockerfile"), true);
  assert.equal(isSupportedContextFile(".env.production"), true);
  assert.equal(isSupportedContextFile(".gitignore"), true);
  assert.equal(isSupportedContextFile("icon.svg"), true);
  assert.equal(isSupportedContextFile("archive.zip"), false);
  assert.equal(imageMediaType("", "photo.JPEG"), "image/jpeg");
  assert.equal(imageMediaType("image/webp", "image.bin"), "image/webp");
  assert.equal(
    imageMediaType("application/octet-stream", "image.svg"),
    undefined,
  );
});

test("attachment limits allow nine files and nine images", () => {
  assert.equal(MAX_CONTEXT_FILES, 9);
  assert.equal(MAX_IMAGE_FILES, 9);
});

test("context files are deduplicated before count and total limits", () => {
  const existing = {
    id: "existing",
    name: "existing.md",
    path: "D:\\files\\existing.md",
    content: "",
    size: MAX_CONTEXT_FILE_BYTES,
  };
  const duplicate = { ...existing, id: "duplicate" };
  const accepted = {
    ...existing,
    id: "accepted",
    name: "accepted.md",
    path: "D:\\files\\accepted.md",
  };
  const tooLargeForTotal = {
    ...existing,
    id: "overflow",
    name: "overflow.md",
    path: "D:\\files\\overflow.md",
    size: MAX_CONTEXT_FILE_BYTES * 3,
  };

  const result = mergeContextFiles(
    [existing],
    [duplicate, accepted, accepted, tooLargeForTotal],
  );
  assert.deepEqual(
    result.files.map((file) => file.id),
    ["existing", "accepted"],
  );
  assert.equal(result.countOverflow, 0);
  assert.deepEqual(
    result.totalOverflow.map((file) => file.id),
    ["overflow"],
  );
});
