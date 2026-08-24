import { expect, test } from "@playwright/test";

test.describe("KCode workbench smoke flow", () => {
  test("opens settings and switches to MCP", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByText("KCode", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.locator(".settings-panel")).toBeVisible();
    await page.getByRole("button", { name: "MCP" }).click();
    await expect(page.getByText("当前运行环境不支持 MCP 管理。")).toBeVisible();
  });

  test("shows the runtime control plane in settings", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("button", { name: "运行恢复" }).click();
    await expect(page.getByText("Agent 运行时", { exact: true })).toBeVisible();
    await expect(page.getByText("后台进程", { exact: true })).toBeVisible();
    await expect(page.getByText("恢复记录", { exact: true })).toBeVisible();
  });

  test("keeps the composer usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const composer = page.locator(".composer");
    const textarea = page.getByRole("textbox", { name: "任务输入" });
    const resizeHandle = page.getByRole("separator", {
      name: "调整输入框高度",
    });
    await expect(composer).toBeVisible();
    await expect(composer).toHaveCSS("max-width", /.+/);
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveCSS("resize", "none");
    await expect(resizeHandle).toHaveAttribute(
      "title",
      "上下拖动调整输入框高度",
    );

    const beforeDrag = await textarea.boundingBox();
    const handleBox = await resizeHandle.boundingBox();
    expect(beforeDrag).not.toBeNull();
    expect(handleBox).not.toBeNull();
    await page.mouse.move(
      handleBox!.x + handleBox!.width / 2,
      handleBox!.y + handleBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handleBox!.x + handleBox!.width / 2,
      handleBox!.y - 72,
    );
    await page.mouse.up();
    const afterDrag = await textarea.boundingBox();
    expect(afterDrag).not.toBeNull();
    expect(afterDrag!.height).toBeGreaterThan(beforeDrag!.height + 40);

    const size = await textarea.evaluate((element) => {
      const node = element as HTMLTextAreaElement;
      node.style.height = "1000px";
      const computed = getComputedStyle(node);
      return {
        renderedHeight: node.getBoundingClientRect().height,
        maxHeight: Number.parseFloat(computed.maxHeight),
      };
    });
    expect(size.renderedHeight).toBeLessThanOrEqual(size.maxHeight + 1);
    expect(size.maxHeight).toBeLessThanOrEqual(260);
    expect(size.maxHeight).toBeLessThanOrEqual(844 * 0.36 + 1);
  });

  test("forks and exports the current task", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "从当前会话创建分支" }).click();
    await expect(
      page.getByRole("heading", { name: /新对话 · 分支/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: "导出当前会话" }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: /JSON/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
  });

  test("renames a first-level workspace without renaming its conversations", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (localStorage.getItem("kcode.tasks")) return;
      const now = Date.now();
      localStorage.setItem(
        "kcode.tasks",
        JSON.stringify([
          {
            id: "rename-workspace-task",
            name: "保留的对话名",
            workspaceName: "旧工作区",
            workspacePath: "D:\\projects\\rename-workspace",
            createdAt: now,
            updatedAt: now,
            messages: [],
            activities: [],
            runStatus: "idle",
          },
        ]),
      );
      localStorage.setItem("kcode.activeTaskId", "rename-workspace-task");
    });
    await page.goto("/");

    await page.getByText("旧工作区", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名工作区" }).click();
    const dialog = page.getByRole("dialog", { name: "重命名工作区" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("工作区名称").fill("新工作区");
    await dialog.getByRole("button", { name: "保存" }).click();

    await expect(page.getByText("新工作区", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保留的对话名", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText("新工作区", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保留的对话名", exact: true }),
    ).toBeVisible();
  });

  test("keeps completed conversation content fully laid out while scrolling", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (localStorage.getItem("kcode.tasks")) return;
      const now = Date.now();
      localStorage.setItem(
        "kcode.tasks",
        JSON.stringify([
          {
            id: "scroll-layout-task",
            name: "滚动测试",
            workspaceName: "滚动测试项目",
            workspacePath: "D:\\projects\\scroll-layout",
            createdAt: now,
            updatedAt: now,
            messages: [
              {
                id: "user:scroll-layout",
                role: "user",
                content: "检查长内容滚动",
                createdAt: now,
              },
              {
                id: "assistant:scroll-layout",
                role: "assistant",
                content: Array.from(
                  { length: 80 },
                  (_, index) => `第 ${index + 1} 行滚动内容`,
                ).join("\n\n"),
                createdAt: now + 1,
              },
            ],
            activities: [],
            runStatus: "completed",
          },
        ]),
      );
      localStorage.setItem("kcode.activeTaskId", "scroll-layout-task");
    });
    await page.goto("/");

    const turn = page.locator(".conversation-turn-item.complete").first();
    const markdown = page.locator(".markdown-block").first();
    await expect(turn).toBeVisible();
    await expect(markdown).toBeVisible();
    await expect
      .poll(() =>
        turn.evaluate((element) => getComputedStyle(element).contentVisibility),
      )
      .toBe("visible");
    await expect
      .poll(() =>
        markdown.evaluate(
          (element) => getComputedStyle(element).contentVisibility,
        ),
      )
      .toBe("visible");
  });
});
