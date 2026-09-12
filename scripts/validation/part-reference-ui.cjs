const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
if (!process.env.CRB_TEMP_ROOT)
  throw new Error("Set CRB_TEMP_ROOT to an external temporary directory");
fs.mkdirSync(path.join(process.env.CRB_TEMP_ROOT, "validation"), {
  recursive: true,
});
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1500, height: 1100 },
    });
    await page.addInitScript(() =>
      localStorage.setItem("node-banana-ftux-completed", "true"),
    );
    let calls = [];
    let fail = false;
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    await page.route("**/api/generate", async (route) => {
      calls.push(route.request().postDataJSON());
      await route.fulfill({
        status: fail ? 400 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          fail
            ? { error: "测试失败", execution: "not-executed" }
            : { success: true, image: "data:image/png;base64," + png },
        ),
      });
    });
    await page.goto(process.env.CRB_BASE_URL || "http://127.0.0.1:3210");
    await page.waitForTimeout(1000);
    await page.mouse.click(10, 100);
    await page.getByRole("button", { name: "单部件参考工作区 打开" }).click();
    await page.getByText("加载默认单部件预设", { exact: true }).click();
    assert.equal(calls.length, 0);
    await page
      .getByLabel("导入原画资料")
      .setInputFiles({
        name: "front.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
    await page.getByLabel("目标说明").fill("角色左侧腰带扣，排除手");
    await page.getByText("确认／更正目标", { exact: true }).click();
    await page.getByLabel("共同设计锁定", { exact: true }).fill("保持蓝色");
    await page.getByText("保存共同锁定", { exact: true }).click();
    await page.getByText("生成候选", { exact: true }).click();
    await page.locator("article").first().waitFor();
    await page
      .locator("article")
      .first()
      .getByText("选中", { exact: true })
      .click();
    await page.getByLabel("只修改视图").selectOption("背面");
    await page.getByText("生成候选", { exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll("article").length === 2,
    );
    await page
      .locator("article")
      .nth(1)
      .getByText("从此继续／分支", { exact: true })
      .click();
    await page.getByLabel("本轮修改要求").fill("缩小扣环");
    await page.getByText("从此候选生成优化分支", { exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll("article").length === 3,
    );
    await page
      .locator("article")
      .nth(2)
      .getByText("从此继续／分支", { exact: true })
      .click();
    await page.getByLabel("本轮修改要求").fill("保留圆角");
    await page.getByText("从此候选生成优化分支", { exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll("article").length === 4,
    );
    assert(JSON.stringify(calls[3]).includes("缩小扣环"));
    assert(JSON.stringify(calls[3]).includes("保留圆角"));
    assert(JSON.stringify(calls[3]).includes("保持蓝色"));
    await page
      .locator("article")
      .nth(1)
      .getByText("从此继续／分支", { exact: true })
      .click();
    fail = true;
    await page.getByText("从此候选生成优化分支", { exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "测试失败" }).waitFor();
    assert.equal(await page.locator("article").count(), 4);
    await page
      .locator("article")
      .nth(1)
      .getByText("批准", { exact: true })
      .click();
    await page
      .locator("article")
      .nth(1)
      .getByText("选中", { exact: true })
      .click();
    assert(
      (await page.locator("article").nth(1).innerText()).includes(
        "已选中 · 已批准",
      ),
    );
    const download = page.waitForEvent("download");
    await page
      .locator("article")
      .first()
      .getByText("导出此版本", { exact: true })
      .click();
    assert((await download).suggestedFilename().includes("正面"));
    await page.screenshot({
      path: path.join(
        process.env.CRB_TEMP_ROOT,
        "validation",
        "part-reference-workspace.png",
      ),
      fullPage: true,
    });
    console.log(
      "PASS: preset, import, confirm, locks, front selection, back generation, continuous unapproved refinement, old branch failure, approval, old export; requests=" +
        calls.length,
    );
    console.log(
      "reference counts",
      calls.map((c) => c.images?.length),
    );
  } finally {
    await browser.close();
  }
})();
