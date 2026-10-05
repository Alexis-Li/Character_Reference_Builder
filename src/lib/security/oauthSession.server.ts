/**
 * OAuth session adapter (CRB-09 / Issue #10).
 *
 * Authorization-code flow with PKCE S256 and a one-time state bound to the
 * local session that started it. The adapter owns the whole lifecycle:
 * authorization started, callback received, token exchange pending,
 * authenticated, refresh pending, re-authentication required, logged out,
 * revoked and account switched. Every transition preserves the Character
 * Project and selected results — the adapter never touches project data.
 *
 * The browser only ever sees an account summary and the short-lived local
 * session capability; access and refresh tokens stay in the protected
 * credential store. No automatic fallback across authorization channels
 * happens here: an unavailable OAuth session reports its own state and stops.
 *
 * Production uses the pinned Codex device protocol only when this application
 * has a Provider-permitted client identity. The generic PKCE branch remains
 * available for protocol tests; it is not a second production login system.
 */

import * as crypto from "node:crypto";
import { createMemoryCredentialStore, defaultCredentialStore, type CredentialStore } from "./credentialStore.server";
import { revokeSessionsForAccount, type AccountSummary } from "./localSession.server";
import { codexOAuthTarget, codexOAuthTransports } from "./codexOAuth.server";

export type OAuthSessionState =
  | "unconfigured"
  | "authorization-started"
  | "callback-received"
  | "token-exchange-pending"
  | "authenticated"
  | "refresh-pending"
  | "re-authentication-required"
  | "logged-out"
  | "revoked"
  | "account-switched";

/** One concrete authorization target, pinned by version and registration. */
export interface OAuthProviderTarget {
  id: string;
  /** Repository/package the flow was reviewed against. */
  implementationSource: string;
  /** Exact version or commit under review. */
  implementationVersion: string;
  /** Provider this authorization belongs to; keeps channels distinct. */
  provider: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  clientId: string;
  redirectUri: string;
  minimumScopes: readonly string[];
  accountRestrictions: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  tokenType: string;
  scopes: readonly string[];
  expiresAt: number;
}

export interface OAuthAccountIdentity {
  accountId: string;
  displayName: string;
}

export interface TokenExchangeRequest {
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

export interface TokenExchangeResponse {
  ok: boolean;
  status?: number;
  tokens?: {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    tokenType?: string;
    scopes?: readonly string[];
    expiresIn?: number;
  };
  account?: { sub?: string; name?: string; email?: string; workspaceId?: string };
  issuer?: string;
  clientId?: string;
  error?: string;
}

export interface RefreshRequest {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
}

export interface RevokeRequest {
  revocationEndpoint: string;
  clientId: string;
  token: string;
}

export interface OAuthTransports {
  exchange(request: TokenExchangeRequest): Promise<TokenExchangeResponse>;
  refresh(request: RefreshRequest): Promise<TokenExchangeResponse>;
  revoke(request: RevokeRequest): Promise<{ ok: boolean; error?: string }>;
  startDevice?(signal: AbortSignal): Promise<DeviceAuthorization>;
  pollDevice?(device: DeviceAuthorization, signal: AbortSignal): Promise<{ pending: true } | { pending: false; response: TokenExchangeResponse }>;
}

export interface DeviceAuthorization {
  deviceId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresInMs: number;
}
export interface DeviceAuthorizationView {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
}

export type AuthorizationFailure = "provider-not-configured" | "invalid-redirect-uri";

export interface AuthorizationStart {
  ok: true;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  authorizationUrl: string;
  expiresAt: number;
}

export type CallbackFailure =
  | "unknown-state"
  | "state-replayed"
  | "state-expired"
  | "session-mismatch"
  | "provider-mismatch"
  | "wrong-issuer"
  | "wrong-client"
  | "wrong-redirect-uri"
  | "missing-code"
  | "duplicate-code"
  | "exchange-failed"
  | "invalid-token-response"
  | "account-mismatch";

export type OAuthFailure =
  | AuthorizationFailure
  | CallbackFailure
  | "not-authenticated"
  | "no-refresh-token"
  | "refresh-rejected"
  | "refresh-in-flight"
  | "re-authentication-required"
  | "confirmation-required"
  | "revocation-not-configured";

export type OAuthResult<T> = ({ ok: true } & T) | { ok: false; reason: OAuthFailure; detail?: string };

export interface CallbackInput {
  state: string | null;
  codes: readonly string[];
  sessionId: string;
  issuer: string | null;
  clientId: string | null;
  redirectUri: string | null;
}

export interface BrowserSafeSessionView {
  state: OAuthSessionState;
  channel: "oauth";
  provider: string | null;
  account: OAuthAccountSummary | null;
  scopes: readonly string[];
  expiresAt: number | null;
  confirmationRequired: boolean;
  scopesKnown?: boolean;
  device?: DeviceAuthorizationView | null;
  failure?: string | null;
}

export interface OAuthAccountSummary {
  accountId: string;
  displayName: string;
  provider: string;
  workspaceId?: string;
}

export interface OAuthClock {
  now(): number;
}

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

interface AuthorizationTransaction {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  providerId: string;
  sessionId: string;
  redirectUri: string;
  issuer: string;
  clientId: string;
  createdAt: number;
  consumedAt: number | null;
}

function base64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("base64url");
}

/** PKCE S256 pair. The verifier never leaves the process. */
export function createPkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge, method: "S256" };
}

function oneTimeState(): string {
  return base64url(crypto.randomBytes(32));
}

export interface OAuthAdapterOptions {
  target: OAuthProviderTarget | null;
  transports?: Partial<OAuthTransports>;
  store?: CredentialStore;
  clock?: OAuthClock;
}

export class OAuthSessionAdapter {
  private readonly transports: Partial<OAuthTransports>;
  private readonly store: CredentialStore;
  private readonly clock: OAuthClock;

  private target: OAuthProviderTarget | null;
  private status: OAuthSessionState;
  private summaryState: OAuthAccountSummary | null = null;
  private scopesState: readonly string[] = [];
  private expiresAtState: number | null = null;
  private confirmationRequiredState = true;
  private lastFailureState: OAuthFailure | null = null;
  private transactions = new Map<string, AuthorizationTransaction>();
  private refreshInFlight: Promise<OAuthResult<{ tokens: OAuthTokens }>> | null = null;
  private generation = 0;
  private credentialMutation: Promise<void> = Promise.resolve();
  private device: { authorization: DeviceAuthorization; sessionId: string; generation: number; expiresAt: number; nextPollAt: number; controller: AbortController } | null = null;
  private devicePoll: Promise<BrowserSafeSessionView> | null = null;
  private deviceController: AbortController | null = null;
  private scopesKnown = false;
  private deviceFailure: string | null = null;
  private restoreInFlight: Promise<void> | null = null;
  private restored = false;
  private grants = new Map<string, { sessionId: string; generation: number; expiresAt: number }>();

  constructor(options: OAuthAdapterOptions) {
    this.target = options.target;
    this.transports = options.transports ?? {};
    this.store = options.store ?? (options.target ? defaultCredentialStore() : createMemoryCredentialStore());
    this.clock = options.clock ?? { now: () => Date.now() };
    this.status = options.target ? "logged-out" : "unconfigured";
  }

  get state(): OAuthSessionState {
    return this.status;
  }

  get providerTarget(): OAuthProviderTarget | null {
    return this.target;
  }

  /** Last recorded failure, for honest reporting of why a channel is unusable. */
  get lastFailure(): OAuthFailure | null {
    return this.lastFailureState;
  }

  private tokenKey(accountId: string): string {
    return `oauth-token:${this.target?.id ?? "unconfigured"}:${accountId}`;
  }

  private activeKey(): string { return `oauth-active:${this.target?.id ?? "unconfigured"}`; }

  /** Restore only our own protected store, never another application's auth files. */
  async restore(): Promise<void> {
    if (this.restored || !this.target) return;
    if (this.restoreInFlight) return this.restoreInFlight;
    const generation = this.generation;
    this.restoreInFlight = (async () => {
      const raw = await this.store.get(this.activeKey());
      if (!this.isCurrent(generation) || !raw) return;
      try {
        const saved = JSON.parse(raw);
        if (saved.clientId !== this.target?.clientId || saved.version !== this.target?.implementationVersion ||
            typeof saved.account?.accountId !== "string" || saved.account.provider !== this.target?.provider) return;
        const token = await this.store.get(this.tokenKey(saved.account.accountId));
        if (!this.isCurrent(generation) || !token) return;
        const tokens = JSON.parse(token) as OAuthTokens;
        if (typeof tokens.accessToken !== "string" || !Number.isFinite(tokens.expiresAt) || !Array.isArray(tokens.scopes)) return;
        this.summaryState = saved.account;
        this.scopesState = tokens.scopes;
        this.scopesKnown = saved.scopesKnown === true;
        this.expiresAtState = tokens.expiresAt;
        this.status = saved.state === "re-authentication-required" ? "re-authentication-required" : "authenticated";
        // A restart requires fresh external-data/cost authorization.
        this.confirmationRequiredState = true;
      } catch { /* Invalid saved state requires a new connection. */ }
    })();
    try { await this.restoreInFlight; } finally { this.restored = true; this.restoreInFlight = null; }
  }

  private isCurrent(generation: number, account?: OAuthAccountSummary): boolean {
    return generation === this.generation && (!account || this.summaryState === account);
  }

  private stale<T>(): OAuthResult<T> {
    return { ok: false, reason: "not-authenticated" };
  }

  private async mutateCredential<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.credentialMutation.then(action);
    this.credentialMutation = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private endSession(status: OAuthSessionState): void {
    // Invalidate pending exchanges, refreshes and token reads synchronously.
    // A later credential deletion is ordered after any write already in flight.
    this.generation += 1;
    this.restored = true;
    this.deviceController?.abort();
    this.deviceController = null;
    this.device = null;
    this.devicePoll = null;
    this.deviceFailure = null;
    this.grants.clear();
    this.transactions.clear();
    this.refreshInFlight = null;
    this.summaryState = null;
    this.scopesState = [];
    this.expiresAtState = null;
    this.confirmationRequiredState = true;
    this.status = status;
  }

  async startDeviceAuthorization(sessionId: string): Promise<BrowserSafeSessionView> {
    if (!this.target || !this.transports.startDevice) return this.browserView();
    const previous = this.summaryState;
    this.endSession("authorization-started");
    const generation = this.generation;
    if (previous) revokeSessionsForAccount(previous.accountId);
    await this.mutateCredential(async () => {
      if (previous) await this.store.delete(this.tokenKey(previous.accountId));
      await this.store.delete(this.activeKey());
    });
    if (!this.isCurrent(generation)) return this.browserView();
    const controller = new AbortController();
    this.deviceController = controller;
    try {
      const authorization = await this.transports.startDevice(controller.signal);
      if (!this.isCurrent(generation) || controller.signal.aborted) return this.browserView();
      if (authorization.verificationUrl !== this.target.authorizationEndpoint) throw new Error("unexpected-device-page");
      this.device = { authorization, sessionId, generation, controller,
        expiresAt: this.clock.now() + authorization.expiresInMs, nextPollAt: this.clock.now() + authorization.intervalMs };
    } catch {
      if (this.isCurrent(generation)) {
        this.endSession("logged-out");
        this.deviceFailure = "device-start-failed";
      }
    }
    return this.browserView();
  }

  async pollDeviceAuthorization(sessionId: string): Promise<BrowserSafeSessionView> {
    const device = this.device;
    if (!device || device.sessionId !== sessionId) return this.viewForSession(sessionId);
    if (this.clock.now() >= device.expiresAt) {
      this.endSession("logged-out"); this.deviceFailure = "device-expired";
      return this.browserView();
    }
    if (this.devicePoll) return this.devicePoll;
    if (this.clock.now() < device.nextPollAt || !this.transports.pollDevice) return this.browserView();
    device.nextPollAt = this.clock.now() + device.authorization.intervalMs;
    const pending = (async () => {
      try {
        const result = await this.transports.pollDevice!(device.authorization, device.controller.signal);
        if (!this.isCurrent(device.generation) || device.controller.signal.aborted) return this.viewForSession(sessionId);
        if (this.clock.now() >= device.expiresAt) throw new Error("device-expired");
        if (!result.pending) {
          this.device = null;
          this.deviceController = null;
          const committed = await this.acceptResponse(result.response, device.generation);
          if (!committed.ok && this.isCurrent(device.generation)) throw new Error("device-exchange-failed");
        }
      } catch {
        if (this.isCurrent(device.generation)) {
          this.endSession("logged-out"); this.deviceFailure = "device-authorization-failed";
        }
      }
      return this.viewForSession(sessionId);
    })();
    this.devicePoll = pending;
    try { return await pending; } finally { if (this.devicePoll === pending) this.devicePoll = null; }
  }

  viewForSession(sessionId: string): BrowserSafeSessionView {
    const view = this.browserView();
    if (this.device && this.device.sessionId !== sessionId) view.device = null;
    return view;
  }

  /** One operation, one account generation, one local caller, five minutes. */
  createCallGrant(sessionId: string, accountId: string): string | null {
    if (!this.summaryState || this.summaryState.accountId !== accountId ||
        !["authenticated", "refresh-pending"].includes(this.status)) return null;
    for (const [key, grant] of this.grants) if (grant.expiresAt <= this.clock.now()) this.grants.delete(key);
    if (this.grants.size >= 100) return null;
    const grant = oneTimeState();
    this.grants.set(grant, { sessionId, generation: this.generation, expiresAt: this.clock.now() + 300_000 });
    return grant;
  }

  async accessTokenForCall(sessionId: string, grantId: string): Promise<OAuthResult<{ token: string; expiresAt: number; isCurrent: () => boolean }>> {
    const grant = this.grants.get(grantId);
    if (!grant || grant.sessionId !== sessionId || grant.generation !== this.generation || grant.expiresAt <= this.clock.now()) {
      return { ok: false, reason: "confirmation-required" };
    }
    this.grants.delete(grantId);
    this.confirmFirstCall();
    const result = await this.accessToken();
    if (!this.isCurrent(grant.generation)) return this.stale();
    return result.ok ? { ...result, isCurrent: () => this.isCurrent(grant.generation) } : result;
  }

  /**
   * Begin an authorization transaction. The state is one-time, bound to the
   * local session and to this Provider target, and expires with the code.
   */
  startAuthorization(sessionId: string): OAuthResult<AuthorizationStart> {
    if (!this.target) {
      this.lastFailureState = "provider-not-configured";
      return { ok: false, reason: "provider-not-configured" };
    }
    const target = this.target;
    let redirect: URL;
    try {
      redirect = new URL(target.redirectUri);
    } catch {
      this.lastFailureState = "invalid-redirect-uri";
      return { ok: false, reason: "invalid-redirect-uri" };
    }
    if (redirect.protocol !== "http:" || !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(redirect.hostname)) {
      this.lastFailureState = "invalid-redirect-uri";
      return { ok: false, reason: "invalid-redirect-uri" };
    }

    const pkce = createPkcePair();
    const state = oneTimeState();
    this.transactions.set(state, {
      state,
      codeVerifier: pkce.verifier,
      codeChallenge: pkce.challenge,
      providerId: target.id,
      sessionId,
      redirectUri: target.redirectUri,
      issuer: target.issuer,
      clientId: target.clientId,
      createdAt: this.clock.now(),
      consumedAt: null,
    });

    const authorizationUrl = new URL(target.authorizationEndpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", target.clientId);
    authorizationUrl.searchParams.set("redirect_uri", target.redirectUri);
    authorizationUrl.searchParams.set("scope", target.minimumScopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    this.status = "authorization-started";
    this.lastFailureState = null;
    return {
      ok: true,
      state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: this.clock.now() + AUTHORIZATION_TTL_MS,
    };
  }

  /**
   * Handle the authorization response. Everything is checked before the code
   * is exchanged: state exists, is unconsumed, is unexpired, belongs to this
   * local session, this Provider and this redirect URI, and carries exactly one
   * code. The state is consumed before the exchange so a replayed callback can
   * never produce a second token.
   */
  async handleCallback(input: CallbackInput): Promise<OAuthResult<{ account: OAuthAccountSummary }>> {
    const target = this.target;
    const generation = this.generation;
    if (!target) {
      this.lastFailureState = "provider-not-configured";
      return { ok: false, reason: "provider-not-configured" };
    }
    if (!input.state) {
      return this.fail("unknown-state");
    }
    const transaction = this.transactions.get(input.state);
    if (!transaction) return this.fail("unknown-state");
    if (transaction.consumedAt !== null) return this.fail("state-replayed");
    if (this.clock.now() - transaction.createdAt > AUTHORIZATION_TTL_MS) {
      return this.fail("state-expired");
    }
    if (transaction.sessionId !== input.sessionId) return this.fail("session-mismatch");
    if (transaction.providerId !== target.id) return this.fail("provider-mismatch");
    if (input.issuer !== null && input.issuer !== target.issuer) return this.fail("wrong-issuer");
    if (input.clientId !== null && input.clientId !== target.clientId) return this.fail("wrong-client");
    if (input.redirectUri !== null && input.redirectUri !== target.redirectUri) {
      return this.fail("wrong-redirect-uri");
    }
    const codes = input.codes.filter((code) => typeof code === "string" && code.length > 0);
    if (codes.length === 0) return this.fail("missing-code");
    if (codes.length > 1) return this.fail("duplicate-code");

    transaction.consumedAt = this.clock.now();
    this.status = "callback-received";

    const exchange = this.transports.exchange;
    if (!exchange) {
      return this.fail("exchange-failed", "no exchange transport configured");
    }

    this.status = "token-exchange-pending";
    let response: TokenExchangeResponse;
    try {
      response = await exchange({
        tokenEndpoint: target.tokenEndpoint,
        clientId: target.clientId,
        redirectUri: target.redirectUri,
        code: codes[0],
        codeVerifier: transaction.codeVerifier,
      });
    } catch (error) {
      if (!this.isCurrent(generation)) return this.stale();
      return this.fail("exchange-failed", error instanceof Error ? error.message : "transport error");
    }

    if (!this.isCurrent(generation)) return this.stale();
    return this.acceptResponse(response, generation);
  }

  private async acceptResponse(response: TokenExchangeResponse, generation: number): Promise<OAuthResult<{ account: OAuthAccountSummary }>> {
    const target = this.target;
    if (!target || !this.isCurrent(generation)) return this.stale();
    if (!response.ok) {
      return this.fail("exchange-failed", response.error ?? `HTTP ${response.status ?? "unknown"}`);
    }
    if (response.issuer !== undefined && response.issuer !== target.issuer) {
      return this.fail("wrong-issuer", response.issuer);
    }
    if (response.clientId !== undefined && response.clientId !== target.clientId) {
      return this.fail("wrong-client", response.clientId);
    }

    const accountId = response.account?.sub?.trim();
    if (!accountId) {
      return this.fail("account-mismatch", "token response carried no account subject");
    }
    const accessToken = response.tokens?.accessToken?.trim();
    if (!accessToken) {
      return this.fail("invalid-token-response", "no access token");
    }

    const now = this.clock.now();
    const grantedScopes = response.tokens?.scopes ?? [];
    const scopesKnown = response.tokens?.scopes !== undefined;
    const tokens: OAuthTokens = {
      accessToken,
      refreshToken: response.tokens?.refreshToken ?? null,
      idToken: response.tokens?.idToken ?? null,
      tokenType: response.tokens?.tokenType ?? "Bearer",
      scopes: grantedScopes,
      expiresAt: now + (response.tokens?.expiresIn ?? 3600) * 1000,
    };
    // A successful new login supersedes token reads and refreshes started for
    // the previous account, even when no explicit switch action preceded it.
    this.generation += 1;
    const commitGeneration = this.generation;
    this.refreshInFlight = null;
    const previousAccount = this.summaryState;
    const summary: OAuthAccountSummary = {
      accountId, displayName: response.account?.name ?? response.account?.email ?? accountId,
      provider: target.provider, ...(response.account?.workspaceId ? { workspaceId: response.account.workspaceId } : {}),
    };
    await this.mutateCredential(async () => {
      if (this.isCurrent(commitGeneration)) {
        if (previousAccount && previousAccount.accountId !== accountId) {
          await this.store.delete(this.tokenKey(previousAccount.accountId));
        }
        if (!this.isCurrent(commitGeneration)) return;
        await this.store.set(this.tokenKey(accountId), JSON.stringify(tokens));
        if (this.isCurrent(commitGeneration)) {
          await this.store.set(this.activeKey(), JSON.stringify({ clientId: target.clientId,
            version: target.implementationVersion, account: summary, scopesKnown }));
        }
        if (!this.isCurrent(commitGeneration)) {
          await this.store.delete(this.tokenKey(accountId));
          await this.store.delete(this.activeKey());
        }
      }
    });
    if (!this.isCurrent(commitGeneration)) return this.stale();
    if (previousAccount && previousAccount.accountId !== accountId) {
      revokeSessionsForAccount(previousAccount.accountId);
    }

    this.summaryState = summary;
    this.scopesKnown = scopesKnown;
    this.scopesState = grantedScopes;
    this.expiresAtState = tokens.expiresAt;
    this.confirmationRequiredState = true;
    this.status = "authenticated";
    this.lastFailureState = null;
    return { ok: true, account: this.summaryState };
  }

  /**
   * Exchange the stored refresh token for a new access token. Concurrent
   * callers share one refresh so a rotating refresh token is never spent twice.
   */
  async refresh(): Promise<OAuthResult<{ tokens: OAuthTokens }>> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    const pending = this.performRefresh();
    this.refreshInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    }
  }

  private async performRefresh(): Promise<OAuthResult<{ tokens: OAuthTokens }>> {
    const target = this.target;
    const account = this.summaryState;
    const generation = this.generation;
    if (!target || !account) return this.fail("not-authenticated");
    if (this.status === "revoked") return this.fail("not-authenticated");

    const stored = await this.store.get(this.tokenKey(account.accountId));
    if (!this.isCurrent(generation, account)) return this.stale();
    if (!stored) return this.fail("not-authenticated");
    let previous: OAuthTokens;
    try {
      previous = JSON.parse(stored) as OAuthTokens;
    } catch {
      return this.fail("not-authenticated");
    }
    if (!previous.refreshToken) return this.fail("no-refresh-token");

    const refresh = this.transports.refresh;
    if (!refresh) return this.fail("refresh-rejected", "no refresh transport configured");

    this.status = "refresh-pending";
    let response: TokenExchangeResponse;
    try {
      response = await refresh({
        tokenEndpoint: target.tokenEndpoint,
        clientId: target.clientId,
        refreshToken: previous.refreshToken,
      });
    } catch (error) {
      if (!this.isCurrent(generation, account)) return this.stale();
      return this.failReauthentication(error instanceof Error ? error.message : "transport error");
    }

    if (!this.isCurrent(generation, account)) return this.stale();

    const accessToken = response.tokens?.accessToken?.trim();
    if (!response.ok || !accessToken) {
      return this.failReauthentication(response.error ?? `HTTP ${response.status ?? "unknown"}`);
    }
    if ((response.issuer !== undefined && response.issuer !== target.issuer) ||
        (response.clientId !== undefined && response.clientId !== target.clientId) ||
        (response.account?.sub !== undefined && response.account.sub !== account.accountId) ||
        (response.account?.workspaceId !== undefined && response.account.workspaceId !== account.workspaceId)) {
      return this.failReauthentication("refresh-account-mismatch");
    }

    const tokens: OAuthTokens = {
      accessToken,
      // Rotation may omit a new refresh token; keeping the previous one is the
      // only option that does not silently end the session.
      refreshToken: response.tokens?.refreshToken ?? previous.refreshToken,
      idToken: response.tokens?.idToken ?? previous.idToken,
      tokenType: response.tokens?.tokenType ?? previous.tokenType,
      scopes: response.tokens?.scopes ?? previous.scopes,
      expiresAt: this.clock.now() + (response.tokens?.expiresIn ?? 3600) * 1000,
    };
    await this.mutateCredential(async () => {
      if (this.isCurrent(generation, account)) {
        await this.store.set(this.tokenKey(account.accountId), JSON.stringify(tokens));
        if (!this.isCurrent(generation, account)) {
          await this.store.delete(this.tokenKey(account.accountId));
        }
      }
    });
    if (!this.isCurrent(generation, account)) return this.stale();
    this.scopesState = tokens.scopes;
    if (response.tokens?.scopes !== undefined) this.scopesKnown = true;
    this.expiresAtState = tokens.expiresAt;
    this.status = "authenticated";
    this.lastFailureState = null;
    return { ok: true, tokens };
  }

  /**
   * Access token for an outbound call. Fails closed when the session is not
   * authenticated, when re-authentication is required, when the account was
   * revoked, or before the user confirmed the first real call.
   */
  async accessToken(): Promise<OAuthResult<{ token: string; expiresAt: number }>> {
    const account = this.summaryState;
    const generation = this.generation;
    if (!account) return this.fail("not-authenticated");
    if (this.status === "revoked" || this.status === "logged-out" || this.status === "account-switched") {
      return this.fail("not-authenticated");
    }
    if (this.status === "re-authentication-required") return this.fail("re-authentication-required");
    if (this.confirmationRequiredState) return this.fail("confirmation-required");

    const stored = await this.store.get(this.tokenKey(account.accountId));
    if (!this.isCurrent(generation, account)) return this.stale();
    if (!stored) return this.fail("not-authenticated");
    let tokens: OAuthTokens;
    try {
      tokens = JSON.parse(stored) as OAuthTokens;
    } catch {
      return this.fail("not-authenticated");
    }
    if (tokens.expiresAt <= this.clock.now() + 30_000) {
      const refreshed = await this.refresh();
      if (!this.isCurrent(generation, account)) return this.stale();
      if (!refreshed.ok) return { ok: false, reason: refreshed.reason, detail: refreshed.detail };
      return { ok: true, token: refreshed.tokens.accessToken, expiresAt: refreshed.tokens.expiresAt };
    }
    return { ok: true, token: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  /**
   * Confirm the first real call for this account. Until this is recorded, no
   * request may be sent: a connection check cannot silently become a paid
   * generation.
   */
  confirmFirstCall(): void {
    this.confirmationRequiredState = false;
  }

  get confirmationRequired(): boolean {
    return this.confirmationRequiredState;
  }

  /**
   * End the local authentication session. Destructive to the session only:
   * project assets, runs, candidates, Review Results and the selected result
   * are untouched, and every later generation through this channel fails
   * closed because the stored tokens are gone and local sessions are revoked.
   */
  async logout(): Promise<OAuthResult<{ revokedLocalSessions: number }>> {
    const account = this.summaryState;
    this.endSession(this.target ? "logged-out" : "unconfigured");
    const revokedLocalSessions = account ? revokeSessionsForAccount(account.accountId) : 0;
    await this.mutateCredential(async () => {
      if (account) await this.store.delete(this.tokenKey(account.accountId));
      await this.store.delete(this.activeKey());
    });
    return { ok: true, revokedLocalSessions };
  }

  /**
   * Revoke at the Provider and locally. A Provider that cannot be reached
   * leaves the local session cleared and the remote result unknown — reported
   * as unknown, never as success.
   */
  async revoke(): Promise<OAuthResult<{ remote: "revoked" | "unknown" | "not-configured" }>> {
    const target = this.target;
    const account = this.summaryState;
    if (!target) return this.fail("not-authenticated");
    if (!account) {
      this.endSession("revoked");
      return this.fail("not-authenticated");
    }
    this.endSession("revoked");
    revokeSessionsForAccount(account.accountId);

    // Capture and remove the old credential before any new login can queue a
    // write for the same account. Remote revocation may then take arbitrarily
    // long without deleting the new session's credential on completion.
    const stored = await this.mutateCredential(async () => {
      const value = await this.store.get(this.tokenKey(account.accountId));
      await this.store.delete(this.tokenKey(account.accountId));
      await this.store.delete(this.activeKey());
      return value;
    });

    let remote: "revoked" | "unknown" | "not-configured" = "not-configured";
    if (target.revocationEndpoint) {
      if (stored) {
        let tokens: OAuthTokens | null = null;
        try {
          tokens = JSON.parse(stored) as OAuthTokens;
        } catch {
          tokens = null;
        }
        const revoke = this.transports.revoke;
        if (revoke && tokens?.refreshToken) {
          try {
            const result = await revoke({
              revocationEndpoint: target.revocationEndpoint,
              clientId: target.clientId,
              token: tokens.refreshToken,
            });
            remote = result.ok ? "revoked" : "unknown";
          } catch {
            remote = "unknown";
          }
        } else {
          remote = "unknown";
        }
      }
    }

    return { ok: true, remote };
  }

  /**
   * Switch accounts. The previous account's tokens are removed and its local
   * sessions revoked before any new authorization begins, so the old account
   * cannot keep spending after the user selects another.
   */
  async switchAccount(): Promise<OAuthResult<{ previousAccountId: string | null }>> {
    const previousAccountId = this.summaryState?.accountId ?? null;
    this.endSession(this.target ? "account-switched" : "unconfigured");
    if (previousAccountId) {
      revokeSessionsForAccount(previousAccountId);
    }
    await this.mutateCredential(async () => {
      if (previousAccountId) await this.store.delete(this.tokenKey(previousAccountId));
      await this.store.delete(this.activeKey());
    });
    return { ok: true, previousAccountId };
  }

  /** What the browser may see: state and account summary, never a token. */
  browserView(): BrowserSafeSessionView {
    return {
      state: this.status,
      channel: "oauth",
      provider: this.target?.provider ?? null,
      account: this.summaryState,
      scopes: this.scopesState,
      expiresAt: this.expiresAtState,
      confirmationRequired: this.confirmationRequiredState,
      scopesKnown: this.scopesKnown,
      device: this.device ? { userCode: this.device.authorization.userCode, verificationUrl: this.device.authorization.verificationUrl,
        intervalMs: this.device.authorization.intervalMs, expiresAt: this.device.expiresAt } : null,
      failure: this.deviceFailure ?? this.lastFailureState,
    };
  }

  /** Granted scopes and account identity, for the pre-enable review step. */
  grantReview(): { account: OAuthAccountSummary | null; scopes: readonly string[]; provider: string | null } {
    return {
      account: this.summaryState,
      scopes: this.scopesState,
      provider: this.target?.provider ?? null,
    };
  }

  private fail<T>(reason: OAuthFailure, detail?: string): OAuthResult<T> {
    this.lastFailureState = reason;
    return { ok: false, reason, detail };
  }

  private async failReauthentication<T>(detail: string): Promise<OAuthResult<T>> {
    // Refresh failure never deletes the account or project data: the session
    // becomes explicitly unusable and says why.
    this.status = "re-authentication-required";
    this.lastFailureState = "refresh-rejected";
    const generation = this.generation;
    const account = this.summaryState;
    await this.mutateCredential(async () => {
      if (this.isCurrent(generation, account ?? undefined)) await this.store.set(this.activeKey(), JSON.stringify({
        clientId: this.target?.clientId, version: this.target?.implementationVersion, account,
        scopesKnown: this.scopesKnown, state: "re-authentication-required",
      }));
    });
    if (!this.isCurrent(generation, account ?? undefined)) return this.stale();
    return { ok: false, reason: "refresh-rejected", detail };
  }
}

let activeAdapter: OAuthSessionAdapter | null = null;

export function oauthSession(): OAuthSessionAdapter {
  if (!activeAdapter) {
    const target = codexOAuthTarget();
    activeAdapter = new OAuthSessionAdapter({ target, ...(target ? { transports: codexOAuthTransports(target.clientId) } : {}) });
  }
  return activeAdapter;
}

/**
 * Register the Provider target under review. Until this is called with a
 * concrete, versioned target, OAuth is `unconfigured` and every authorization
 * attempt reports the missing prerequisite.
 */
export function configureOAuthProviderTarget(
  target: OAuthProviderTarget | null,
  transports?: Partial<OAuthTransports>,
  store?: CredentialStore,
): OAuthSessionAdapter {
  activeAdapter = new OAuthSessionAdapter({ target, transports, store });
  return activeAdapter;
}

/** Test seam: back to the unconfigured singleton. */
export function resetOAuthSessionForTest(): void {
  activeAdapter = new OAuthSessionAdapter({ target: null });
}

/** The account summary shape the local session store keeps (no secrets). */
export function accountSummaryOf(summary: OAuthAccountSummary): AccountSummary {
  return { accountId: summary.accountId, displayName: summary.displayName, provider: summary.provider };
}
