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
    await expect(composer).toBeVisible();
    await expect(composer).toHaveCSS("max-width", /.+/);
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveCSS("resize", "vertical");

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
});
