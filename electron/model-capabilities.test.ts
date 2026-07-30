import assert from "node:assert/strict";
import test from "node:test";
import {
  imageInputSupport,
  isUnsupportedImageInputError,
} from "../src/model-capabilities";

test("recognizes GLM-5 text-only models before sending image parts", () => {
  assert.equal(
    imageInputSupport({
      modelId: "glm-5.2",
      protocol: "openai-chat",
    }),
    "unsupported",
  );
  assert.equal(
    imageInputSupport({
      modelId: "zai-org/glm-5.2",
      protocol: "openai-chat",
    }),
    "unsupported",
  );
});

test("honors explicit capability metadata and protocol defaults", () => {
  assert.equal(
    imageInputSupport({
      modelId: "custom-text-model",
      protocol: "openai-chat",
      supportsImages: false,
    }),
    "unsupported",
  );
  assert.equal(
    imageInputSupport({
      modelId: "gemini-custom",
      protocol: "gemini-generate-content",
    }),
    "supported",
  );
  assert.equal(
    imageInputSupport({
      modelId: "custom-model",
      protocol: "openai-chat",
    }),
    "unknown",
  );
});

test("recognizes unsupported image input responses for the retry fallback", () => {
  assert.equal(
    isUnsupportedImageInputError(
      new Error(
        "请求失败 (400): Invalid content type.image_url is only supported by certain models",
      ),
    ),
    true,
  );
  assert.equal(
    isUnsupportedImageInputError(new Error("请求失败 (401)")),
    false,
  );
  assert.equal(
    isUnsupportedImageInputError(
      new Error("请求失败 (400): image_url exceeds the maximum file size"),
    ),
    false,
  );
});
