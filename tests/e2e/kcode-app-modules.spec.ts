import { expect, test, type Page } from "@playwright/test";
import type { AgentEvent } from "../../src/types";

async function seedTasks(page: Page, desktop = false, running = false) {
  await page.addInitScript(
    ({ desktop, running }) => {
      const now = Date.now();
      const tasks = ["a", "b"].map((id) => ({
        id,
        name: id === "a" ? "模块测试甲" : "模块测试乙",
        workspaceName: "模块测试",
        workspacePath: "D:/fixtures/modules",
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            id: "user:" + id,
            role: "user",
            content: "检查模块 " + id,
            createdAt: now,
          },
          {
            id: "assistant:run-" + id,
            role: "assistant",
            content: "",
            createdAt: now + 1,
          },
        ],
        activities: [],
        runStatus: "completed",
      }));
      localStorage.setItem("kcode.tasks", JSON.stringify(tasks));
      localStorage.setItem("kcode.activeTaskId", "a");
      if (!desktop) return;
      const listeners = new Set<(id: string, event: unknown) => void>();
      Object.assign(window, {
        __emitAgentEvent(id: string, event: unknown) {
          for (const listener of listeners) listener(id, event);
        },
        __agentListenerCount: () => listeners.size,
        kcode: {
          ...(running
            ? {
                state: {
                  taskHeaders: async () => tasks,
                  runtimeStatuses: async () =>
                    tasks.map((task) => ({
                      taskId: task.id,
                      requestId: "run-" + task.id,
                      lastSequence: 0,
                      turnStatus: "in_progress",
                      status: "running",
                      updatedAt: now,
                    })),
                  loadTaskWindow: async (id: string) => ({
                    task: tasks.find((task) => task.id === id),
                    paging: {
                      messages: { hasMoreBefore: false, hasMoreAfter: false },
                      activities: { hasMoreBefore: false, hasMoreAfter: false },
                    },
                  }),
                  saveTask: async () => undefined,
                  saveTaskOrder: async () => undefined,
                  load: async () => [],
                },
              }
            : {}),
          workspace: {},
          context: {},
          providers: { list: async () => [] },
          chat: {
            onEvent(listener: (id: string, event: unknown) => void) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            checkpoints: async () => [],
          },
        },
      });
    },
    { desktop, running },
  );
}

async function switchTask(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp("^" + name + "(?: |$)") }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

async function emit(page: Page, id: string, event: AgentEvent) {
  await page.evaluate(
    ({ id, event }) => {
      (
        window as unknown as {
          __emitAgentEvent: (id: string, event: unknown) => void;
        }
      ).__emitAgentEvent(id, event);
    },
    { id, event },
  );
}

test("keeps composer drafts and dropped attachments isolated when switching tasks", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seedTasks(page);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "任务输入" });
  await input.fill("甲的未发送草稿");
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File(["module fixture"], "module.txt", { type: "text/plain" }),
    );
    return data;
  });
  await page
    .locator(".composer")
    .dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  await expect(page.locator(".context-file")).toContainText("module.txt");
  await switchTask(page, "模块测试乙");
  await expect(input).toHaveValue("");
  await expect(page.locator(".context-file")).toHaveCount(0);
  await input.fill("乙的未发送草稿");
  await switchTask(page, "模块测试甲");
  await expect(input).toHaveValue("甲的未发送草稿");
  await expect(page.locator(".context-file")).toContainText("module.txt");
  await page.getByTitle("移除 module.txt", { exact: true }).click();
  await expect(page.locator(".context-file")).toHaveCount(0);
  await switchTask(page, "模块测试乙");
  await expect(input).toHaveValue("乙的未发送草稿");
  expect(errors).toEqual([]);
});

test("retains streamed text across task switches and commits one final answer", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seedTasks(page, true, true);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "模块测试甲", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __agentListenerCount: () => number }
        ).__agentListenerCount(),
      ),
    )
    .toBe(1);
  await expect(page.getByTitle("停止", { exact: true })).toBeVisible();
  await emit(page, "run-a", {
    type: "text",
    taskId: "a",
    sequence: 1,
    delta: "甲任务第一段",
  });
  await expect(page.locator(".conversation")).toContainText("甲任务第一段");
  await switchTask(page, "模块测试乙");
  await emit(page, "run-a", {
    type: "text",
    taskId: "a",
    sequence: 2,
    delta: "，后台第二段。",
  });
  await emit(page, "run-a", {
    type: "text",
    taskId: "a",
    sequence: 2,
    delta: "重复事件不得显示",
  });
  await emit(page, "run-b", {
    type: "text",
    taskId: "b",
    sequence: 1,
    delta: "乙任务独立回复。",
  });
  await emit(page, "run-b", {
    type: "done",
    taskId: "b",
    sequence: 2,
    outcome: "completed",
  });
  await expect(page.locator(".conversation")).toContainText("乙任务独立回复。");
  await expect(page.locator(".conversation")).not.toContainText("甲任务第一段");
  await emit(page, "run-a", {
    type: "final_response",
    taskId: "a",
    sequence: 3,
    textOffset: 0,
    startedAt: Date.now(),
    phase: "final_answer",
  });
  await emit(page, "run-a", {
    type: "done",
    taskId: "a",
    sequence: 4,
    outcome: "completed",
  });
  await switchTask(page, "模块测试甲");
  await expect(page.locator(".conversation")).toContainText(
    "甲任务第一段，后台第二段。",
  );
  await expect(page.locator(".conversation")).not.toContainText(
    "重复事件不得显示",
  );
  await expect(page.locator(".conversation")).not.toContainText(
    "乙任务独立回复。",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __agentListenerCount: () => number }
        ).__agentListenerCount(),
      ),
    )
    .toBe(1);
  expect(errors).toEqual([]);
});

test("honors a nonretryable error flag even when its message resembles a disconnect", async ({
  page,
}) => {
  await seedTasks(page, true);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "模块测试甲", exact: true }),
  ).toBeVisible();
  await emit(page, "run-a", {
    type: "text",
    taskId: "a",
    sequence: 1,
    delta: "已保留的内容",
  });
  await emit(page, "run-a", {
    type: "error",
    taskId: "a",
    sequence: 2,
    message: "上游连接失败：凭据已撤销",
    code: "authentication",
    retryable: false,
    userAction: "change_provider",
  });
  await expect(page.locator(".conversation")).toContainText("已保留的内容");
  await expect(page.locator(".conversation")).toContainText(
    "上游连接失败：凭据已撤销",
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tasks = JSON.parse(localStorage.getItem("kcode.tasks") ?? "[]");
        return tasks.find((task: { id: string }) => task.id === "a")?.runStatus;
      }),
    )
    .toBe("failed");
});
