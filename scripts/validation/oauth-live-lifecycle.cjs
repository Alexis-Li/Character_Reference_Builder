// Supervised real-account verification, deliberately outside the automated test suite.
// Never imports another application's credentials or submits a model request.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { registerHooks } = require("node:module");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
if (args.includes("--help") || !args.includes("--live")) {
  console.log("Usage: node scripts/validation/oauth-live-lifecycle.cjs --live [--denial-only | --check-runtime]\nWindows / Node 24 / CRB_TEMP_ROOT required. Creates a NEW isolated CRB credential store. A user personally approves, or with --denial-only rejects, the prepared browser transaction. Default performs real token refresh and local logout/switch/cancel checks; no generation. Public status and private authorization-link files are written under CRB_TEMP_ROOT. Never pass a token or existing credential directory.");
  if (!args.includes("--check-runtime")) process.exit(args.includes("--help") ? 0 : 2);
}
// Resolve the project's extensionless TypeScript imports only in this process.
// Node's built-in type stripping runs the production adapter without a second
// protocol implementation or a test framework using real accounts.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (!fs.existsSync(base) && fs.existsSync(`${base}.ts`)) return next(pathToFileURL(`${base}.ts`).href, context);
  }
  return next(specifier, context);
} });
const { OAuthSessionAdapter } = require("../../src/lib/security/oauthSession.server.ts");
const { codexOAuthTarget, codexOAuthTransports } = require("../../src/lib/security/codexOAuth.server.ts");
const { createProtectedFileCredentialStore } = require("../../src/lib/security/credentialStore.server.ts");
if (args.includes("--check-runtime")) { console.log("Production OAuth modules loaded; no account read or network request."); process.exit(0); }
assert.equal(process.platform, "win32", "This supervised verification currently targets Windows");
assert.ok(process.env.CRB_TEMP_ROOT, "Set CRB_TEMP_ROOT outside the repository");
assert.ok(!process.env.CRB_SYNTHETIC_OAUTH_VALIDATION && !process.env.NODE_OPTIONS, "Run without fixture preloads");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let active;
let output;
const report = { status: "running", modelRequests: 0, realTokenRefreshRequests: 0, realTokenExchangeRequests: 0 };
async function checkpoint(phase) {
  report.phase = phase;
  await fsp.writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase, modelRequests: 0 }));
}
async function awaitLogin(adapter) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (adapter.state !== "authenticated") {
    assert.ok(Date.now() < deadline && adapter.state !== "logged-out", "Browser authorization ended or timed out");
    await delay(250);
  }
}
(async () => {
  const parent = path.resolve(process.env.CRB_TEMP_ROOT, "scratch/crb-issue-10-acceptance");
  await fsp.mkdir(parent, { recursive: true });
  output = await fsp.mkdtemp(path.join(parent, "live-lifecycle-"));
  const privateParent = path.join(process.env.LOCALAPPDATA, "CharacterReferenceBuilder", "validation");
  const privateDirectory = path.join(privateParent, `crb-oauth-live-${randomUUID()}`);
  assert.ok(!fs.existsSync(privateDirectory), "Refuse an existing credential directory");
  const store = createProtectedFileCredentialStore(path.join(privateDirectory, "credentials.dpapi"));
  const target = codexOAuthTarget();
  const native = codexOAuthTransports(target.clientId);
  const transports = { ...native,
    exchange: async request => { report.realTokenExchangeRequests++; return native.exchange(request); },
    refresh: async request => { report.realTokenRefreshRequests++; return native.refresh(request); } };
  const session = `live-validation:${randomUUID()}`;
  active = new OAuthSessionAdapter({ target, store, transports });
  const view = await active.startBrowserAuthorization(session);
  assert.ok(view.browser, "Could not bind the browser callback; finish other login attempts first");
  await fsp.writeFile(path.join(output, "authorization-url.txt"), view.browser.authorizationUrl, { mode: 0o600 });
  console.log(`Supervised lifecycle output: ${output}`);
  await checkpoint("awaiting-user-browser-authorization");
  if (args.includes("--denial-only")) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (active.state !== "logged-out") {
      assert.ok(Date.now() < deadline && active.state !== "authenticated", "Expected personal rejection, not successful authorization");
      await delay(250);
    }
    assert.equal(active.browserView().failure, "authorization-denied", "No provider denial was received");
    assert.equal(report.realTokenExchangeRequests, 0, "Denied login attempted token exchange");
    assert.equal(report.realTokenRefreshRequests, 0, "Denied login attempted token refresh");
    const restored = new OAuthSessionAdapter({ target, store, transports });
    await restored.restore();
    assert.ok(!restored.browserView().account, "Denied login saved a restorable account");
    let refused = false;
    try { await fetch(target.redirectUri, { redirect: "manual", signal: AbortSignal.timeout(2000) }); } catch { refused = true; }
    assert.ok(refused, "Denied login retained its callback listener");
    report.providerConsentDenial = true; report.denialLeavesNoAccount = true; report.denialClosesCallback = true;
    report.status = "pass-for-recorded-scope";
    await checkpoint("completed");
    await fsp.unlink(path.join(output, "authorization-url.txt"));
    return;
  }
  await awaitLogin(active);
  const originalAccount = active.browserView().account.accountId;
  report.realBrowserLogin = true;
  // Shorten only the expiry metadata returned on the first restore. Tokens,
  // issuer/client validation, HTTPS exchange and resulting expiry are real.
  // Do not wait ten days or change the computer's clock or the user's store.
  let shorten = true;
  const expiryStore = { ...store, get: async key => {
    const value = await store.get(key);
    if (shorten && key.startsWith("oauth-token:") && value) {
      const token = JSON.parse(value); token.expiresAt = Date.now() - 1000; return JSON.stringify(token);
    }
    return value;
  } };
  active = new OAuthSessionAdapter({ target, store: expiryStore, transports });
  await active.restore(); shorten = false;
  await Promise.all(Array.from({ length: 6 }, () => active.refreshIfNeeded()));
  assert.ok(active.state === "authenticated" && active.browserView().account.accountId === originalAccount, "Real refresh changed or lost account identity");
  assert.ok(active.browserView().expiresAt > Date.now() + 30000, "Real refresh did not produce usable expiry");
  assert.equal(report.realTokenRefreshRequests, 1, "Concurrent callers must share one refresh");
  report.controlledExpiryTrigger = true; report.realRefreshSucceeded = true; report.concurrentRefreshSingleRequest = true;
  await checkpoint("real-refresh-passed");
  let release;
  let replyArrived;
  let replyFailed;
  const hold = new Promise(resolve => { release = resolve; });
  const arrived = new Promise((resolve, reject) => { replyArrived = resolve; replyFailed = reject; });
  const delayed = { ...transports, refresh: async request => {
    try {
      const reply = await transports.refresh(request);
      assert.ok(reply.ok, "The real delayed refresh was rejected");
      replyArrived(); await hold; return reply;
    } catch (error) { replyFailed(error); throw error; }
  } };
  active = new OAuthSessionAdapter({ target, store, transports: delayed });
  await active.restore();
  const grant = active.createCallGrant(session, originalAccount);
  assert.ok(grant, "Cannot prepare an old-operation invalidation check");
  const pendingRefresh = active.refresh();
  pendingRefresh.catch(() => {}); // arrival propagates the same failure below
  await arrived;
  // Start a new browser transaction while the actual HTTPS refresh result is
  // held. The old result must not restore the old account or operation grant.
  const switching = await active.startBrowserAuthorization(session);
  assert.ok(switching.browser && !switching.account, "Switch must first detach the old account");
  release();
  assert.ok(!(await pendingRefresh).ok, "Late real refresh result restored an ended generation");
  assert.ok(!(await active.accessTokenForCall(session, grant)).ok, "Old operation survived account switch");
  const lateCallback = new URL(switching.browser.authorizationUrl);
  const oldCallback = new URL(lateCallback.searchParams.get("redirect_uri"));
  oldCallback.searchParams.set("state", lateCallback.searchParams.get("state"));
  oldCallback.searchParams.set("code", "synthetic-never-exchanged");
  await active.logout();
  let refused = false;
  try { await fetch(oldCallback, { redirect: "manual", signal: AbortSignal.timeout(2000) }); } catch { refused = true; }
  assert.ok(refused, "Cancelled callback listener is still reachable");
  const restored = new OAuthSessionAdapter({ target, store, transports });
  await restored.restore();
  assert.ok(!restored.browserView().account, "Logout left a restorable account");
  report.realRefreshLateResultDiscarded = true; report.switchStartInvalidatesOldAccount = true;
  report.oldOperationGrantRejected = true; report.cancelClosesCallback = true; report.logoutNotRestorable = true;
  report.differentAccountCommit = "not-tested"; report.providerConsentDenial = "not-tested";
  report.status = "pass-for-recorded-scope";
  await checkpoint("completed");
  await fsp.unlink(path.join(output, "authorization-url.txt"));
})().catch(async error => {
  report.status = "fail"; report.error = error.message;
  if (output) await checkpoint("failed");
  console.error(error.message); process.exitCode = 1;
}).finally(async () => { await active?.logout(); });
