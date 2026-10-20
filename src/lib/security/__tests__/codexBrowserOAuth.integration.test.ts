// @vitest-environment node
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CODEX_ISSUER, codexOAuthTarget, codexOAuthTransports, codexTokenResponse } from "../codexOAuth.server";
import { listenOAuthCallback } from "../oauthCallback.server";
import { configureOAuthProviderTarget, OAuthSessionAdapter, resetOAuthSessionForTest } from "../oauthSession.server";
import { createMemoryCredentialStore } from "../credentialStore.server";
import { GET, POST } from "@/app/api/oauth/route";
import { GET as bootstrap } from "@/app/api/session/route";
import { localApiNextRequest, resetTestLocalSessions } from "@/test/localApiRequest";

const CLIENT = "synthetic-browser-client";
const jwt = (claims: unknown) => `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic`;
const claims = { iss: CODEX_ISSUER, aud: CLIENT, sub: "synthetic-browser-user", email: "browser@example.invalid",
  "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-workspace" } };
const tokens = { access_token: jwt(claims), id_token: jwt(claims), refresh_token: "synthetic-browser-refresh", expires_in: 3600 };
const adapters: OAuthSessionAdapter[] = [];
let network: ReturnType<typeof vi.fn>;

function setup(redirectUri = "http://127.0.0.1:0/auth/callback") {
  const target = codexOAuthTarget();
  const store = createMemoryCredentialStore();
  const transports = { ...codexOAuthTransports(CLIENT),
    listenForCallback: (receive: Parameters<typeof listenOAuthCallback>[1], signal: AbortSignal) => listenOAuthCallback(redirectUri, receive, signal) };
  const adapter = configureOAuthProviderTarget(target, transports, store);
  adapters.push(adapter);
  return { adapter, target, store, transports };
}
function req(action: string, extra = {}) {
  return localApiNextRequest("http://127.0.0.1:3210/api/oauth", { method: "POST", body: JSON.stringify({ action, ...extra }) });
}
const context = () => ({ params: Promise.resolve({}) });
async function start(action = "start") {
  const result = await POST(req(action), context());
  expect(result.status).toBe(200);
  const view = (await result.json()).oauth;
  expect(view.browser).toBeTruthy();
  const authUrl = new URL(view.browser.authorizationUrl);
  const callback = new URL(authUrl.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", authUrl.searchParams.get("state")!);
  callback.searchParams.set("code", "synthetic-browser-code");
  return { view, authUrl, callback };
}
function send(url: URL, headers?: Record<string, string>, method = "GET"): Promise<{ status: number; text: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, method }, response => {
      let body = "";
      response.setEncoding("utf8"); response.on("data", part => body += part);
      response.on("end", () => resolve({ status: response.statusCode!, text: body, headers: response.headers }));
    });
    request.on("error", reject); request.end();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(r => { resolve = r; }), resolve: (value: T) => resolve(value) };
}

beforeEach(() => {
  vi.stubEnv("CRB_CODEX_OAUTH_CLIENT_ID", CLIENT);
  resetTestLocalSessions();
  network = vi.fn().mockRejectedValue(new Error("Unexpected external request"));
  vi.stubGlobal("fetch", network);
});
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.logout();
  resetOAuthSessionForTest(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe("guarded browser login with real loopback callbacks and synthetic Provider responses", () => {
  it("defaults to browser PKCE, connects automatically, and restores only CRB credentials", async () => {
    const { adapter, target, store, transports } = setup();
    const { authUrl, callback } = await start();
    expect(network).not.toHaveBeenCalled(); // Opening login never submits a generation.
    expect(authUrl.origin).toBe(CODEX_ISSUER);
    expect(authUrl.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(authUrl.searchParams.get("originator")).toBe("character_reference_builder");
    expect(adapter.viewForSession("different-local-session").browser).toBeNull();
    network.mockResolvedValueOnce(Response.json(tokens));
    const response = await send(callback);
    expect(response.status).toBe(200);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    const body = new URLSearchParams(network.mock.calls[0][1].body);
    expect(body.get("redirect_uri")).toBe(`${callback.origin}${callback.pathname}`);
    expect(body.get("code")).toBe("synthetic-browser-code");
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(authUrl.searchParams.get("code_challenge"));
    const state = await (await GET(localApiNextRequest("http://127.0.0.1:3210/api/oauth"), context())).json();
    expect(state).toMatchObject({ available: true, oauth: { state: "authenticated", browser: null, scopesKnown: false,
      account: { displayName: "browser@example.invalid", workspaceId: "synthetic-workspace" } } });
    for (const secret of [tokens.access_token, tokens.refresh_token, body.get("code_verifier")!, "synthetic-browser-code"]) {
      expect(JSON.stringify(state)).not.toContain(secret); expect(response.text).not.toContain(secret);
    }
    const restored = new OAuthSessionAdapter({ target, store, transports }); adapters.push(restored);
    await restored.restore();
    expect(restored.browserView()).toMatchObject({ state: "authenticated", confirmationRequired: true, account: state.oauth.account });
    await expect(send(callback)).rejects.toThrow();
  });

  it("rejects foreign Host/method/path and wrong or repeated state without ending the legitimate login", async () => {
    const { adapter } = setup(); const { callback } = await start();
    expect((await send(callback, { Host: "attacker.example" })).status).toBe(400);
    expect((await send(callback, undefined, "POST")).status).toBe(400);
    const wrongPath = new URL(callback); wrongPath.pathname = "/other";
    expect((await send(wrongPath)).status).toBe(404);
    const wrong = new URL(callback); wrong.searchParams.set("state", "wrong");
    expect((await send(wrong)).status).toBe(400);
    const duplicate = new URL(callback); duplicate.searchParams.append("state", callback.searchParams.get("state")!);
    expect((await send(duplicate)).status).toBe(400);
    expect(adapter.state).toBe("authorization-started"); expect(network).not.toHaveBeenCalled();
    network.mockResolvedValueOnce(Response.json(tokens)); expect((await send(callback)).status).toBe(200);
  });

  it("does not disclose a pending authorization URL to a newly bootstrapped browser session", async () => {
    setup(); const { authUrl } = await start();
    const response = await bootstrap(new Request("http://127.0.0.1:3210/api/session", {
      headers: { Host: "127.0.0.1:3210", "Sec-Fetch-Site": "same-origin" },
    }));
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.oauth).toMatchObject({ browser: null, device: null, state: "authorization-started" });
    expect(JSON.stringify(value)).not.toContain(authUrl.searchParams.get("state"));
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["cancel", "logout", "switch"])("discards a late exchange after %s and never resurrects the old account", async action => {
    const { adapter, store } = setup(); const { callback } = await start();
    const exchange = deferred<Response>(); network.mockImplementationOnce(() => exchange.promise);
    const pending = send(callback);
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    const ended = await POST(req(action), context()); expect(ended.status).toBe(200);
    exchange.resolve(Response.json(tokens)); expect((await pending).status).toBe(410);
    expect(adapter.browserView().account).toBeNull(); expect(await store.keys()).toEqual([]);
  });

  it("processes a callback only once when the browser repeats it during token exchange", async () => {
    const { adapter } = setup(); const { callback } = await start();
    const exchange = deferred<Response>(); network.mockImplementationOnce(() => exchange.promise);
    const pending = send(callback); await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    expect((await send(callback)).status).toBe(409);
    exchange.resolve(Response.json(tokens)); expect((await pending).status).toBe(200);
    expect(adapter.state).toBe("authenticated"); expect(network).toHaveBeenCalledTimes(1);
  });

  it.each(["denied", "duplicate-code", "wrong-issuer", "wrong-client", "exchange-rejected"])("reports %s and releases the listener without saving an account", async failure => {
    const { adapter, store } = setup(); const { callback } = await start();
    if (failure === "denied") { callback.searchParams.delete("code"); callback.searchParams.set("error", "synthetic-secret-provider-error"); }
    if (failure === "duplicate-code") callback.searchParams.append("code", "other");
    if (failure === "wrong-issuer") callback.searchParams.set("iss", "https://other.example");
    if (failure === "wrong-client") callback.searchParams.set("client_id", "other");
    if (failure === "exchange-rejected") network.mockResolvedValueOnce(new Response("synthetic-secret-provider-error", { status: 403 }));
    const result = await send(callback); expect(result.status).toBe(400); expect(result.text).not.toContain("synthetic-secret-provider-error");
    expect(adapter.state).toBe("logged-out"); expect(await store.keys()).toEqual([]);
    expect(network).toHaveBeenCalledTimes(failure === "exchange-rejected" ? 1 : 0);
    await expect(send(callback)).rejects.toThrow();
  });

  it("invalidates the old state on reconnect, including a callback sent to the new listener", async () => {
    setup(); const old = await start(); const current = await start("switch");
    const oldState = new URL(current.callback); oldState.searchParams.set("state", old.authUrl.searchParams.get("state")!);
    expect((await send(oldState)).status).toBe(400); expect(network).not.toHaveBeenCalled();
    network.mockResolvedValueOnce(Response.json(tokens)); expect((await send(current.callback)).status).toBe(200);
  });

  it("fails closed and removes a partially saved credential when persistent metadata cannot be written", async () => {
    const { adapter, store } = setup(); const { callback } = await start();
    const save = store.set.bind(store);
    vi.spyOn(store, "set").mockImplementation(async (key, value) => {
      if (key.startsWith("oauth-active:")) throw new Error("synthetic filesystem failure");
      await save(key, value);
    });
    network.mockResolvedValueOnce(Response.json(tokens));
    expect((await send(callback)).status).toBe(500);
    expect(adapter.browserView()).toMatchObject({ state: "logged-out", account: null, failure: "credential-save-failed" });
    expect(await store.keys()).toEqual([]);
  });

  it("reports a callback port conflict and lets the user explicitly choose device login", async () => {
    const occupied = new AbortController();
    const first = await listenOAuthCallback("http://127.0.0.1:0/auth/callback", async () => ({ status: 400, message: "fixture" }), occupied.signal);
    try {
      const { adapter } = setup(first.redirectUri);
      const result = await POST(req("start"), context());
      expect((await result.json()).oauth).toMatchObject({ state: "logged-out", failure: "callback-port-in-use", browser: null });
      expect(network).not.toHaveBeenCalled();
      network.mockResolvedValueOnce(Response.json({ device_auth_id: "synthetic-device", user_code: "SYNTH-CODE", interval: 5 }));
      await POST(req("start", { method: "device" }), context());
      expect(adapter.browserView().device?.userCode).toBe("SYNTH-CODE");
    } finally { occupied.abort(); }
  });

  it("expires abandoned browser login and closes the listener", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { adapter } = setup(); const { callback } = await start();
    await vi.advanceTimersByTimeAsync(600_001);
    expect(adapter.browserView()).toMatchObject({ state: "logged-out", browser: null, failure: "authorization-expired" });
    expect(network).not.toHaveBeenCalled(); await expect(send(callback)).rejects.toThrow();
  });

  it("accepts refresh expiry from the fixed endpoint's JWT when expires_in is omitted", () => {
    const { expires_in: _unused, ...withoutExpiry } = tokens;
    expect(codexTokenResponse({ ...withoutExpiry, access_token: jwt({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 }) }, CLIENT)).toMatchObject({ ok: true });
    expect(codexTokenResponse(withoutExpiry, CLIENT).ok).toBe(false);
  });
});
