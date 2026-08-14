import assert from "node:assert/strict";
import test from "node:test";
import { redactedToolInput } from "./agent";

test("redacts secrets before tool input is persisted or displayed", () => {
  const input = redactedToolInput({
    id: "tool-1",
    name: "mongodb_connect_via_ssh",
    input: {
      uri: "mongodb://db-user:db-password@db.internal/app",
      password: "db-password",
      sshPassword: "ssh-password",
      sshPrivateKey: "PRIVATE KEY CONTENT",
      username: "db-user",
      host: "db.internal",
    },
  });
  assert.equal(input.password, "[已安全隐藏]");
  assert.equal(input.sshPassword, "[已安全隐藏]");
  assert.equal(input.sshPrivateKey, "[已安全隐藏]");
  assert.equal(input.uri, "mongodb://[已隐藏]@db.internal/app");
  assert.equal(input.username, "db-user");
  assert.equal(JSON.stringify(input).includes("db-password"), false);
  assert.equal(JSON.stringify(input).includes("ssh-password"), false);
  assert.equal(JSON.stringify(input).includes("PRIVATE KEY CONTENT"), false);
});

test("hides browser typed values because a ref does not reveal field sensitivity", () => {
  assert.deepEqual(
    redactedToolInput({
      id: "tool-2",
      name: "browser_type",
      input: { ref: "e12", text: "one-time-secret" },
    }),
    { ref: "e12", text: "[已安全隐藏]" },
  );
});
