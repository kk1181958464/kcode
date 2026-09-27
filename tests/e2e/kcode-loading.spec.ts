import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("kcode.tasks")) return;
    const now = Date.now();
    const tasks = [
      { id: "plain-task", name: "普通会话", content: "普通会话的回复" },
      {
        id: "diagram-task",
        name: "流程图会话",
        content: "```mermaid\nflowchart LR\n  A[开始] --> B[完成]\n```",
      },
      {
        id: "math-task",
        name: "公式会话",
        content: "质能方程：$$E = mc^2$$",
      },
    ].map((item) => ({
      id: item.id,
      name: item.name,
      workspaceName: "加载测试项目",
      workspacePath: "D:\\projects\\loading-test",
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: `user:${item.id}`,
          role: "user",
          content: "查看结果",
          createdAt: now,
        },
        {
          id: `assistant:${item.id}`,
          role: "assistant",
          content: item.content,
          createdAt: now + 1,
        },
      ],
      activities: [],
      runStatus: "completed",
    }));
    localStorage.setItem("kcode.tasks", JSON.stringify(tasks));
    localStorage.setItem("kcode.activeTaskId", "plain-task");
  });
});

test("filters and switches conversations through the task sidebar", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "普通会话", exact: true }),
  ).toBeVisible();
  const search = page.getByRole("textbox", { name: "搜索任务" });
  await search.fill("流程图");
  await expect(
    page.getByRole("button", { name: "普通会话", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "流程图会话", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "流程图会话", exact: true }),
  ).toBeVisible();
  await search.fill("");
  await page.getByRole("button", { name: "普通会话", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "普通会话", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("普通会话的回复", { exact: true })).toBeVisible();
});

test("loads Mermaid when opening a diagram conversation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("普通会话的回复", { exact: true })).toBeVisible();
  await expect(page.locator(".mermaid-diagram")).toHaveCount(0);
  await page.getByRole("button", { name: "流程图会话", exact: true }).click();
  await expect(page.locator(".mermaid-diagram svg")).toBeVisible();
  await expect(page.locator(".mermaid-diagram")).toContainText("开始");
  await expect(page.locator(".mermaid-diagram")).toContainText("完成");
  expect(errors).toEqual([]);
});

test("loads KaTeX only when opening a math conversation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("普通会话的回复", { exact: true })).toBeVisible();
  await expect(page.locator(".katex")).toHaveCount(0);
  await page.getByRole("button", { name: "公式会话", exact: true }).click();
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(page.getByText("$$E = mc^2$$")).toHaveCount(0);
  expect(errors).toEqual([]);
});
