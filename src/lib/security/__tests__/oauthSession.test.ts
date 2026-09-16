/**
 * OAuth session acceptance suite (CRB-09 / Issue #10).
 *
 * Drives the adapter through its whole lifecycle against a synthetic,
 * fixed-version Provider target and injected transports: no network, no real
 * credential store, no filesystem. Every case asserts an externally observable
 * outcome — the session state, the refusal reason, what the browser view may
 * expose, and where the tokens actually live.
 */

import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryCredentialStore, type CredentialStore } from "../credentialStore.server";
import {
  attachAccountSummary,
  authorizeBrowserCapability,
  issueBrowserSession,
  resetLocalSessionsForTest,
} from "../localSession.server";
import {
  OAuthSessionAdapter,
  accountSummaryOf,
  configureOAuthProviderTarget,
  oauthSession,
  resetOAuthSessionForTest,
  type AuthorizationStart,
  type CallbackInput,
  type OAuthClock,
  type OAuthProviderTarget,
  type RefreshRequest,
  type RevokeRequest,
  type TokenExchangeRequest,
  type TokenExchangeResponse,
} from "../oauthSession.server";

const ORIGIN = "http://127.0.0.1:3210";
const LOCAL_SESSION_ID = "local-session-synthetic-1";
const OTHER_LOCAL_SESSION_ID = "local-session-synthetic-2";
const ISSUER = "https://auth.synthetic-provider.invalid";
const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth2/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
const REVOCATION_ENDPOINT = `${ISSUER}/oauth2/revoke`;
const REDIRECT_URI = `${ORIGIN}/api/oauth/callback`;
const CLIENT_ID = "crb-synthetic-client";
const SCOPES = ["images.read"];
const PROVIDER = "synthetic-provider";
const ACCOUNT_SUB = "acct-synthetic-1";
const ACCOUNT_NAME = "Synthetic Account";
const AUTH_CODE = "synthetic-authorization-code-0001";
const ACCESS_TOKEN = "synthetic-access-token-0001";
const ROTATED_ACCESS_TOKEN = "synthetic-access-token-0002";
const REFRESH_TOKEN = "synthetic-refresh-token-0001";
const ROTATED_REFRESH_TOKEN = "synthetic-refresh-token-0002";
const ID_TOKEN = "synthetic-id-token-0001";
const HOUR_MS = 60 * 60 * 1000;
const CLOCK_START = 1_700_000_000_000;

const TARGET: OAuthProviderTarget = {
  id: "synthetic-provider-2026-01",
  implementationSource: "synthetic-provider-js",
  implementationVersion: "4.2.0",
  provider: PROVIDER,
  issuer: ISSUER,
  authorizationEndpoint: AUTHORIZATION_ENDPOINT,
  tokenEndpoint: TOKEN_ENDPOINT,
  revocationEndpoint: REVOCATION_ENDPOINT,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  minimumScopes: SCOPES,
  accountRestrictions: "one synthetic account per registration",
};

/** Fixed clock so expiry assertions stay deterministic. */
const FIXED_CLOCK: OAuthClock = { now: () => CLOCK_START };

interface Harness {
  session: OAuthSessionAdapter;
  store: CredentialStore;
  exchanges: TokenExchangeRequest[];
  refreshes: RefreshRequest[];
  revocations: RevokeRequest[];
}

interface HarnessOptions {
  target?: OAuthProviderTarget | null;
  exchange?: (request: TokenExchangeRequest) => Promise<TokenExchangeResponse>;
  refresh?: (request: RefreshRequest) => Promise<TokenExchangeResponse>;
  revoke?: (request: RevokeRequest) => Promise<{ ok: boolean; error?: string }>;
}

function grantedTokens(overrides: { accessToken?: string; refreshToken?: string; expiresIn?: number } = {}) {
  return {
    accessToken: overrides.accessToken ?? ACCESS_TOKEN,
    refreshToken: overrides.refreshToken ?? REFRESH_TOKEN,
    idToken: ID_TOKEN,
    tokenType: "Bearer",
    scopes: SCOPES,
    expiresIn: overrides.expiresIn ?? 3600,
  };
}

function grantedResponse(account: { sub?: string; name?: string } = {}): TokenExchangeResponse {
  return {
    ok: true,
    tokens: grantedTokens(),
    account: { sub: ACCOUNT_SUB, name: ACCOUNT_NAME, ...account },
    issuer: ISSUER,
    clientId: CLIENT_ID,
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const store = createMemoryCredentialStore();
  const exchanges: TokenExchangeRequest[] = [];
  const refreshes: RefreshRequest[] = [];
  const revocations: RevokeRequest[] = [];

  const session = new OAuthSessionAdapter({
    target: options.target === undefined ? TARGET : options.target,
    transports: {
      exchange: async (request) => {
        exchanges.push(request);
        return options.exchange ? options.exchange(request) : grantedResponse();
      },
      refresh: async (request) => {
        refreshes.push(request);
        return options.refresh ? options.refresh(request) : { ok: true, tokens: grantedTokens() };
      },
      revoke: async (request) => {
        revocations.push(request);
        return options.revoke ? options.revoke(request) : { ok: true };
      },
    },
    store,
    clock: FIXED_CLOCK,
  });

  return { session, store, exchanges, refreshes, revocations };
}

function recorded<T>(items: readonly T[], index = 0): T {
  const value = items[index];
  if (value === undefined) throw new Error(`expected a recorded call at index ${index}`);
  return value;
}

function authorizationStart(session: OAuthSessionAdapter): AuthorizationStart {
  const start = session.startAuthorization(LOCAL_SESSION_ID);
  if (!start.ok) throw new Error(`expected an authorization start, received ${start.reason}`);
  return start;
}

function callbackFor(state: string, overrides: Partial<CallbackInput> = {}): CallbackInput {
  return {
    state,
    codes: [AUTH_CODE],
    sessionId: LOCAL_SESSION_ID,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    ...overrides,
  };
}

async function authenticate(h: Harness): Promise<void> {
  const start = authorizationStart(h.session);
  const result = await h.session.handleCallback(callbackFor(start.state));
  if (!result.ok) throw new Error(`expected authentication, received ${result.reason}`);
}

/** Bind a browser session to the account the adapter is authenticated as. */
function bindBrowserSession(session: OAuthSessionAdapter): { sessionId: string; capability: string } {
  const account = session.grantReview().account;
  if (!account) throw new Error("expected an authenticated account summary");
  const browser = issueBrowserSession(ORIGIN);
  attachAccountSummary(browser.sessionId, accountSummaryOf(account));
  return browser;
}

async function storedText(store: CredentialStore): Promise<string> {
  const values: string[] = [];
  for (const key of await store.keys()) {
    const value = await store.get(key);
    if (value) values.push(value);
  }
  return values.join("\n");
}

function sha256Base64url(value: string): string {
  return crypto.createHash("sha256").update(value, "ascii").digest("base64url");
}

describe("OAuth session adapter", () => {
  beforeEach(() => {
    resetLocalSessionsForTest();
  });

  afterEach(() => {
    resetOAuthSessionForTest();
  });

  it("reports the missing Provider target instead of simulating a session", async () => {
    resetOAuthSessionForTest();
    const unconfigured = oauthSession();

    expect(unconfigured.state).toBe("unconfigured");
    expect(unconfigured.providerTarget).toBeNull();
    expect(unconfigured.startAuthorization(LOCAL_SESSION_ID)).toMatchObject({
      ok: false,
      reason: "provider-not-configured",
    });
    expect(await unconfigured.handleCallback(callbackFor("fabricated-state"))).toMatchObject({
      ok: false,
      reason: "provider-not-configured",
    });
    expect(unconfigured.browserView()).toMatchObject({
      state: "unconfigured",
      provider: null,
      account: null,
      expiresAt: null,
    });

    const configured = configureOAuthProviderTarget(
      TARGET,
      { exchange: async () => grantedResponse() },
      createMemoryCredentialStore(),
    );

    expect(oauthSession()).toBe(configured);
    expect(configured.state).toBe("logged-out");
    expect(configured.providerTarget?.id).toBe(TARGET.id);
    expect(configured.startAuthorization(LOCAL_SESSION_ID).ok).toBe(true);
  });

  it("starts a unique S256 authorization per call carrying the pinned target parameters", () => {
    const h = createHarness();

    const first = authorizationStart(h.session);
    const second = authorizationStart(h.session);

    expect(first.state).not.toBe(second.state);
    expect(first.state).not.toBe("");
    expect(first.codeChallenge).not.toBe(second.codeChallenge);
    expect(first.codeChallengeMethod).toBe("S256");
    expect(first.expiresAt).toBe(CLOCK_START + 10 * 60 * 1000);
    expect(h.session.state).toBe("authorization-started");

    const url = new URL(first.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("images.read");
    expect(url.searchParams.get("state")).toBe(first.state);
    expect(url.searchParams.get("code_challenge")).toBe(first.codeChallenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("sends a verifier that hashes to the challenge in the authorization URL and never into the URL", async () => {
    const h = createHarness();

    const first = authorizationStart(h.session);
    const second = authorizationStart(h.session);
    await h.session.handleCallback(callbackFor(first.state));
    await h.session.handleCallback(callbackFor(second.state));

    expect(h.exchanges).toHaveLength(2);
    const firstExchange = recorded(h.exchanges, 0);
    const secondExchange = recorded(h.exchanges, 1);

    expect(firstExchange.codeVerifier).not.toBe(secondExchange.codeVerifier);
    expect(sha256Base64url(firstExchange.codeVerifier)).toBe(first.codeChallenge);
    expect(sha256Base64url(secondExchange.codeVerifier)).toBe(second.codeChallenge);
    expect(first.authorizationUrl).not.toContain(firstExchange.codeVerifier);
    expect(second.authorizationUrl).not.toContain(secondExchange.codeVerifier);

    expect(firstExchange).toMatchObject({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      code: AUTH_CODE,
    });
  });

  it("consumes the state once: a replayed callback never exchanges the code twice", async () => {
    const h = createHarness();
    const start = authorizationStart(h.session);
    const input = callbackFor(start.state);

    expect(await h.session.handleCallback(input)).toMatchObject({ ok: true });
    expect(await h.session.handleCallback(input)).toMatchObject({
      ok: false,
      reason: "state-replayed",
    });
    expect(h.exchanges).toHaveLength(1);

    expect(await h.session.handleCallback(callbackFor("fabricated-state"))).toMatchObject({
      ok: false,
      reason: "unknown-state",
    });
    expect(h.exchanges).toHaveLength(1);
  });

  it("refuses a callback from another issuer without spending the transaction", async () => {
    const h = createHarness();
    const start = authorizationStart(h.session);

    const refused = await h.session.handleCallback(
      callbackFor(start.state, { issuer: "https://other-issuer.invalid" }),
    );

    expect(refused).toMatchObject({ ok: false, reason: "wrong-issuer" });
    expect(h.exchanges).toHaveLength(0);
    expect(await storedText(h.store)).toBe("");

    expect(await h.session.handleCallback(callbackFor(start.state))).toMatchObject({ ok: true });
    expect(h.exchanges).toHaveLength(1);
  });

  it("refuses a callback for another client and for another redirect URI", async () => {
    const cases: ReadonlyArray<readonly [Partial<CallbackInput>, string]> = [
      [{ clientId: "other-synthetic-client" }, "wrong-client"],
      [{ redirectUri: `${ORIGIN}/api/oauth/callback/other` }, "wrong-redirect-uri"],
    ];

    for (const [overrides, reason] of cases) {
      const h = createHarness();
      const start = authorizationStart(h.session);

      expect(await h.session.handleCallback(callbackFor(start.state, overrides))).toMatchObject({
        ok: false,
        reason,
      });
      expect(h.exchanges).toHaveLength(0);
      expect(await storedText(h.store)).toBe("");
    }
  });

  it("refuses a callback whose state was started by another local session", async () => {
    const h = createHarness();
    const start = authorizationStart(h.session);

    const refused = await h.session.handleCallback(
      callbackFor(start.state, { sessionId: OTHER_LOCAL_SESSION_ID }),
    );

    expect(refused).toMatchObject({ ok: false, reason: "session-mismatch" });
    expect(h.exchanges).toHaveLength(0);
    expect(await storedText(h.store)).toBe("");
  });

  it("refuses a callback with no code and with more than one code", async () => {
    const h = createHarness();
    const cases: ReadonlyArray<readonly [readonly string[], string]> = [
      [[], "missing-code"],
      [[""], "missing-code"],
      [[AUTH_CODE, "synthetic-authorization-code-0002"], "duplicate-code"],
    ];

    for (const [codes, reason] of cases) {
      const start = authorizationStart(h.session);
      expect(
        await h.session.handleCallback(callbackFor(start.state, { codes: [...codes] })),
      ).toMatchObject({ ok: false, reason });
    }

    expect(h.exchanges).toHaveLength(0);
    expect(await storedText(h.store)).toBe("");
  });

  it("refuses a token response without an account subject and stores nothing", async () => {
    const h = createHarness({ exchange: async () => grantedResponse({ sub: undefined }) });
    const start = authorizationStart(h.session);

    const result = await h.session.handleCallback(callbackFor(start.state));

    expect(result).toMatchObject({ ok: false, reason: "account-mismatch" });
    expect(h.session.state).toBe("token-exchange-pending");
    expect(h.session.browserView()).toMatchObject({ state: "token-exchange-pending", account: null });
    expect(await h.store.keys()).toEqual([]);
  });

  it("fails closed when the exchange transport rejects and when the Provider answers non-ok", async () => {
    const rejecting = createHarness({
      exchange: async () => {
        throw new Error("synthetic transport failure");
      },
    });
    const rejectingStart = authorizationStart(rejecting.session);
    expect(await rejecting.session.handleCallback(callbackFor(rejectingStart.state))).toMatchObject({
      ok: false,
      reason: "exchange-failed",
    });
    expect(rejecting.session.state).not.toBe("authenticated");
    expect(await rejecting.store.keys()).toEqual([]);
    expect(await rejecting.session.accessToken()).toMatchObject({
      ok: false,
      reason: "not-authenticated",
    });

    const refusing = createHarness({
      exchange: async () => ({ ok: false, status: 401, error: "invalid_grant" }),
    });
    const refusingStart = authorizationStart(refusing.session);
    expect(await refusing.session.handleCallback(callbackFor(refusingStart.state))).toMatchObject({
      ok: false,
      reason: "exchange-failed",
      detail: "invalid_grant",
    });
    expect(refusing.session.state).not.toBe("authenticated");
    expect(await refusing.store.keys()).toEqual([]);
  });

  it("authenticates with tokens kept out of the browser view until the first call is confirmed", async () => {
    const h = createHarness();
    const start = authorizationStart(h.session);

    const result = await h.session.handleCallback(callbackFor(start.state));

    expect(result).toMatchObject({
      ok: true,
      account: { accountId: ACCOUNT_SUB, displayName: ACCOUNT_NAME, provider: PROVIDER },
    });
    expect(h.session.state).toBe("authenticated");

    const view = h.session.browserView();
    expect(view).toMatchObject({
      state: "authenticated",
      channel: "oauth",
      provider: PROVIDER,
      account: { accountId: ACCOUNT_SUB, displayName: ACCOUNT_NAME, provider: PROVIDER },
      scopes: ["images.read"],
      expiresAt: CLOCK_START + HOUR_MS,
      confirmationRequired: true,
    });
    const serializedView = JSON.stringify(view);
    for (const token of [ACCESS_TOKEN, REFRESH_TOKEN, ID_TOKEN]) {
      expect(serializedView).not.toContain(token);
    }

    const stored = await storedText(h.store);
    expect(stored).toContain(REFRESH_TOKEN);
    expect(stored).toContain(ACCESS_TOKEN);

    expect(await h.session.accessToken()).toMatchObject({
      ok: false,
      reason: "confirmation-required",
    });

    h.session.confirmFirstCall();

    expect(h.session.confirmationRequired).toBe(false);
    expect(await h.session.accessToken()).toMatchObject({
      ok: true,
      token: ACCESS_TOKEN,
      expiresAt: CLOCK_START + HOUR_MS,
    });
    expect(h.refreshes).toHaveLength(0);
  });

  it("rotates the refresh token and keeps the previous one when the response omits it", async () => {
    const responses: TokenExchangeResponse[] = [
      {
        ok: true,
        tokens: grantedTokens({ accessToken: ROTATED_ACCESS_TOKEN, refreshToken: ROTATED_REFRESH_TOKEN }),
      },
      { ok: true, tokens: { accessToken: "synthetic-access-token-0003", expiresIn: 1800 } },
    ];
    let index = 0;
    const h = createHarness({
      refresh: async () => {
        const response = responses[index];
        index += 1;
        if (!response) throw new Error("no queued refresh response");
        return response;
      },
    });
    await authenticate(h);

    const rotated = await h.session.refresh();

    expect(rotated).toMatchObject({
      ok: true,
      tokens: { accessToken: ROTATED_ACCESS_TOKEN, refreshToken: ROTATED_REFRESH_TOKEN },
    });
    expect(recorded(h.refreshes, 0).refreshToken).toBe(REFRESH_TOKEN);
    expect(await storedText(h.store)).toContain(ROTATED_REFRESH_TOKEN);

    const kept = await h.session.refresh();

    expect(kept).toMatchObject({
      ok: true,
      tokens: { accessToken: "synthetic-access-token-0003", refreshToken: ROTATED_REFRESH_TOKEN },
    });
    const stored = await storedText(h.store);
    expect(stored).toContain(ROTATED_REFRESH_TOKEN);
    expect(stored).not.toContain(REFRESH_TOKEN);
    expect(h.refreshes).toHaveLength(2);
  });

  it("collapses concurrent refreshes into a single token request", async () => {
    const h = createHarness({
      refresh: async () => ({
        ok: true,
        tokens: grantedTokens({ accessToken: ROTATED_ACCESS_TOKEN, refreshToken: ROTATED_REFRESH_TOKEN }),
      }),
    });
    await authenticate(h);

    const [first, second] = await Promise.all([h.session.refresh(), h.session.refresh()]);

    expect(h.refreshes).toHaveLength(1);
    expect(recorded(h.refreshes, 0).refreshToken).toBe(REFRESH_TOKEN);
    expect(first).toMatchObject({ ok: true, tokens: { accessToken: ROTATED_ACCESS_TOKEN } });
    expect(second).toEqual(first);
  });

  it("requires re-authentication after a rejected refresh without deleting the account", async () => {
    const h = createHarness({
      refresh: async () => {
        throw new Error("synthetic refresh failure");
      },
    });
    await authenticate(h);

    const result = await h.session.refresh();

    expect(result).toMatchObject({ ok: false, reason: "refresh-rejected" });
    expect(h.session.state).toBe("re-authentication-required");
    expect(h.session.browserView()).toMatchObject({
      state: "re-authentication-required",
      account: { accountId: ACCOUNT_SUB, displayName: ACCOUNT_NAME, provider: PROVIDER },
      scopes: ["images.read"],
    });
    expect(await h.store.keys()).toHaveLength(1);
    expect(await storedText(h.store)).toContain(ACCESS_TOKEN);
    expect(await h.session.accessToken()).toMatchObject({
      ok: false,
      reason: "re-authentication-required",
    });
  });

  it("requires re-authentication when the Provider refuses the refresh", async () => {
    const h = createHarness({
      refresh: async () => ({ ok: false, status: 400, error: "invalid_grant" }),
    });
    await authenticate(h);

    expect(await h.session.refresh()).toMatchObject({
      ok: false,
      reason: "refresh-rejected",
      detail: "invalid_grant",
    });
    expect(h.session.state).toBe("re-authentication-required");
    expect(h.session.browserView()).toMatchObject({ account: { accountId: ACCOUNT_SUB } });
    expect(await storedText(h.store)).toContain(ACCESS_TOKEN);
  });

  it("clears stored tokens, fails closed and revokes the account's sessions on logout", async () => {
    const h = createHarness();
    await authenticate(h);
    const browser = bindBrowserSession(h.session);
    expect(authorizeBrowserCapability(browser.capability, ORIGIN).ok).toBe(true);

    const result = await h.session.logout();

    expect(result).toMatchObject({ ok: true, revokedLocalSessions: 1 });
    expect(h.session.state).toBe("logged-out");
    expect(await h.store.keys()).toEqual([]);
    expect(h.session.browserView()).toMatchObject({
      state: "logged-out",
      account: null,
      scopes: [],
      expiresAt: null,
    });
    expect(await h.session.accessToken()).toMatchObject({
      ok: false,
      reason: "not-authenticated",
    });
    expect(authorizeBrowserCapability(browser.capability, ORIGIN)).toMatchObject({
      ok: false,
      failure: "revoked",
    });
  });

  it("reports a Provider revocation only when it actually succeeded", async () => {
    const h = createHarness({ revoke: async () => ({ ok: true }) });
    await authenticate(h);
    const browser = bindBrowserSession(h.session);

    const result = await h.session.revoke();

    expect(result).toMatchObject({ ok: true, remote: "revoked" });
    expect(recorded(h.revocations, 0)).toMatchObject({
      revocationEndpoint: REVOCATION_ENDPOINT,
      clientId: CLIENT_ID,
      token: REFRESH_TOKEN,
    });
    expect(h.session.state).toBe("revoked");
    expect(await h.store.keys()).toEqual([]);
    expect(await h.session.accessToken()).toMatchObject({
      ok: false,
      reason: "not-authenticated",
    });
    expect(authorizeBrowserCapability(browser.capability, ORIGIN)).toMatchObject({
      ok: false,
      failure: "revoked",
    });
  });

  it("never claims a remote revocation it did not get, and still clears the local session", async () => {
    const failing = createHarness({
      revoke: async () => {
        throw new Error("synthetic revocation failure");
      },
    });
    await authenticate(failing);
    const browser = bindBrowserSession(failing.session);

    expect(await failing.session.revoke()).toMatchObject({ ok: true, remote: "unknown" });
    expect(failing.session.state).toBe("revoked");
    expect(await failing.store.keys()).toEqual([]);
    expect(authorizeBrowserCapability(browser.capability, ORIGIN)).toMatchObject({
      ok: false,
      failure: "revoked",
    });

    const withoutEndpoint = createHarness({ target: { ...TARGET, revocationEndpoint: null } });
    await authenticate(withoutEndpoint);

    expect(await withoutEndpoint.session.revoke()).toMatchObject({
      ok: true,
      remote: "not-configured",
    });
    expect(withoutEndpoint.revocations).toHaveLength(0);
    expect(await withoutEndpoint.store.keys()).toEqual([]);

    // The credential disappears after authentication: no revocation request can
    // be sent, so no success may be claimed even though the endpoint exists.
    const lostCredential = createHarness();
    await authenticate(lostCredential);
    const [storedKey] = await lostCredential.store.keys();
    expect(storedKey).toBeDefined();
    if (storedKey) await lostCredential.store.delete(storedKey);

    const unreachable = await lostCredential.session.revoke();

    expect(unreachable.ok).toBe(true);
    expect(unreachable).toMatchObject({ remote: expect.not.stringMatching(/^revoked$/) });
    expect(lostCredential.revocations).toHaveLength(0);
    expect(lostCredential.session.state).toBe("revoked");
    expect(await lostCredential.store.keys()).toEqual([]);
  });

  it("removes the previous account's credential and sessions on account switch", async () => {
    const h = createHarness();
    await authenticate(h);
    const browser = bindBrowserSession(h.session);

    const result = await h.session.switchAccount();

    expect(result).toMatchObject({ ok: true, previousAccountId: ACCOUNT_SUB });
    expect(h.session.state).toBe("account-switched");
    expect(await h.store.keys()).toEqual([]);
    expect(authorizeBrowserCapability(browser.capability, ORIGIN)).toMatchObject({
      ok: false,
      failure: "revoked",
    });
    expect(await h.session.accessToken()).toMatchObject({
      ok: false,
      reason: "not-authenticated",
    });
    expect(await h.session.refresh()).toMatchObject({
      ok: false,
      reason: "not-authenticated",
    });
    expect(h.refreshes).toHaveLength(0);
  });
});
