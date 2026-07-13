import test from "node:test";
import assert from "node:assert/strict";
import { isCasualGreeting } from "../src/intent";

test("routes pure greetings without agent tools", () => {
  assert.equal(isCasualGreeting({ role: "user", content: "hi" }), true);
  assert.equal(isCasualGreeting({ role: "user", content: "你好！" }), true);
});

test("keeps tools for greetings that contain a task", () => {
  assert.equal(isCasualGreeting({ role: "user", content: "你好，帮我检查一下项目" }), false);
  assert.equal(isCasualGreeting({ role: "user", content: "hi", images: [{ id: "1", name: "x.png", mediaType: "image/png", dataUrl: "data:image/png;base64,", size: 1 }] }), false);
});
