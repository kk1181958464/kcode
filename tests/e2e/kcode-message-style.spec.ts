import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  test(`keeps running messages free of a left accent line in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 524, height: 244 });
    await page.setContent(`
      <html data-theme="${theme}" style="--accent: #7c3aed">
        <body>
          <article class="message assistant is-running" style="margin: 48px">
            <div class="message-avatar assistant">AI</div>
            <div class="message-content">
              <div class="message-meta">
                <span>Agent</span>
                <span class="run-state"><i></i>Generating</span>
              </div>
              <div class="message-body">Waiting for the model response...</div>
            </div>
          </article>
        </body>
      </html>
    `);
    await page.addStyleTag({ path: "src/styles.css" });

    const content = page.locator(".message-content");
    await expect(content).toHaveCSS("box-shadow", "none");
    await expect(content).toHaveCSS("border-left-width", "0px");
    await expect(page.locator(".run-state")).toBeVisible();
    await expect(page.locator(".message-body")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("running-message.png") });
  });
}
