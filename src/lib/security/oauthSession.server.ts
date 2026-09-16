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
 * No Provider target is registered by default. Until one is selected and its
 * exact version, issuer, client registration, redirect URI and minimum scopes
 * are recorded, `authorize()` reports `provider-not-configured` — the honest
 * result, not a simulated success.
 */

import * as crypto from "node:crypto";
import { defaultCredentialStore, type CredentialStore } from "./credentialStore.server";
import { revokeSessionsForAccount, type AccountSummary } from "./localSession.server";

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
  account?: { sub?: string; name?: string; email?: string };
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
}

export interface OAuthAccountSummary {
  accountId: string;
  displayName: string;
  provider: string;
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

  constructor(options: OAuthAdapterOptions) {
    this.target = options.target;
    this.transports = options.transports ?? {};
    this.store = options.store ?? defaultCredentialStore();
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
      return this.fail("exchange-failed", error instanceof Error ? error.message : "transport error");
    }

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
    const grantedScopes = response.tokens?.scopes ?? target.minimumScopes;
    const tokens: OAuthTokens = {
      accessToken,
      refreshToken: response.tokens?.refreshToken ?? null,
      idToken: response.tokens?.idToken ?? null,
      tokenType: response.tokens?.tokenType ?? "Bearer",
      scopes: grantedScopes,
      expiresAt: now + (response.tokens?.expiresIn ?? 3600) * 1000,
    };
    await this.store.set(this.tokenKey(accountId), JSON.stringify(tokens));

    this.summaryState = {
      accountId,
      displayName: response.account?.name ?? response.account?.email ?? accountId,
      provider: target.provider,
    };
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
      this.refreshInFlight = null;
    }
  }

  private async performRefresh(): Promise<OAuthResult<{ tokens: OAuthTokens }>> {
    const target = this.target;
    const account = this.summaryState;
    if (!target || !account) return this.fail("not-authenticated");
    if (this.status === "revoked") return this.fail("not-authenticated");

    const stored = await this.store.get(this.tokenKey(account.accountId));
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
      return this.failReauthentication(error instanceof Error ? error.message : "transport error");
    }

    const accessToken = response.tokens?.accessToken?.trim();
    if (!response.ok || !accessToken) {
      return this.failReauthentication(response.error ?? `HTTP ${response.status ?? "unknown"}`);
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
    await this.store.set(this.tokenKey(account.accountId), JSON.stringify(tokens));
    this.scopesState = tokens.scopes;
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
    if (!account) return this.fail("not-authenticated");
    if (this.status === "revoked" || this.status === "logged-out" || this.status === "account-switched") {
      return this.fail("not-authenticated");
    }
    if (this.status === "re-authentication-required") return this.fail("re-authentication-required");
    if (this.confirmationRequiredState) return this.fail("confirmation-required");

    const stored = await this.store.get(this.tokenKey(account.accountId));
    if (!stored) return this.fail("not-authenticated");
    let tokens: OAuthTokens;
    try {
      tokens = JSON.parse(stored) as OAuthTokens;
    } catch {
      return this.fail("not-authenticated");
    }
    if (tokens.expiresAt <= this.clock.now() + 30_000) {
      const refreshed = await this.refresh();
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
    if (account) {
      await this.store.delete(this.tokenKey(account.accountId));
    }
    const revokedLocalSessions = account ? revokeSessionsForAccount(account.accountId) : 0;
    this.summaryState = null;
    this.scopesState = [];
    this.expiresAtState = null;
    this.confirmationRequiredState = true;
    this.status = this.target ? "logged-out" : "unconfigured";
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
    if (!target || !account) return this.fail("not-authenticated");

    let remote: "revoked" | "unknown" | "not-configured" = "not-configured";
    if (target.revocationEndpoint) {
      const stored = await this.store.get(this.tokenKey(account.accountId));
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

    await this.store.delete(this.tokenKey(account.accountId));
    revokeSessionsForAccount(account.accountId);
    this.summaryState = null;
    this.scopesState = [];
    this.expiresAtState = null;
    this.confirmationRequiredState = true;
    this.status = "revoked";
    return { ok: true, remote };
  }

  /**
   * Switch accounts. The previous account's tokens are removed and its local
   * sessions revoked before any new authorization begins, so the old account
   * cannot keep spending after the user selects another.
   */
  async switchAccount(): Promise<OAuthResult<{ previousAccountId: string | null }>> {
    const previousAccountId = this.summaryState?.accountId ?? null;
    if (previousAccountId) {
      await this.store.delete(this.tokenKey(previousAccountId));
      revokeSessionsForAccount(previousAccountId);
    }
    this.summaryState = null;
    this.scopesState = [];
    this.expiresAtState = null;
    this.confirmationRequiredState = true;
    this.status = this.target ? "account-switched" : "unconfigured";
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

  private failReauthentication<T>(detail: string): OAuthResult<T> {
    // Refresh failure never deletes the account or project data: the session
    // becomes explicitly unusable and says why.
    this.status = "re-authentication-required";
    this.lastFailureState = "refresh-rejected";
    return { ok: false, reason: "refresh-rejected", detail };
  }
}

let activeAdapter: OAuthSessionAdapter = new OAuthSessionAdapter({ target: null });

export function oauthSession(): OAuthSessionAdapter {
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
