import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { app } from "electron";
import type { AgentEvent, ModelRequest } from "../src/types";
import { runAgent, type RunAgentDeps } from "./agent";
import {
  listCredentialProfiles,
  resetCredentialVaultForTests,
  resolveCredentialProfile,
  saveCredentialProfile,
  selectCredential,
} from "./credential-vault";

function fakeProvider(): RunAgentDeps["getProvider"] {
  return async () =>
    ({
      id: "fake",
      name: "Fake",
      protocol: "openai-chat",
      baseUrl: "https://example.invalid",
      enabled: true,
      models: [
        {
          id: "fake-model",
          modelId: "fake-model",
          displayName: "fake-model",
          protocol: "openai-chat",
        },
      ],
      apiKey: "sk-fake",
      apiKeys: ["sk-fake"],
    }) as never;
}

async function credentialRequest(content: string): Promise<ModelRequest> {
  return {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content }],
    permissionMode: "full-access",
    workspacePath: await mkdtemp(path.join(os.tmpdir(), "kcode-credential-")),
  };
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

test("keeps same-name credentials isolated by category and encrypts secrets", async () => {
  await resetCredentialVaultForTests();
  try {
    await saveCredentialProfile({
      kind: "mysql",
      name: "production",
      host: "db.internal",
      port: 3306,
      username: "db-user",
      database: "app",
      payload: {
        host: "db.internal",
        port: 3306,
        username: "db-user",
        password: "mysql-secret-value",
        database: "app",
      },
    });
    await saveCredentialProfile({
      kind: "website",
      name: "production",
      url: "https://example.com/login?from=test",
      username: "web-user",
      payload: {
        username: "web-user",
        password: "website-secret-value",
      },
    });

    const mysql = await resolveCredentialProfile("mysql", "production");
    const website = await resolveCredentialProfile("website", "production");
    assert.equal(mysql.payload.password, "mysql-secret-value");
    assert.equal(website.payload.password, "website-secret-value");
    assert.equal(website.descriptor.url, "https://example.com");

    const listed = await listCredentialProfiles();
    assert.deepEqual(listed.map((item) => item.kind).sort(), [
      "mysql",
      "website",
    ]);
    assert.equal(JSON.stringify(listed).includes("secret-value"), false);

    const stored = await readFile(
      path.join(app.getPath("userData"), "credential-vault.json"),
      "utf8",
    );
    assert.equal(stored.includes("mysql-secret-value"), false);
    assert.equal(stored.includes("website-secret-value"), false);
  } finally {
    await resetCredentialVaultForTests();
  }
});

test("updates only the matching category and reports a missing local alias", async () => {
  await resetCredentialVaultForTests();
  try {
    const first = await saveCredentialProfile({
      kind: "sqlserver",
      name: "finance",
      host: "sql.internal",
      username: "sa",
      payload: { host: "sql.internal", username: "sa", password: "old" },
    });
    const updated = await saveCredentialProfile({
      kind: "sqlserver",
      name: "finance",
      host: "sql.internal",
      username: "sa",
      payload: { host: "sql.internal", username: "sa", password: "new" },
    });
    assert.equal(updated.id, first.id);
    assert.equal(
      (await resolveCredentialProfile("sqlserver", "finance")).payload.password,
      "new",
    );
    await assert.rejects(
      resolveCredentialProfile("mongodb", "finance"),
      /本地没有已保存的MongoDB 凭据/,
    );
  } finally {
    await resetCredentialVaultForTests();
  }
});

test("requires an unambiguous alias within one category", () => {
  const candidates = [
    {
      id: "one",
      name: "production east",
      host: "db-east.internal",
      username: "root",
    },
    {
      id: "two",
      name: "production west",
      host: "db-west.internal",
      username: "root",
    },
  ];
  assert.equal(
    selectCredential(candidates, "db-east.internal", "MySQL ").id,
    "one",
  );
  assert.throws(
    () => selectCredential(candidates, "production", "MySQL "),
    /匹配到多条记录/,
  );
});

test("makes a locally saved website credential available to a later task", async () => {
  await resetCredentialVaultForTests();
  const listedConversation = path.join(
    app.getPath("userData"),
    "conversations",
    "credential-task-b.jsonl",
  );
  await unlink(listedConversation).catch(() => undefined);
  try {
    await saveCredentialProfile({
      kind: "website",
      name: "运营后台",
      url: "https://admin.example.com/login",
      username: "operator",
      payload: { username: "operator", password: "cross-task-password" },
    });

    let listRound = 0;
    const listEvents = await collectEvents(
      runAgent(
        "credential-task-b",
        await credentialRequest("查找运营后台账号"),
        new AbortController().signal,
        {
          getProvider: fakeProvider(),
          async *streamTurn() {
            listRound += 1;
            if (listRound === 1) {
              yield {
                type: "complete",
                turn: {
                  text: "",
                  calls: [
                    {
                      id: "list-credential",
                      name: "credential_list",
                      input: { kind: "website", query: "运营后台" },
                    },
                  ],
                  rawCalls: [],
                  usage: { input: 10, output: 5, cached: 0 },
                },
              };
              return;
            }
            yield {
              type: "complete",
              turn: {
                text: "已找到本地账号。",
                calls: [],
                rawCalls: [],
                usage: { input: 12, output: 6, cached: 0 },
              },
            };
          },
        },
      ),
    );
    const listActivity = listEvents.find(
      (event) =>
        event.type === "activity" &&
        event.activity.tool === "credential_list" &&
        event.activity.status === "success",
    );
    assert.ok(listActivity && listActivity.type === "activity");
    assert.match(listActivity.activity.output || "", /运营后台/);
    assert.equal(
      JSON.stringify(listActivity.activity).includes("cross-task-password"),
      false,
    );
  } finally {
    await resetCredentialVaultForTests();
    await unlink(listedConversation).catch(() => undefined);
  }
});

test("refuses to classify an account as website credentials without a browser origin", async () => {
  await resetCredentialVaultForTests();
  const conversation = path.join(
    app.getPath("userData"),
    "conversations",
    "credential-unscoped.jsonl",
  );
  await unlink(conversation).catch(() => undefined);
  try {
    let round = 0;
    const events = await collectEvents(
      runAgent(
        "credential-unscoped",
        await credentialRequest("记住这个未分类账号"),
        new AbortController().signal,
        {
          getProvider: fakeProvider(),
          async *streamTurn() {
            round += 1;
            yield {
              type: "complete",
              turn:
                round === 1
                  ? {
                      text: "",
                      calls: [
                        {
                          id: "save-unscoped",
                          name: "browser_save_credential",
                          input: {
                            name: "未分类账号",
                            username: "operator",
                            password: "secret",
                          },
                        },
                      ],
                      rawCalls: [],
                      usage: { input: 10, output: 5, cached: 0 },
                    }
                  : {
                      text: "需要先确认账号所属目标。",
                      calls: [],
                      rawCalls: [],
                      usage: { input: 12, output: 6, cached: 0 },
                    },
            };
          },
        },
      ),
    );
    const activity = events.find(
      (event) =>
        event.type === "activity" &&
        event.activity.tool === "browser_save_credential",
    );
    assert.ok(activity && activity.type === "activity");
    assert.equal(activity.activity.status, "failed");
    assert.match(activity.activity.output || "", /没有打开网页/);
    assert.equal(activity.activity.input.password, "[已安全隐藏]");
    assert.deepEqual(await listCredentialProfiles("website"), []);
    assert.equal((await readFile(conversation, "utf8")).includes("secret"), false);
  } finally {
    await resetCredentialVaultForTests();
    await unlink(conversation).catch(() => undefined);
  }
});
