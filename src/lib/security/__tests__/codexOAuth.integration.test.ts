// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { codexOAuthTarget, codexOAuthTransports, codexTokenResponse, CODEX_ISSUER } from "../codexOAuth.server";
import { configureOAuthProviderTarget, OAuthSessionAdapter, resetOAuthSessionForTest } from "../oauthSession.server";
import { createMemoryCredentialStore } from "../credentialStore.server";
import { GET as guardedGet, POST as guardedPost } from "@/app/api/oauth/route";
import { POST as guardedGenerate } from "@/app/api/generate/route";
import { localApiNextRequest, resetTestLocalSessions } from "@/test/localApiRequest";
import { evaluateLocalApiRequest } from "../requestGuard.server";
import { imageCapabilities } from "@/lib/providers/imageCapabilities";
import { CODEX_IMAGE_ENDPOINT } from "@/app/api/generate/providers/openaiOAuth";

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
  const start = await POST(req("start"));
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
  it("requires a permitted client identity and does not inherit the upstream public client", async () => {
    vi.stubEnv("CRB_CODEX_OAUTH_CLIENT_ID", "");
    expect(codexOAuthTarget()).toBeNull();
    configureOAuthProviderTarget(null, {}, createMemoryCredentialStore());
    const response = await POST(req("start"));
    expect(response.status).toBe(409);
    expect((await response.json()).reason).toBe("client-registration-required");
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

  it.each([2, 3])("generates with %i ordered references, isolated credentials, and normalized SSE output", async count => {
    const { adapter } = await connect();
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const webp = await sharp(image).webp().toBuffer();
    const refs = ["target", "retained-view", "auxiliary"].slice(0, count).map(purpose => ({ image: `data:image/png;base64,${image.toString("base64")}`, purpose }));
    const permit = await POST(req("confirm-call", { accountId: adapter.browserView().account!.accountId, allowExternalData: true, allowUnknownCost: true }));
    const grant = (await permit.json()).grant;
    const event = `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "image_generation_call", result: webp.toString("base64") }], tools: [{ type: "image_generation", model: "synthetic-hosted-image" }] } })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { const bytes = new TextEncoder().encode(event); for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13)); controller.close(); } });
    network.mockResolvedValueOnce(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
    const response = await generate(localApiNextRequest("http://127.0.0.1:3210/api/generate", { method: "POST", body: JSON.stringify({
      prompt: "Preserve the design and retained view", selectedModel: { provider: "openai", modelId: "codex-image", displayName: "Codex", authChannel: "oauth" }, references: refs, dynamicInputs: { image: refs.map(ref => ref.image) }, oauthGrant: grant,
    }) }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ success: true, execution: "submitted", call: { auth: "oauth", purposes: refs.map(ref => ref.purpose), actualImageModelId: "synthetic-hosted-image", hasMask: false } });
    expect(result.image).toBe(`data:image/webp;base64,${webp.toString("base64")}`);
    const [url, init] = network.mock.calls[3];
    expect(url).toBe(CODEX_IMAGE_ENDPOINT);
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKENS.access_token}`);
    const wire = JSON.parse(init.body);
    expect(wire.input[0].content.filter((c: { type: string }) => c.type === "input_image").map((c: { image_url: string }) => c.image_url)).toEqual(refs.map(ref => ref.image));
    expect(wire.store).toBe(false);
    expect(wire.tools[0].type).toBe("image_generation");
    const replay = await generate(localApiNextRequest("http://127.0.0.1:3210/api/generate", { method: "POST", body: JSON.stringify({ prompt: "again", selectedModel: { provider: "openai", modelId: "codex-image", displayName: "Codex", authChannel: "oauth" }, oauthGrant: grant }) }));
    expect((await replay.json()).execution).toBe("not-executed");
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

  it("records a truncated image stream as unknown without retrying it", async () => {
    const { adapter } = await connect();
    const permit = await POST(req("confirm-call", { accountId: adapter.browserView().account!.accountId, allowExternalData: true, allowUnknownCost: true }));
    network.mockResolvedValueOnce(new Response('data: {"type":"response.created"}\n\n', { headers: { "content-type": "text/event-stream" } }));
    const response = await generate(localApiNextRequest("http://127.0.0.1:3210/api/generate", { method: "POST", body: JSON.stringify({ prompt: "test", selectedModel: { provider: "openai", modelId: "codex-image", displayName: "Codex", authChannel: "oauth" }, oauthGrant: (await permit.json()).grant }) }));
    expect(await response.json()).toMatchObject({ success: false, execution: "unknown", statusUnknown: true });
    expect(network).toHaveBeenCalledTimes(4);
  });
});
