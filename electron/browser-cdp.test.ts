import assert from "node:assert/strict";
import test from "node:test";
import {
  boxModelCenter,
  detectHumanVerification,
  extractAccessibilityFrame,
  hasUserSuppliedVerificationCode,
  isLikelyHumanVerification,
} from "./browser-cdp";

test("extracts semantic and focusable controls from a CDP accessibility tree", () => {
  const result = extractAccessibilityFrame([
    {
      role: { value: "RootWebArea" },
      name: { value: "Account" },
      backendDOMNodeId: 1,
    },
    {
      role: { value: "button" },
      name: { value: "Continue" },
      backendDOMNodeId: 2,
      properties: [{ name: "focusable", value: { value: true } }],
    },
    {
      role: { value: "textbox" },
      name: { value: "Password" },
      value: { value: "secret" },
      backendDOMNodeId: 5,
      properties: [{ name: "protected", value: { value: true } }],
    },
    {
      role: { value: "generic" },
      name: { value: "Custom menu" },
      backendDOMNodeId: 3,
      properties: [{ name: "focusable", value: { value: true } }],
    },
    {
      ignored: true,
      role: { value: "button" },
      name: { value: "Hidden" },
      backendDOMNodeId: 4,
    },
  ]);

  assert.deepEqual(
    result.entries.map(({ backendNodeId, role, name }) => ({
      backendNodeId,
      role,
      name,
    })),
    [
      { backendNodeId: 2, role: "button", name: "Continue" },
      { backendNodeId: 5, role: "textbox", name: "Password" },
      { backendNodeId: 3, role: "generic", name: "Custom menu" },
    ],
  );
  assert.equal(result.entries[1].sensitive, true);
  assert.deepEqual(result.text, ["Continue", "Password"]);
});

test("recognizes verification codes explicitly supplied by the user", () => {
  assert.equal(
    hasUserSuppliedVerificationCode([
      { role: "user", content: "短信验证码是 482193，帮我填一下" },
    ]),
    true,
  );
  assert.equal(
    hasUserSuppliedVerificationCode([
      { role: "assistant", content: "请提供收到的验证码" },
      { role: "user", content: "482193" },
    ]),
    true,
  );
  assert.equal(
    hasUserSuppliedVerificationCode([
      { role: "user", content: "订单编号是 482193" },
    ]),
    false,
  );
});

test("computes a compositor click point from a CDP box model", () => {
  assert.deepEqual(
    boxModelCenter({ border: [10, 20, 50, 20, 50, 60, 10, 60] }),
    { x: 30, y: 40 },
  );
  assert.throws(() => boxModelCenter({}), /没有可点击区域/);
});

test("recognizes verification pages that require the user", () => {
  assert.equal(isLikelyHumanVerification("请完成滑块验证后继续"), true);
  assert.equal(isLikelyHumanVerification("Verify you are human"), true);
  assert.equal(isLikelyHumanVerification("Dashboard loaded"), false);
});

test("requires actionable verification context instead of matching documentation", () => {
  assert.equal(
    detectHumanVerification({
      title: "CAPTCHA integration guide",
      url: "https://docs.example.com/captcha",
      text: "This document explains CAPTCHA architecture.",
      elements: [{ name: "Next chapter" }],
    }),
    undefined,
  );
  assert.deepEqual(
    detectHumanVerification({
      title: "登录验证",
      url: "https://example.com/login",
      text: "请输入短信验证码",
      elements: [{ name: "短信验证码" }, { name: "确认" }],
    }),
    { kind: "one-time-code", message: "请输入收到的一次性验证码" },
  );
  assert.deepEqual(
    detectHumanVerification({
      title: "Sign in",
      url: "https://example.com/login",
      text: "",
      elements: [
        {
          name: "I'm not a robot",
          frame: "https://www.google.com/recaptcha/api2/anchor",
        },
      ],
    }),
    { kind: "captcha", message: "请完成人机验证" },
  );
});
