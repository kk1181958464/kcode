import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelCompatibility } from "./model-compatibility";

test("uses cumulative chunks for known GLM models", () => {
  assert.equal(
    resolveModelCompatibility(
      { baseUrl: "https://open.bigmodel.cn" },
      { modelId: "glm-5.2" },
      "openai-chat",
    ).streamMode,
    "cumulative",
  );
});

test("keeps known model quirks ahead of an uncalibrated provider profile", () => {
  assert.equal(
    resolveModelCompatibility(
      {
        baseUrl: "https://open.bigmodel.cn",
        profile: {
          checkedAt: 1,
          status: "healthy",
          protocolFamily: "openai",
          normalizedBaseUrl: "https://open.bigmodel.cn",
          supportsModelListing: true,
          supportsResponses: "unknown",
          streamMode: "auto",
        },
      },
      { modelId: "glm-5.2" },
      "openai-chat",
    ).streamMode,
    "cumulative",
  );
});

test("allows model metadata to override provider stream defaults", () => {
  assert.equal(
    resolveModelCompatibility(
      {
        baseUrl: "https://provider.example",
        profile: {
          checkedAt: 1,
          status: "healthy",
          protocolFamily: "openai",
          normalizedBaseUrl: "https://provider.example",
          supportsModelListing: true,
          supportsResponses: "unknown",
          streamMode: "cumulative",
        },
      },
      { modelId: "custom", streamMode: "delta" },
      "openai-chat",
    ).streamMode,
    "delta",
  );
});

test("keeps provider-specific reasoning options in one registry", () => {
  assert.equal(
    resolveModelCompatibility(
      { baseUrl: "https://api.minimaxi.com" },
      { modelId: "MiniMax-M2.5" },
      "openai-chat",
    ).splitReasoning,
    true,
  );
});
