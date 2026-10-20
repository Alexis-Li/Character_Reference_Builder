// Actual product UI/routes/callback/DPAPI/restart; only the Provider is synthetic.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/validation/oauth-ui.cjs\nCRB_TEMP_ROOT required; CRB_VALIDATION_MODE=development|production; CRB_PORT optional.\nCRB_PLAYWRIGHT_MODULE and CRB_CHROMIUM_PATH optionally select verification-only dependencies.\nStarts and stops its own isolated server; build first for production. No real account or Provider request.");
  process.exit(0);
}
const run = process.env.CRB_VALIDATION_MODE || "production";
assert.ok(["development", "production"].includes(run), "Unknown validation mode");
assert.ok(process.env.CRB_TEMP_ROOT, "Set CRB_TEMP_ROOT to the project ../.tmp directory");
const { chromium } = require(process.env.CRB_PLAYWRIGHT_MODULE || "playwright");
const port = Number(process.env.CRB_PORT || (run === "production" ? 3215 : 3214));
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, "Invalid CRB_PORT");
const baseUrl = `http://127.0.0.1:${port}`;
const repo = path.resolve(__dirname, "../..");
const output = path.join(process.env.CRB_TEMP_ROOT, "validation", "issue-10-browser-oauth", run);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, log, privateDirectory, privateParent, runtimeRoot, browser;
let serverGeneration = 0;
const refreshAudit = path.join(output, "synthetic-refresh-audit.jsonl");
async function removeOwnedDirectory(directory, parent, prefix) {
  const relative = path.relative(path.resolve(parent), path.resolve(directory));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep) && relative.startsWith(prefix), "Refuse to remove an unowned directory");
  await fs.rm(directory, { recursive: true, force: true });
}

async function startServer() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
  log = await fs.open(path.join(output, "server.log"), "a");
  server = spawn(process.execPath, run === "development" ? ["scripts/server.js"] : ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repo, windowsHide: true, stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, NODE_ENV: run, NEXT_TELEMETRY_DISABLED: "1", CRB_PORT: String(port), CRB_TEMP_ROOT: runtimeRoot, CRB_SYNTHETIC_OAUTH_VALIDATION: "1",
      CRB_CODEX_OAUTH_CLIENT_ID: "", CRB_CREDENTIAL_DIRECTORY: privateDirectory,
      CRB_SYNTHETIC_REFRESH_AUDIT: refreshAudit, CRB_SYNTHETIC_SERVER_GENERATION: String(++serverGeneration),
      NODE_OPTIONS: `--require="${path.join(__dirname, "oauth-provider-fixture.cjs").replaceAll("\\", "/")}"` },
  });
  let launchError;
  server.once("error", error => { launchError = error; });
  for (let i = 0; i < 180; i++) {
    if (launchError) throw launchError;
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}; see server.log`);
    try { if ((await fetch(baseUrl, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await delay(500);
  }
  throw new Error("Managed validation server did not start; see server.log");
}
async function stopServer() {
  if (server && server.exitCode === null) {
    const child = server;
    const stopped = new Promise(resolve => child.once("exit", resolve));
    child.kill(); await stopped;
  }
  server = null;
  await log?.close(); log = null;
}
async function openSettings(page) {
  await page.getByTitle("Project settings").waitFor();
  for (const name of [/Skip.*[Tt]our/, /Skip.*[Oo]nboarding/, /Skip for now/, /Get Started/, /Close/]) {
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible().catch(() => false)) await button.click();
  }
  // Welcome is restored asynchronously after project/session hydration.
  await page.getByText("Load workflow", { exact: true }).waitFor();
  for (let attempt = 0; ; attempt++) {
    await page.mouse.click(8, 90);
    try { await page.getByRole("button", { name: /Settings|Project Settings/i }).first().click({ timeout: 2000 }); break; }
    catch (error) { if (attempt >= 3) throw error; }
  }
  await page.getByRole("button", { name: /^Providers$/ }).click();
}
async function state(page) {
  return page.evaluate(async () => { const r = await fetch("/api/oauth"); return { status: r.status, ...await r.json() }; });
}
async function authorize(page, action, user) {
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: action, exact: true }).click();
  const popup = await opened;
  await popup.getByText("Synthetic Provider authorization", { exact: true }).waitFor();
  const auth = new URL(popup.url());
  assert.equal(auth.origin, "https://auth.openai.com");
  assert.equal(auth.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  if (user) {
    const callback = new URL(auth.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", auth.searchParams.get("state"));
    callback.searchParams.set("code", `synthetic-code-${user}`);
    const response = await popup.goto(callback.href);
    assert.equal(response.status(), 200, `${await popup.locator("body").innerText()} Failure: ${(await state(page)).oauth?.failure}`);
    await popup.getByText(/ChatGPT\/Codex connected/).waitFor();
    await page.getByText(`登录账号：synthetic-${user}@example.invalid`, { exact: true }).waitFor();
  }
  return { popup, auth };
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(refreshAudit, "");
  runtimeRoot = await fs.mkdtemp(path.join(output, "runtime-cleanup-"));
  // Product credentials outlive CRB_TEMP_ROOT. Use an isolated synthetic leaf
  // in the real OS location and remove it in finally, never any existing auth.
  privateParent = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "CharacterReferenceBuilder", "validation")
    : path.join(os.homedir(), ".local/share/character-reference-builder/validation");
  await fs.mkdir(privateParent, { recursive: true });
  privateDirectory = await fs.mkdtemp(path.join(privateParent, "crb-oauth-synthetic-"));
  await startServer();
  browser = await chromium.launch({ headless: true, ...(process.env.CRB_CHROMIUM_PATH ? { executablePath: process.env.CRB_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  let generations = 0;
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === "https://auth.openai.com") return route.fulfill({ contentType: "text/html", body: "<p>Synthetic Provider authorization</p>" });
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
    if (url.pathname === "/api/generate") generations++;
    return route.continue();
  });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("node-banana-ftux-completed", "true"));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await openSettings(page);
  const native = await state(page);
  assert.equal(native.status, 200); assert.equal(native.available, true); assert.equal(native.oauth.state, "logged-out");
  assert.ok((await context.cookies()).some(cookie => cookie.name === "crb_local_session" && cookie.httpOnly && cookie.sameSite === "Strict"));
  const loggedIn = await authorize(page, "连接账号 / 重新连接", "one"); await loggedIn.popup.close();
  const first = await state(page); assert.equal(first.oauth.scopesKnown, true);
  assert.equal((await fs.readFile(refreshAudit, "utf8")).trim(), "", "Do not refresh before the restart being tested");
  await page.getByRole("button", { name: "设为图像任务默认入口" }).click();
  await page.screenshot({ path: path.join(output, "oauth-settings.png") });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const selectedDefault = await page.evaluate(() => JSON.parse(localStorage.getItem("node-banana-node-defaults")).generateImage.selectedModel);
  assert.equal(selectedDefault.authChannel, "oauth");
  const credentialFile = path.join(privateDirectory, process.platform === "win32" ? "credentials.dpapi" : "credentials.json");
  const encrypted = await fs.readFile(credentialFile, "utf8");
  if (process.platform === "win32") assert.ok(!encrypted.includes("synthetic-refresh"), "DPAPI must persist ciphertext");
  await fs.writeFile(path.join(runtimeRoot, "synthetic-runtime.txt"), "disposable");
  await stopServer(); await removeOwnedDirectory(runtimeRoot, output, "runtime-cleanup-");
  // Enter the real adapter's 30-second renewal window while no process is
  // running. A pre-restart GET must not preemptively renew the stored token.
  const untilRenewal = Math.max(0, first.oauth.expiresAt - Date.now() - 29_000);
  assert.ok(untilRenewal <= 60_000, "Synthetic expiry must stay short");
  await delay(untilRenewal);
  assert.equal((await fs.readFile(refreshAudit, "utf8")).trim(), "", "No stopped process may renew credentials");
  await startServer();
  await page.reload({ waitUntil: "domcontentloaded" }); await openSettings(page);
  await page.getByText("登录账号：synthetic-one@example.invalid", { exact: true }).waitFor();
  const restored = await state(page);
  assert.equal(restored.oauth.state, "authenticated"); assert.equal(restored.oauth.confirmationRequired, true);
  assert.ok(restored.oauth.expiresAt > Date.now() + 300_000, "Expired credentials must automatically refresh after restart");
  const refreshes = (await fs.readFile(refreshAudit, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(refreshes.length, 1, "Exactly one renewal must follow restart");
  assert.equal(refreshes[0].generation, "2", "Renewal must occur in the restarted server");
  const switched = await authorize(page, "切换账号", "two"); await switched.popup.close();
  const cancelling = await authorize(page, "切换账号");
  await page.getByRole("button", { name: "取消连接", exact: true }).click();
  await page.getByText(/已取消等待/).waitFor(); await cancelling.popup.close();
  assert.equal((await state(page)).oauth.account, null);
  const again = await authorize(page, "连接账号 / 重新连接", "one"); await again.popup.close();
  await page.getByRole("button", { name: "退出账号", exact: true }).click();
  await page.getByRole("button", { name: "连接账号 / 重新连接", exact: true }).waitFor();
  assert.equal((await state(page)).oauth.account, null);
  const devicePopup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "使用设备码登录", exact: true }).click();
  const device = await devicePopup; await page.getByText("CRB-SYNTH", { exact: true }).waitFor();
  await page.getByText("登录账号：synthetic-one@example.invalid", { exact: true }).waitFor({ timeout: 30_000 });
  await device.close();
  await page.getByRole("button", { name: "本地断开并检查远端授权" }).click();
  await page.getByText(/远端授权状态未知/).waitFor();
  const foreign = await context.newPage();
  await foreign.route("http://127.0.0.1:3211/**", route => route.fulfill({ contentType: "text/html", body: "<p>Unrelated origin</p>" }));
  await foreign.goto("http://127.0.0.1:3211/");
  const denied = await foreign.evaluate(async url => {
    try { await fetch(`${url}/api/oauth`, { method: "POST", mode: "cors", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }) }); return false; } catch { return true; }
  }, baseUrl);
  assert.equal(denied, true); assert.equal(generations, 0);
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ run, status: "pass", generations, foreignOriginDenied: denied,
    native: { available: native.available, state: native.oauth.state }, selectedDefault, restartRestored: true, automaticRefresh: true,
    scope: "Actual product UI, guarded routes, PKCE callback, protected persistence, process restart, switch/cancel/logout/device login. Provider pages and token endpoints use synthetic fixtures. No real account or model call." }, null, 2));
  console.log(JSON.stringify({ run, status: "pass", generations, restartRestored: true, automaticRefresh: true }));
})().catch(async error => {
  console.error(error.message); process.exitCode = 1;
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
    await fs.writeFile(path.join(output, "failure.txt"), await page.locator("body").innerText()).catch(() => {});
  }
}).finally(async () => {
  await browser?.close(); await stopServer();
  if (privateDirectory) await removeOwnedDirectory(privateDirectory, privateParent, "crb-oauth-synthetic-");
  if (runtimeRoot) await removeOwnedDirectory(runtimeRoot, output, "runtime-cleanup-");
});
