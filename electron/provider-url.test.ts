import test from "node:test";
import assert from "node:assert/strict";
import { validateProviderBaseUrl } from "./provider-url";

test("accepts HTTP and HTTPS provider URLs", () => {
  assert.equal(
    validateProviderBaseUrl("http://192.168.1.20:8080/v1").href,
    "http://192.168.1.20:8080/v1",
  );
  assert.equal(
    validateProviderBaseUrl("http://provider.example/api").href,
    "http://provider.example/api",
  );
  assert.equal(
    validateProviderBaseUrl("https://provider.example").href,
    "https://provider.example/",
  );
});

test("rejects unsupported or unsafe provider URL forms", () => {
  assert.throws(() => validateProviderBaseUrl("ftp://provider.example"), {
    message: "Base URL 仅支持 HTTP 或 HTTPS",
  });
  assert.throws(() => validateProviderBaseUrl("not a URL"), {
    message: "Base URL 格式无效",
  });
  assert.throws(
    () => validateProviderBaseUrl("http://user:password@provider.example"),
    { message: "Base URL 不能包含用户名或密码" },
  );
  assert.throws(() => validateProviderBaseUrl("http://provider.example?v=1"), {
    message: "Base URL 不能包含查询参数或片段",
  });
});