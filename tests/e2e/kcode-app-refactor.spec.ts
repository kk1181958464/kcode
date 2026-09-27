import { expect, test, type Page } from "@playwright/test";
import type { AgentEvent, ModelRequest } from "../../src/types";
import type { TaskRecord } from "../../src/models";
import type { RemoteCommandEnvelope } from "../../src/remote-types";

type RecordedCall = { kind: string; args: unknown[] };
declare global {
  interface Window {
    __appRefactor: {
      calls: RecordedCall[];
      emit(id: string, event: AgentEvent): void;
      remote(envelope: RemoteCommandEnvelope): void;
      remoteListeners(): number;
    };
  }
}

async function seed(
  page: Page,
  options: {
    summaries?: boolean;
    review?: boolean;
    remote?: boolean;
    scheduled?: boolean;
  } = {},
) {
  await page.addInitScript((options) => {
    const now = Date.now();
    const ledger = {
      goals: [],
      decisions: [],
      changedFiles: [],
      validations: [],
      failures: [],
      pending: [],
      connections: [],
    };
    const tasks = ["a", "b"].map((id) => ({
      id,
      name: "重构测试" + (id === "a" ? "甲" : "乙"),
      workspaceName: "测试项目",
      workspacePath: "D:/fixtures/refactor",
      createdAt: now,
      updatedAt: now,
      modelSelection: "fixture|model",
      runStatus: "completed",
      messages: [
        {
          id: "user-" + id,
          role: "user",
          content: "已有消息" + id,
          createdAt: now,
        },
        {
          id: "assistant:prior-" + id,
          role: "assistant",
          content: "已有回复" + id,
          createdAt: now + 1,
        },
      ],
      activities:
        options.review && id === "a"
          ? ["first.txt", "second.txt"].map((path, index) => ({
              id: "edit-" + index,
              requestId: "prior-a",
              tool: "write_file",
              title: "修改 " + path,
              status: "success",
              startedAt: now,
              completedAt: now + 1,
              input: { path },
              path,
              output: "written",
              additions: 1,
              deletions: 0,
              undoable: true,
              changed: true,
            }))
          : [],
      ...(options.summaries
        ? {
            contextSummary: "当前摘要" + id,
            contextLedger: ledger,
            compactedMessageCount: 1,
            usage: { input: 40, output: 20, cached: 0, promptTokens: 123 },
            summarySnapshots: [
              {
                id: "snapshot-" + id,
                createdAt: now - 1000,
                summary: "历史摘要" + id,
                ledger,
                compactedMessageCount: 1,
                modelGenerated: false,
              },
            ],
          }
        : {}),
    }));
    localStorage.setItem("kcode.tasks", JSON.stringify(tasks));
    localStorage.setItem("kcode.activeTaskId", "a");
    localStorage.setItem("kcode.statusOpen", "true");
    const calls: RecordedCall[] = [];
    const events = new Set<(id: string, event: AgentEvent) => void>();
    const commands = new Set<(envelope: RemoteCommandEnvelope) => void>();
    const remoteState = {
      configured: true,
      enabled: true,
      connected: true,
      connectionPhase: "connected",
      serverUrl: "",
      deviceId: "fixture",
      deviceName: "fixture",
    };
    const bridge = {
      workspace: {
        gitState: async () => ({
          available: true,
          files: 2,
          additions: 2,
          deletions: 0,
          summary: "",
          diff: "",
        }),
      },
      context: {},
      providers: {
        list: async () => [
          {
            id: "fixture",
            name: "Fixture",
            baseUrl: "https://fixture.invalid",
            protocol: "openai-responses",
            enabled: true,
            hasApiKey: true,
            models: [
              {
                id: "model",
                modelId: "fixture-model",
                displayName: "Fixture Model",
                protocol: "openai-responses",
                contextWindow: 100000,
              },
            ],
          },
        ],
      },
      chat: {
        onEvent(listener: (id: string, event: AgentEvent) => void) {
          events.add(listener);
          return () => events.delete(listener);
        },
        checkpoints: async () => [],
        editCheckpoints: async () => [],
        start: async (request: ModelRequest) => {
          calls.push({ kind: "start", args: [request] });
          await new Promise((resolve) => setTimeout(resolve, 50));
          return request.requestId;
        },
        cancel: async (requestId: string) => {
          calls.push({ kind: "cancel", args: [requestId] });
        },
        keepFiles: async (
          _workspace: string,
          requestId: string,
          paths?: string[],
        ) => {
          calls.push({ kind: "keep", args: [requestId, paths] });
          return {
            success: true,
            message: "kept",
            paths: paths ?? ["first.txt", "second.txt"],
            activityIds: paths?.includes("first.txt")
              ? ["edit-0"]
              : ["edit-0", "edit-1"],
          };
        },
        undoFiles: async (
          _workspace: string,
          requestId: string,
          paths?: string[],
          force?: boolean,
        ) => {
          calls.push({
            kind: "undo",
            args: [requestId, paths, Boolean(force)],
          });
          return force
            ? {
                success: true,
                message: "undone",
                paths: ["second.txt"],
                activityIds: ["edit-1"],
              }
            : {
                success: false,
                conflict: true,
                conflictPaths: ["second.txt"],
                message: "changed after edit",
                paths: [],
                activityIds: [],
              };
        },
      },
      ...(options.remote
        ? {
            remote: {
              state: async () => remoteState,
              onState: () => () => undefined,
              ready: async () => undefined,
              onCommand(listener: (envelope: RemoteCommandEnvelope) => void) {
                commands.add(listener);
                return () => commands.delete(listener);
              },
              syncTasks: async () => undefined,
              syncTaskStream: async () => undefined,
              commandResult: async (id: string, success: boolean) => {
                calls.push({ kind: "remote-result", args: [id, success] });
              },
            },
          }
        : {}),
      ...(options.scheduled
        ? {
            state: {
              taskHeaders: async () => tasks,
              runtimeStatuses: async () => [],
              loadTaskWindow: async (id: string) => ({
                task: tasks.find((t) => t.id === id),
                paging: {
                  messages: { hasMoreBefore: false, hasMoreAfter: false },
                  activities: { hasMoreBefore: false, hasMoreAfter: false },
                },
              }),
              saveTask: async () => undefined,
              saveTaskOrder: async () => undefined,
              load: async (key: string) =>
                key === "scheduledTasks"
                  ? [
                      {
                        id: "schedule-a",
                        name: "定时任务",
                        workspacePath: "D:/fixtures/refactor",
                        enabled: true,
                        intervalMinutes: 1,
                        nextRunAt: now - 1000,
                        prompt: "定时检查",
                        modelSelection: "fixture|model",
                      },
                    ]
                  : [],
              save: async (key: string) => {
                calls.push({ kind: "save", args: [key] });
              },
            },
          }
        : {}),
    };
    Object.assign(window, {
      kcode: bridge,
      __appRefactor: {
        calls,
        emit(id: string, event: AgentEvent) {
          for (const listener of events) listener(id, event);
        },
        remote(envelope: RemoteCommandEnvelope) {
          for (const listener of commands) listener(envelope);
        },
        remoteListeners: () => commands.size,
      },
    });
  }, options);
}
async function open(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "重构测试甲", exact: true }),
  ).toBeVisible();
}
async function calls(page: Page, kind: string) {
  return page.evaluate(
    (kind) => window.__appRefactor.calls.filter((c) => c.kind === kind),
    kind,
  );
}
async function stored(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("kcode.tasks") ?? "[]") as TaskRecord[],
  );
}

test("restores summary versions and full context without changing another task", async ({
  page,
}) => {
  await seed(page, { summaries: true });
  await open(page);
  await page.getByRole("button", { name: "查看压缩摘要", exact: true }).click();
  await expect(page.locator(".summary-dialog pre")).toHaveText("当前摘要a");
  await page.locator(".summary-versions button").first().click();
  await expect(page.locator(".summary-dialog pre")).toHaveText("历史摘要a");
  await page
    .getByRole("button", { name: "恢复完整上下文", exact: true })
    .click();
  await expect(page.locator(".summary-dialog")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await stored(page)).find((t) => t.id === "a")?.compactedMessageCount,
    )
    .toBe(0);
  const tasks = await stored(page);
  expect(tasks.find((t) => t.id === "a")?.contextSummary).toBeUndefined();
  expect(tasks.find((t) => t.id === "a")?.usage?.promptTokens).toBeUndefined();
  expect(tasks.find((t) => t.id === "a")?.messages).toHaveLength(2);
  expect(tasks.find((t) => t.id === "b")?.contextSummary).toBe("当前摘要b");
});

test("keeps an accepted file and forces undo only for the conflicting file", async ({
  page,
}) => {
  await seed(page, { review: true });
  await open(page);
  await page
    .getByRole("button", { name: "保留 first.txt", exact: true })
    .click();
  await expect.poll(async () => (await calls(page, "keep")).length).toBe(1);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "全部撤销", exact: true }).click();
  await expect.poll(async () => (await calls(page, "undo")).length).toBe(2);
  expect((await calls(page, "undo"))[1].args).toEqual([
    "prior-a",
    ["second.txt"],
    true,
  ]);
  await expect
    .poll(
      async () =>
        (await stored(page))
          .find((t) => t.id === "a")
          ?.activities.find((a) => a.id === "edit-1")?.undone,
    )
    .toBe(true);
  const activity = (await stored(page))
    .find((t) => t.id === "a")
    ?.activities.find((a) => a.id === "edit-0");
  expect(activity?.kept).toBe(true);
  expect(activity?.undone).not.toBe(true);
});

test("deduplicates rapid sends and preserves streamed text when cancelled", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await seed(page);
  await open(page);
  const input = page.getByRole("textbox", { name: "任务输入" });
  await input.fill("开始执行");
  await input.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      }),
    );
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      }),
    );
  });
  await expect.poll(async () => (await calls(page, "start")).length).toBe(1);
  const request = (await calls(page, "start"))[0].args[0] as ModelRequest;
  await page.evaluate(
    (id) =>
      window.__appRefactor.emit(id!, {
        type: "text",
        taskId: "a",
        sequence: 1,
        delta: "取消前已有输出",
      }),
    request.requestId,
  );
  await expect(page.locator(".conversation")).toContainText("取消前已有输出");
  await page.getByTitle("停止", { exact: true }).click();
  await expect.poll(async () => (await calls(page, "cancel")).length).toBe(1);
  await expect(page.locator(".conversation")).toContainText("取消前已有输出");
  await expect
    .poll(async () => (await stored(page)).find((t) => t.id === "a")?.runStatus)
    .toBe("cancelled");
  expect((await calls(page, "start")).length).toBe(1);
  expect(errors).toEqual([]);
});

test("remote retries enqueue and send the same message only once", async ({
  page,
}) => {
  await seed(page, { remote: true });
  await open(page);
  await expect
    .poll(() => page.evaluate(() => window.__appRefactor.remoteListeners()))
    .toBe(1);
  await page.evaluate(() => {
    const command = {
      type: "task.send" as const,
      taskId: "a",
      clientMessageId: "remote-once",
      content: "远程请求",
    };
    window.__appRefactor.remote({
      id: "remote-1",
      command,
    } as RemoteCommandEnvelope);
    window.__appRefactor.remote({
      id: "remote-2",
      command,
    } as RemoteCommandEnvelope);
  });
  await expect
    .poll(async () => (await calls(page, "remote-result")).length)
    .toBe(2);
  await expect.poll(async () => (await calls(page, "start")).length).toBe(1);
  await expect
    .poll(
      async () =>
        (await stored(page))
          .find((t) => t.id === "a")
          ?.messages.filter((m) => m.id === "remote-once").length,
    )
    .toBe(1);
  expect(
    (await calls(page, "remote-result")).every((c) => c.args[1] === true),
  ).toBe(true);
});

test("scheduled jobs and the automatic queue share a single launch lock", async ({
  page,
}) => {
  await page.clock.install();
  await seed(page, { scheduled: true });
  await open(page);
  await page.clock.runFor(16_000);
  await expect.poll(async () => (await calls(page, "start")).length).toBe(1);
  const request = (await calls(page, "start"))[0].args[0] as ModelRequest;
  expect(request.taskId).not.toBe("a");
  expect(request.messages.some((m) => m.content === "定时检查")).toBe(true);
  await page.clock.runFor(16_000);
  expect((await calls(page, "start")).length).toBe(1);
});
