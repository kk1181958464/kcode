import assert from "node:assert/strict";
import test from "node:test";
import { summaryModelForProvider } from "./gateway";

test("selects a configured cheap model without inventing one", () => {
  const provider = {
    protocol: "openai-chat" as const,
    models: [
      {
        id: "gpt-4o-mini",
        modelId: "gpt-4o-mini",
        displayName: "mini",
        protocol: "openai-chat" as const,
      },
      {
        id: "gpt-5.6-sol",
        modelId: "gpt-5.6-sol",
        displayName: "sol",
        protocol: "openai-chat" as const,
      },
    ],
  } as any;
  assert.equal(summaryModelForProvider(provider, "gpt-5.6-sol"), "gpt-4o-mini");
  assert.equal(
    summaryModelForProvider(
      { ...provider, models: [provider.models[1]] },
      "gpt-5.6-sol",
    ),
    "gpt-5.6-sol",
  );
});
