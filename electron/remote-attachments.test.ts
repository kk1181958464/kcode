import assert from "node:assert/strict";
import test from "node:test";
import {
  materializeRemoteAttachments,
  remoteAttachmentPrompt,
} from "../src/remote-attachments";

test("materializes validated mobile images and Vue context files", () => {
  const bytes = Buffer.from("image-bytes");
  const result = materializeRemoteAttachments({
    images: [
      {
        id: "image-1",
        name: "screen.png",
        mediaType: "image/png",
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
        size: 999,
      },
    ],
    files: [
      {
        id: "file-1",
        name: "Component.vue",
        content: "<template><main /></template>",
        size: 999,
      },
    ],
  });
  assert.equal(result.images[0].size, bytes.byteLength);
  assert.equal(result.files[0].name, "Component.vue");
  assert.equal(result.files[0].path, "remote://file-1/Component.vue");
  assert.equal(remoteAttachmentPrompt("", 1, 1), "请分析这些图片和文件");
});

test("rejects unsupported or malformed remote attachments", () => {
  assert.throws(() =>
    materializeRemoteAttachments({
      files: [{ id: "file-1", name: "archive.zip", content: "x", size: 1 }],
    }),
  );
  assert.throws(() =>
    materializeRemoteAttachments({
      images: [
        {
          id: "image-1",
          name: "screen.png",
          mediaType: "image/png",
          dataUrl: "data:image/png;base64,not base64",
          size: 10,
        },
      ],
    }),
  );
});
