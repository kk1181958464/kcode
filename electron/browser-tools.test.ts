import assert from "node:assert/strict";
import test from "node:test";
import {
  executeBrowserTool,
  type BrowserToolDeps,
} from "./browser-tools";
import type { ResolvedCredential } from "./credential-vault";

function memoryBrowser(overrides: Partial<BrowserToolDeps> = {}): BrowserToolDeps & {
  typed: { ref: string; text: string }[];
  snapshots: { waitForVerification?: boolean }[];
} {
  const typed: { ref: string; text: string }[] = [];
  const snapshots: { waitForVerification?: boolean }[] = [];
  return {
    typed,
    snapshots,
    browserIsOpen: () => true,
    browserSessionUrl: () => "https://app.example.com/login",
    async openBrowser(_sessionId, url, requestId) {
      return { opened: true, url, requestId };
    },
    async snapshotBrowser(_sessionId, options) {
      snapshots.push({ waitForVerification: options.waitForVerification });
      return { refs: ["r1"], url: "https://app.example.com/login" };
    },
    async clickBrowser(_sessionId, ref) {
      return { clicked: ref };
    },
    async typeBrowser(_sessionId, ref, text) {
      typed.push({ ref, text });
      return { typed: true, ref };
    },
    async screenshotBrowser() {
      return { path: "/tmp/shot.png" };
    },
    async startBrowserRecording(_sessionId, name) {
      return { recording: true, name };
    },
    async stopBrowserRecording() {
      return { recording: false };
    },
    async resolveCredentialProfile(_kind, selector): Promise<ResolvedCredential> {
      if (selector !== "portal") throw new Error(`没有凭据 ${selector}`);
      return {
        descriptor: {
          id: "c1",
          kind: "website",
          name: "portal",
          url: "https://app.example.com",
          username: "alice",
          createdAt: 1,
          updatedAt: 1,
        },
        payload: { username: "alice", password: "s3cret" },
      };
    },
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

test("browser_open and snapshot pass through session and verification", async () => {
  const browser = memoryBrowser();
  const opened = await executeBrowserTool(
    "browser_open",
    { url: "https://app.example.com" },
    "sess",
    "req-1",
    [],
    signal(),
    () => undefined,
    browser,
  );
  assert.deepEqual(JSON.parse(opened.output), {
    opened: true,
    url: "https://app.example.com",
    requestId: "req-1",
  });

  await executeBrowserTool(
    "browser_snapshot",
    {},
    "sess",
    "req-1",
    [{ role: "user", content: "打开页面" }],
    signal(),
    () => undefined,
    browser,
  );
  await executeBrowserTool(
    "browser_snapshot",
    {},
    "sess",
    "req-1",
    [
      { role: "assistant", content: "请输入验证码" },
      { role: "user", content: "123456" },
    ],
    signal(),
    () => undefined,
    browser,
  );
  assert.equal(browser.snapshots[0].waitForVerification, true);
  assert.equal(browser.snapshots[1].waitForVerification, false);
});

test("click, type, screenshot and recording wrap browser results", async () => {
  const browser = memoryBrowser();
  const clicked = await executeBrowserTool(
    "browser_click",
    { ref: "r1" },
    "sess",
    "req",
    [],
    signal(),
    () => undefined,
    browser,
  );
  assert.equal(JSON.parse(clicked.output).clicked, "r1");
  const typed = await executeBrowserTool(
    "browser_type",
    { ref: "r2", text: "hello" },
    "sess",
    "req",
    [],
    signal(),
    () => undefined,
    browser,
  );
  assert.equal(JSON.parse(typed.output).ref, "r2");
  const shot = await executeBrowserTool(
    "browser_screenshot",
    { width: 800, fullPage: true },
    "sess",
    "req",
    [],
    signal(),
    () => undefined,
    browser,
  );
  assert.equal(shot.path, "/tmp/shot.png");
  const started = await executeBrowserTool(
    "browser_record_start",
    { name: "flow" },
    "sess",
    "req",
    [],
    signal(),
    () => undefined,
    browser,
  );
  assert.equal(JSON.parse(started.output).name, "flow");
  const stopped = await executeBrowserTool(
    "browser_record_stop",
    {},
    "sess",
    "req",
    [],
    signal(),
    () => undefined,
    browser,
  );
  assert.equal(JSON.parse(stopped.output).recording, false);
});

test("browser_fill_credential types matching website secrets", async () => {
  const browser = memoryBrowser();
  const result = await executeBrowserTool(
    "browser_fill_credential",
    {
      credentialName: "portal",
      usernameRef: "user",
      passwordRef: "pass",
    },
    "sess",
    "req",
    [],
    signal(),
    () => undefined,
    browser,
  );
  assert.equal(result.executed, true);
  assert.deepEqual(result.browserOperationEvidence, ["type"]);
  const parsed = JSON.parse(result.output);
  assert.deepEqual(parsed.filled, ["username", "password"]);
  assert.equal(parsed.secretsReturned, false);
  assert.deepEqual(browser.typed, [
    { ref: "user", text: "alice" },
    { ref: "pass", text: "s3cret" },
  ]);
});

test("browser_fill_credential rejects origin mismatch and missing password ref", async () => {
  const mismatch = memoryBrowser({
    browserSessionUrl: () => "https://other.example.com/login",
  });
  await assert.rejects(
    () =>
      executeBrowserTool(
        "browser_fill_credential",
        { credentialName: "portal", passwordRef: "pass" },
        "sess",
        "req",
        [],
        signal(),
        () => undefined,
        mismatch,
      ),
    /当前网页与凭据“portal”保存的网站不一致/,
  );
  await assert.rejects(
    () =>
      executeBrowserTool(
        "browser_fill_credential",
        { credentialName: "portal", usernameRef: "user" },
        "sess",
        "req",
        [],
        signal(),
        () => undefined,
        memoryBrowser(),
      ),
    /缺少密码输入框引用/,
  );
});

test("rejects unknown browser tools", async () => {
  await assert.rejects(
    () =>
      executeBrowserTool(
        "browser_close",
        {},
        "sess",
        "req",
        [],
        signal(),
        () => undefined,
        memoryBrowser(),
      ),
    /不支持的浏览器工具/,
  );
});
