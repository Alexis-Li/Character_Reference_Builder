// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { codexOAuthTarget, codexOAuthTransports, codexTokenResponse, CODEX_ISSUER, CODEX_PUBLIC_CLIENT_ID } from "../codexOAuth.server";
import { configureOAuthProviderTarget, OAuthSessionAdapter, resetOAuthSessionForTest } from "../oauthSession.server";
import { createMemoryCredentialStore } from "../credentialStore.server";
import { GET as guardedGet, POST as guardedPost } from "@/app/api/oauth/route";
import { POST as guardedGenerate } from "@/app/api/generate/route";
import { localApiNextRequest, resetTestLocalSessions } from "@/test/localApiRequest";
import { evaluateLocalApiRequest } from "../requestGuard.server";
import { imageCapabilities } from "@/lib/providers/imageCapabilities";
import { CODEX_IMAGE_EDIT_ENDPOINT, CODEX_IMAGE_GENERATE_ENDPOINT, CODEX_IMAGE_MODEL } from "@/app/api/generate/providers/openaiOAuth";

const CLIENT = "synthetic-permitted-crb-client";
const routeContext = () => ({ params: Promise.resolve({}) });
const POST = (request: NextRequest) => guardedPost(request, routeContext());
const GET = (request: NextRequest) => guardedGet(request, routeContext());
const generate = (request: NextRequest) => guardedGenerate(request, routeContext());
const claims = { sub: "synthetic-user", iss: CODEX_ISSUER, aud: CLIENT, email: "synthetic@example.invalid",
  "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-workspace", chatgpt_user_id: "synthetic-user" } };
const jwt = (data: unknown) => `synthetic.${Buffer.from(JSON.stringify(data)).toString("base64url")}.synthetic`;
const TOKENS = { access_token: jwt(claims), id_token: jwt(claims), refresh_token: "synthetic-refresh-private", expires_in: 3600 };
const DEVICE = { device_auth_id: "synthetic-device-private", user_code: "CRB-SYNTH", interval: "5", expires_in: 900 };
const POLL = { authorization_code: "synthetic-code-private", code_verifier: "synthetic-verifier-private" };
let network: ReturnType<typeof vi.fn>;

function harness() {
  const target = codexOAuthTarget()!;
  const store = createMemoryCredentialStore();
  const adapter = configureOAuthProviderTarget(target, codexOAuthTransports(CLIENT), store);
  return { target, store, adapter };
}
function req(action: string, extra: Record<string, unknown> = {}) {
  return localApiNextRequest("http://127.0.0.1:3210/api/oauth", { method: "POST", body: JSON.stringify({ action, ...extra }) });
}
async function connect() {
  const h = harness();
  network.mockResolvedValueOnce(Response.json(DEVICE));
  const start = await POST(req("start", { method: "device" }));
  expect(start.status).toBe(200);
  const started = await start.json();
  expect(started.oauth.device.userCode).toBe(DEVICE.user_code);
  expect(JSON.stringify(started)).not.toContain(DEVICE.device_auth_id);
  vi.setSystemTime(Date.now() + 8000);
  network.mockResolvedValueOnce(Response.json(POLL)).mockResolvedValueOnce(Response.json(TOKENS));
  const result = await POST(req("poll"));
  expect(result.status).toBe(200);
  expect((await result.json()).oauth.state).toBe("authenticated");
  return h;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T04:00:00Z"));
  vi.stubEnv("CRB_CODEX_OAUTH_CLIENT_ID", CLIENT);
  resetTestLocalSessions();
  network = vi.fn().mockRejectedValue(new Error("Unexpected external request"));
  vi.stubGlobal("fetch", network);
});
afterEach(() => { resetOAuthSessionForTest(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Codex product integration with synthetic credentials", () => {
  it("requires explicit logout before browser, device or legacy switch can replace an account", async () => {
    const { adapter } = await connect();
    const account = adapter.browserView().account;
    const calls = network.mock.calls.length;
    for (const [action, method] of [["start", "browser"], ["start", "device"], ["switch", "device"]]) {
      const response = await POST(req(action, { method }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "logout-required" });
      expect(adapter.browserView().account).toEqual(account);
    }
    expect(network).toHaveBeenCalledTimes(calls);
    expect((await POST(req("logout"))).status).toBe(200);
    network.mockResolvedValueOnce(Response.json(DEVICE));
    expect((await POST(req("start", { method: "device" }))).status).toBe(200);
    expect(adapter.browserView()).toMatchObject({ state: "authorization-started", account: null });
    expect(network).toHaveBeenCalledTimes(calls + 1);
  });

  it("configures native Codex login without requiring the user to register a client", async () => {
    vi.stubEnv("CRB_CODEX_OAUTH_CLIENT_ID", "");
    expect(codexOAuthTarget()).toMatchObject({ clientId: CODEX_PUBLIC_CLIENT_ID, redirectUri: "http://127.0.0.1:1455/auth/callback" });
    configureOAuthProviderTarget(null, {}, createMemoryCredentialStore());
    const response = await POST(req("start"));
    expect(response.status).toBe(409);
    expect((await response.json()).reason).toBe("provider-not-configured");
    expect(network).not.toHaveBeenCalled();
  });

  it("connects through real guarded routes, keeps scopes unknown, and restores from protected state", async () => {
    const { adapter, target, store } = await connect();
    const response = await GET(localApiNextRequest("http://127.0.0.1:3210/api/oauth"));
    const state = await response.json();
    expect(state.oauth).toMatchObject({ state: "authenticated", scopes: [], scopesKnown: false,
      account: { workspaceId: "synthetic-workspace" } });
    for (const secret of [TOKENS.access_token, TOKENS.refresh_token, POLL.authorization_code, POLL.code_verifier]) expect(JSON.stringify(state)).not.toContain(secret);
    expect(network).toHaveBeenCalledTimes(3);
    for (const [, init] of network.mock.calls) expect(init.redirect).toBe("manual");
    expect(JSON.parse(network.mock.calls[0][1].body).client_id).toBe(CLIENT);
    expect(new URLSearchParams(network.mock.calls[2][1].body).get("redirect_uri")).toBe(`${CODEX_ISSUER}/deviceauth/callback`);
    const restored = new OAuthSessionAdapter({ target, store, transports: codexOAuthTransports(CLIENT) });
    await restored.restore();
    expect(restored.browserView()).toMatchObject({ state: "authenticated", confirmationRequired: true, account: adapter.browserView().account });
    expect((await restored.accessToken()).ok).toBe(false);
    const changedClient = new OAuthSessionAdapter({ target: { ...target, clientId: "other-client" }, store });
    await changedClient.restore();
    expect(changedClient.browserView().account).toBeNull();
  });

  it("throttles pending polls, binds the device to its caller, and expires abandoned authorization", async () => {
    const { adapter } = harness();
    network.mockResolvedValueOnce(Response.json(DEVICE));
    await adapter.startDeviceAuthorization("owner");
    expect(adapter.viewForSession("other").device).toBeNull();
    await adapter.pollDeviceAuthorization("other");
    await adapter.pollDeviceAuthorization("owner");
    expect(network).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 8000);
    network.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await adapter.pollDeviceAuthorization("owner")).state).toBe("authorization-started");
    expect(network).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 900_000);
    expect(await adapter.pollDeviceAuthorization("owner")).toMatchObject({ state: "logged-out", device: null, failure: "device-expired" });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each(["logout", "switchAccount"] as const)("discards late device exchanges after %s", async action => {
    const { adapter, store } = harness();
    const exchange = deferred<Response>();
    network.mockResolvedValueOnce(Response.json(DEVICE));
    await adapter.startDeviceAuthorization("owner");
    vi.setSystemTime(Date.now() + 8000);
    network.mockResolvedValueOnce(Response.json(POLL)).mockImplementationOnce(() => exchange.promise);
    const pending = adapter.pollDeviceAuthorization("owner");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await adapter[action]();
    exchange.resolve(Response.json(TOKENS));
    await pending;
    expect(adapter.browserView().account).toBeNull();
    expect(await store.keys()).toEqual([]);
  });

  it("cancels a late device initiation and never starts polling it", async () => {
    const { adapter, store } = harness();
    const start = deferred<Response>();
    network.mockImplementationOnce(() => start.promise);
    const pending = adapter.startDeviceAuthorization("owner");
    await Promise.resolve(); await Promise.resolve();
    await adapter.logout();
    start.resolve(Response.json(DEVICE)); await pending;
    expect(adapter.browserView()).toMatchObject({ state: "logged-out", device: null });
    expect(await store.keys()).toEqual([]);
  });

  it("reports failed authorization and refuses a redirect without forwarding token material", async () => {
    const { adapter } = harness();
    network.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } }));
    expect(await adapter.startDeviceAuthorization("owner")).toMatchObject({ state: "logged-out", failure: "device-start-failed" });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("rejects identity substitution and exposes only Provider-reported scopes", () => {
    expect(codexTokenResponse({ ...TOKENS, id_token: jwt({ ...claims, aud: "other" }) }, CLIENT).ok).toBe(false);
    expect(codexTokenResponse({ ...TOKENS, id_token: jwt({ ...claims, iss: "https://attacker.example" }) }, CLIENT).ok).toBe(false);
    expect(codexTokenResponse({ ...TOKENS, scope: "openid profile" }, CLIENT).tokens?.scopes).toEqual(["openid", "profile"]);
    expect(codexTokenResponse({ ...TOKENS, access_token: jwt({ sub: "no-workspace" }), id_token: jwt({ ...claims, "https://api.openai.com/auth": {} }) }, CLIENT).ok).toBe(false);
  });

  it("refreshes once for concurrent callers, rejects a changed account, and does not fake remote revocation", async () => {
    const { adapter } = await connect();
    adapter.confirmFirstCall();
    vi.setSystemTime(Date.now() + 3_600_000);
    network.mockResolvedValueOnce(Response.json({ ...TOKENS, refresh_token: "synthetic-rotated" }));
    const results = await Promise.all([adapter.accessToken(), adapter.accessToken(), adapter.accessToken()]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(network).toHaveBeenCalledTimes(4);
    network.mockResolvedValueOnce(Response.json({ ...TOKENS, id_token: jwt({ ...claims, sub: "other-user" }) }));
    expect((await adapter.refresh()).ok).toBe(false);
    expect(adapter.state).toBe("re-authentication-required");
    expect(await adapter.revoke()).toMatchObject({ ok: true, remote: "not-configured" });
  });

  it("requires a one-use operation grant and invalidates it on logout/switch", async () => {
    const { adapter } = await connect();
    const request = req("confirm-call", { accountId: adapter.browserView().account!.accountId, allowExternalData: true, allowUnknownCost: true });
    const decision = evaluateLocalApiRequest(request.clone() as NextRequest);
    // Use the session identity without claiming a second nonce.
    expect(decision.ok).toBe(true);
    const sessionId = decision.ok ? decision.session.sessionId : "missing";
    const grant = adapter.createCallGrant(sessionId, adapter.browserView().account!.accountId)!;
    expect((await adapter.accessTokenForCall("other", grant)).ok).toBe(false);
    expect((await adapter.accessTokenForCall(sessionId, grant)).ok).toBe(true);
    expect((await adapter.accessTokenForCall(sessionId, grant)).ok).toBe(false);
    const stale = adapter.createCallGrant(sessionId, adapter.browserView().account!.accountId)!;
    await adapter.logout();
    expect((await adapter.accessTokenForCall(sessionId, stale)).ok).toBe(false);
  });

  it.each([0, 2, 3])("uses the official JSON image contract with %i ordered references and isolated credentials", async count => {
    const { adapter } = await connect();
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const output = count === 2 ? image : await sharp(image).webp().toBuffer();
    const outputMime = count === 2 ? "image/png" : "image/webp";
    const refs = ["target", "retained-view", "auxiliary"].slice(0, count).map(purpose => ({ image: `data:image/png;base64,${image.toString("base64")}`, purpose }));
    const permit = await POST(req("confirm-call", { accountId: adapter.browserView().account!.accountId, allowExternalData: true, allowUnknownCost: true }));
    const grant = (await permit.json()).grant;
    const event = JSON.stringify({ created: 1, data: [{ b64_json: output.toString("base64") }],
      ...(count === 2 ? { usage: { input_tokens: 20, output_tokens: 40, total_tokens: 60, access_token: "private" } } : {}) });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { const bytes = new TextEncoder().encode(event); for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13)); controller.close(); } });
    network.mockResolvedValueOnce(new Response(stream, { headers: { "Content-Type": "application/json" } }));
    const response = await generate(localApiNextRequest("http://127.0.0.1:3210/api/generate", { method: "POST", body: JSON.stringify({
      prompt: "Preserve the design and retained view", selectedModel: { provider: "openai", modelId: "codex-image", displayName: "Codex", authChannel: "oauth" }, references: refs, dynamicInputs: { image: refs.map(ref => ref.image) }, oauthGrant: grant,
    }) }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ success: true, execution: "submitted", call: { auth: "oauth", purposes: count ? refs.map(ref => ref.purpose) : null, hasMask: false } });
    expect(result.call.actualImageModelId).toBeUndefined(); // Native response does not report it.
    expect(result.image).toBe(`data:${outputMime};base64,${output.toString("base64")}`);
    const [url, init] = network.mock.calls[3];
    expect(url).toBe(count ? CODEX_IMAGE_EDIT_ENDPOINT : CODEX_IMAGE_GENERATE_ENDPOINT);
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKENS.access_token}`);
    const wire = JSON.parse(init.body);
    expect(result.call).toMatchObject({ requestedModelId: CODEX_IMAGE_MODEL, completedAt: expect.any(Number),
      promptSha256: createHash("sha256").update(wire.prompt).digest("hex"),
      referenceSha256: refs.map(() => createHash("sha256").update(image).digest("hex")),
      outputSha256: [createHash("sha256").update(output).digest("hex")] });
    if (count === 2) expect(result.call.usage).toEqual({ source: "codex-images", metrics: { input_tokens: 20, output_tokens: 40, total_tokens: 60 } });
    else expect(result.call.usage).toBeUndefined();
    expect(JSON.stringify(result.call)).not.toContain("private");
    expect(wire).toEqual({ model: CODEX_IMAGE_MODEL, prompt: expect.stringContaining("Preserve the design and retained view"),
      background: "opaque", quality: "auto", size: "auto",
      ...(count ? { images: refs.map(ref => ({ image_url: ref.image })) } : {}) });
    refs.forEach((ref, index) => expect(wire.prompt).toContain(`Reference ${index + 1} purpose: ${ref.purpose}`));
    const replay = await generate(localApiNextRequest("http://127.0.0.1:3210/api/generate", { method: "POST", body: JSON.stringify({ prompt: "again", selectedModel: { provider: "openai", modelId: "codex-image", displayName: "Codex", authChannel: "oauth" }, oauthGrant: grant }) }));
    expect((await replay.json()).execution).toBe("not-executed");
    expect(network).toHaveBeenCalledTimes(4);
  });

  it.each([
    { body: JSON.stringify({ error: { type: "invalid_request_error", code: "unsupported_value", param: "tools[0].action", message: "private-synthetic-provider-text" } }), contentType: "application/json", expected: "unsupported_value；参数 tools[0].action" },
    { body: JSON.stringify({ error: { code: "private-synthetic-provider-text", param: "private-synthetic-provider-text", message: "private-synthetic-provider-text" } }), contentType: "application/json", expected: "未提供可安全显示" },
    { body: JSON.stringify({ detail: "The model is not supported; private-synthetic-provider-text" }), contentType: "application/json", expected: "不支持所选图像模型" },
    { body: "<html>private-synthetic-provider-text</html>", contentType: "text/html", expected: "非 JSON 错误页" },
    { body: JSON.stringify({ error: { message: "private-synthetic-provider-text".repeat(2000) } }), contentType: "application/json", expected: "错误响应过大" },
  ])("classifies an HTTP rejection without echoing private text or replaying the request ($expected)", async fixture => {
    const { adapter } = await connect();
    const permit = await POST(req("confirm-call", { accountId: adapter.browserView().account!.accountId, allowExternalData: true, allowUnknownCost: true }));
    const grant = (await permit.json()).grant;
    network.mockResolvedValueOnce(new Response(fixture.body, { status: 400, headers: { "Content-Type": fixture.contentType } }));
    const request = () => generate(localApiNextRequest("http://127.0.0.1:3210/api/generate", { method: "POST", body: JSON.stringify({ prompt: "synthetic", selectedModel: { provider: "openai", modelId: "codex-image", displayName: "Codex", authChannel: "oauth" }, oauthGrant: grant }) }));
    const response = await request();
    const result = await response.json();
    expect(result).toMatchObject({ success: false, execution: "submitted", call: { auth: "oauth", stage: "failed" } });
    expect(result.error).toContain(fixture.expected);
    expect(JSON.stringify(result)).not.toContain("private-synthetic-provider-text");
    expect(network).toHaveBeenCalledTimes(4);
    expect((await (await request()).json()).execution).toBe("not-executed");
    expect(network).toHaveBeenCalledTimes(4);
  });

  it("rejects Mask before authorization/network and does not inherit API-key capabilities", async () => {
    harness();
    expect(imageCapabilities("openai", "codex-image", "oauth")?.mask).toBe(false);
    expect(imageCapabilities("openai", "gpt-image-1", "oauth")).toBeNull();
    expect(imageCapabilities("openai", "codex-image")).toBeNull();
    const response = await generate(localApiNextRequest("http://127.0.0.1:3210/api/generate", { method: "POST", body: JSON.stringify({
      prompt: "mask", selectedModel: { provider: "openai", modelId: "codex-image", displayName: "Codex", authChannel: "oauth" }, mask: "synthetic-mask",
    }) }));
    expect(response.status).toBe(422);
    expect(network).not.toHaveBeenCalled();
  });

  it("records a truncated image JSON response as unknown without retrying it", async () => {
    const { adapter } = await connect();
    const permit = await POST(req("confirm-call", { accountId: adapter.browserView().account!.accountId, allowExternalData: true, allowUnknownCost: true }));
    network.mockResolvedValueOnce(new Response('{"created":1,"data":[', { headers: { "content-type": "application/json" } }));
    const response = await generate(localApiNextRequest("http://127.0.0.1:3210/api/generate", { method: "POST", body: JSON.stringify({ prompt: "test", selectedModel: { provider: "openai", modelId: "codex-image", displayName: "Codex", authChannel: "oauth" }, oauthGrant: (await permit.json()).grant }) }));
    expect(await response.json()).toMatchObject({ success: false, execution: "unknown", statusUnknown: true });
    expect(network).toHaveBeenCalledTimes(4);
  });

  it.each([
    null,
    { data: [] },
    { data: [{ b64_json: "not-base64!" }] },
    { data: [{ b64_json: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>').toString("base64") }] },
  ])("rejects missing or unsafe native image data without replay (%j)", async body => {
    const { adapter } = await connect();
    const permit = await POST(req("confirm-call", { accountId: adapter.browserView().account!.accountId, allowExternalData: true, allowUnknownCost: true }));
    network.mockResolvedValueOnce(Response.json(body));
    const response = await generate(localApiNextRequest("http://127.0.0.1:3210/api/generate", { method: "POST", body: JSON.stringify({ prompt: "test", selectedModel: { provider: "openai", modelId: "codex-image", displayName: "Codex", authChannel: "oauth" }, oauthGrant: (await permit.json()).grant }) }));
    expect(await response.json()).toMatchObject({ success: false, execution: "unknown", statusUnknown: true });
    expect(network).toHaveBeenCalledTimes(4);
  });
});
