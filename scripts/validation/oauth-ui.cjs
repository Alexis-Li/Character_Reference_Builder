// Synthetic UI flow + real local HTTP boundary. Never authenticates a real account.
const { chromium } = require(process.env.CRB_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const baseUrl = process.env.CRB_BASE_URL || "http://127.0.0.1:3210";
const run = process.env.CRB_VALIDATION_MODE || "production";
const output = path.join(process.env.CRB_TEMP_ROOT, "validation", "issue-10-oauth", run);

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CRB_CHROMIUM_PATH ? { executablePath: process.env.CRB_CHROMIUM_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    // Keep onboarding out of the settings path under test.
    await page.addInitScript(() => {
      localStorage.setItem("node-banana-ftux-completed", "true");
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTitle("Project settings").waitFor();
    // Existing onboarding versions use differing flags; dismiss through the actual UI.
    for (const name of [/Skip.*[Tt]our/, /Skip.*[Oo]nboarding/, /Skip for now/, /Get Started/, /Close/]) {
      const button = page.getByRole("button", { name }).first();
      if (await button.isVisible().catch(() => false)) await button.click();
    }
    const native = await page.evaluate(async () => {
      const response = await fetch("/api/oauth");
      const value = await response.json();
      return { status: response.status, available: value.available, state: value.oauth?.state, readableCookie: document.cookie.includes("crb_local_session") };
    });
    assert.equal(native.status, 200);
    assert.equal(native.available, false);
    assert.equal(native.state, "unconfigured");
    assert.equal(native.readableCookie, false);
    const cookies = await context.cookies();
    assert.ok(cookies.some(cookie => cookie.name === "crb_local_session" && cookie.httpOnly && cookie.sameSite === "Strict"));

    // No Provider traffic: browser authorization is intercepted with a safe fixture.
    let state = "logged-out", polls = 0, generations = 0, awaitingCancellation = false;
    const actions = [];
    const view = () => ({ state, channel: "oauth", provider: "chatgpt-codex", scopes: [], scopesKnown: false,
      expiresAt: Date.now() + 3_600_000, confirmationRequired: true,
      account: state === "authenticated" ? { accountId: "synthetic-user-workspace", displayName: "Synthetic User", provider: "chatgpt-codex", workspaceId: "synthetic-workspace" } : null,
      device: state === "authorization-started" ? { userCode: "CRB-SYNTH", verificationUrl: "https://auth.openai.com/codex/device", intervalMs: 250, expiresAt: Date.now() + 900_000 } : null });
    await context.route("https://auth.openai.com/**", route => route.fulfill({ contentType: "text/html", body: "<p>Synthetic authorization page; no real account.</p>" }));
    await page.route("**/api/oauth", async route => {
      if (route.request().method() === "POST") {
        const { action } = route.request().postDataJSON();
        actions.push(action);
        if (action === "start" || action === "switch") { state = "authorization-started"; polls = 0; awaitingCancellation = action === "switch"; }
        if (action === "poll" && !awaitingCancellation && ++polls >= 2) state = "authenticated";
        if (["cancel", "logout", "revoke"].includes(action)) state = "logged-out";
      }
      await route.fulfill({ json: { success: true, available: true, oauth: view(), remote: "not-configured" } });
    });
    await page.route("**/api/generate", route => { generations++; return route.fulfill({ status: 500, json: { success: false, execution: "not-executed" } }); });
    const settings = page.getByRole("button", { name: /Settings|Project Settings/i }).first();
    await page.mouse.click(8, 90); // Dismiss the welcome overlay through its outside-click handler.
    await settings.click();
    await page.getByRole("button", { name: /^Providers$/ }).click();
    await page.getByRole("button", { name: "连接账号 / 重新连接" }).click();
    await page.getByText("CRB-SYNTH", { exact: true }).waitFor();
    await page.getByText("账号：Synthetic User", { exact: true }).waitFor();
    await page.getByRole("button", { name: "设为图像任务默认入口" }).click();
    await page.screenshot({ path: path.join(output, "oauth-settings.png") });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const selectedDefault = await page.evaluate(() => JSON.parse(localStorage.getItem("node-banana-node-defaults")).generateImage.selectedModel);
    assert.equal(selectedDefault.authChannel, "oauth");
    assert.equal(selectedDefault.modelId, "codex-image");
    await settings.click();
    await page.getByRole("button", { name: /^Providers$/ }).click();
    await page.getByRole("button", { name: "切换账号" }).click();
    await page.getByText("CRB-SYNTH", { exact: true }).waitFor();
    await page.getByRole("button", { name: "取消连接" }).click();
    await page.getByText(/已取消等待/).waitFor();
    assert.equal(generations, 0);

    // An unrelated webpage cannot acquire a capability or change auth state.
    const foreign = await context.newPage();
    await foreign.route("http://127.0.0.1:3211/**", route => route.fulfill({ contentType: "text/html", body: "<p>Unrelated origin</p>" }));
    await foreign.goto("http://127.0.0.1:3211/");
    const denied = await foreign.evaluate(async url => {
      try { await fetch(`${url}/api/oauth`, { method: "POST", mode: "cors", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }) }); return false; }
      catch { return true; }
    }, baseUrl);
    assert.equal(denied, true);
    await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ run, native, actions, generations, selectedDefault, foreignOriginDenied: denied,
      scope: "Real loopback capability/Host/Origin; OAuth UI uses intercepted synthetic responses; no real OAuth, credentials or Provider call." }, null, 2));
    console.log(JSON.stringify({ run, status: "pass", actions, generations, foreignOriginDenied: denied }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
