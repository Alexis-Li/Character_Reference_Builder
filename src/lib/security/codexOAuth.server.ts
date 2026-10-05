/**
 * Device authorization protocol adapted from can1357/oh-my-pi (MIT),
 * 4819e4f6d59049f307329d42b226b218582bdf38:
 * packages/ai/src/registry/oauth/openai-codex.ts. See licenses/oh-my-pi-MIT.txt.
 * CRB owns sessions/storage; this module only returns protocol results.
 */
import type { OAuthProviderTarget, OAuthTransports, TokenExchangeResponse } from "./oauthSession.server";
import { anonymousConnection, bindCredentialToDestination } from "./providerConnection";
import { fetchWithConnectionPolicy } from "./outboundPolicy.server";

export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_DEVICE_PAGE = `${CODEX_ISSUER}/codex/device`;
const DEVICE_START = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
const TOKEN_ENDPOINT = `${CODEX_ISSUER}/oauth/token`;
const DEVICE_REDIRECT = `${CODEX_ISSUER}/deviceauth/callback`;

/** No reuse of another application's client identity without permission. */
export function codexOAuthTarget(): OAuthProviderTarget | null {
  const clientId = process.env.CRB_CODEX_OAUTH_CLIENT_ID?.trim();
  if (!clientId) return null;
  return {
    id: "crb-codex-device-v1", provider: "chatgpt-codex",
    implementationSource: "can1357/oh-my-pi",
    implementationVersion: "4819e4f6d59049f307329d42b226b218582bdf38",
    issuer: CODEX_ISSUER, authorizationEndpoint: CODEX_DEVICE_PAGE,
    tokenEndpoint: TOKEN_ENDPOINT, revocationEndpoint: null,
    clientId, redirectUri: DEVICE_REDIRECT, minimumScopes: [],
    accountRestrictions: "Requires a Provider-authorized client identity and account/workspace with Codex device authorization and image tool access; actual scopes, quota and model availability remain unknown until reported.",
  };
}

type Json = Record<string, unknown>;
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-provider-response");
  return value as Json;
}
function jwt(token: unknown): Json {
  if (typeof token !== "string" || token.split(".").length !== 3) return {};
  try { return record(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))); }
  catch { return {}; }
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Claims are parsed only from the fixed HTTPS token endpoint, never browser input. */
export function codexTokenResponse(raw: unknown, clientId: string): TokenExchangeResponse {
  const data = record(raw);
  const access = jwt(data.access_token);
  const identity = jwt(data.id_token);
  const auth = record(access["https://api.openai.com/auth"] ?? identity["https://api.openai.com/auth"] ?? {});
  const profile = record(access["https://api.openai.com/profile"] ?? {});
  const subject = text(identity.sub) ?? text(auth.chatgpt_user_id);
  const workspaceId = text(auth.chatgpt_account_id);
  const expiresIn = Number(data.expires_in);
  if (!text(data.access_token) || !subject || !workspaceId || !Number.isFinite(expiresIn) || expiresIn <= 0 ||
      (identity.iss !== undefined && identity.iss !== CODEX_ISSUER) ||
      (identity.aud !== undefined && !(Array.isArray(identity.aud) ? identity.aud.includes(clientId) : identity.aud === clientId))) {
    return { ok: false, error: "invalid-token-response" };
  }
  return {
    ok: true, issuer: CODEX_ISSUER, clientId,
    account: { sub: JSON.stringify([subject, workspaceId]), name: text(identity.email) ?? text(profile.email) ?? subject, workspaceId },
    tokens: {
      accessToken: text(data.access_token), refreshToken: text(data.refresh_token), idToken: text(data.id_token),
      tokenType: text(data.token_type) ?? "Bearer", expiresIn,
      ...(typeof data.scope === "string" ? { scopes: data.scope.split(/\s+/).filter(Boolean) } : {}),
    },
  };
}

/** Fixed destinations, no redirects, bounded requests, no raw Provider error bodies. */
async function send(url: string, body: BodyInit, form: boolean, signal?: AbortSignal): Promise<Response> {
  const result = await fetchWithConnectionPolicy({
    connection: anonymousConnection("chatgpt-codex-auth", "catalog", url), url, method: "POST", body,
    headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", "Accept": "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    maxRedirects: 0,
  });
  if (!result.ok) throw new Error(`authorization-network-${result.reason}`);
  signal?.throwIfAborted();
  return result.response;
}

export function codexOAuthTransports(clientId: string): OAuthTransports {
  const exchange = async (code: string, verifier: string, signal?: AbortSignal) => {
    const response = await send(TOKEN_ENDPOINT, new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: DEVICE_REDIRECT,
    }), true, signal);
    if (!response.ok) return { ok: false, error: `token-exchange-http-${response.status}` };
    return codexTokenResponse(await response.json(), clientId);
  };
  return {
    exchange: (request) => exchange(request.code, request.codeVerifier),
    async startDevice(signal) {
      const response = await send(DEVICE_START, JSON.stringify({ client_id: clientId }), false, signal);
      if (!response.ok) throw new Error(`device-start-http-${response.status}`);
      const data = record(await response.json());
      const deviceId = text(data.device_auth_id);
      const userCode = text(data.user_code) ?? text(data.usercode);
      if (!deviceId || !userCode) throw new Error("invalid-device-response");
      const interval = Number(data.interval ?? 5);
      const ttl = Number(data.expires_in ?? 900);
      if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(ttl) || ttl <= 0) throw new Error("invalid-device-response");
      return { deviceId, userCode, verificationUrl: CODEX_DEVICE_PAGE, intervalMs: Math.min(60_000, Math.max(5_000, interval * 1000 + 3000)), expiresInMs: Math.min(900_000, ttl * 1000) };
    },
    async pollDevice(device, signal) {
      const response = await send(DEVICE_POLL, JSON.stringify({ device_auth_id: device.deviceId, user_code: device.userCode }), false, signal);
      if (response.status === 403 || response.status === 404) return { pending: true as const };
      if (!response.ok) throw new Error(`device-poll-http-${response.status}`);
      const data = record(await response.json());
      const code = text(data.authorization_code), verifier = text(data.code_verifier);
      if (!code || !verifier) throw new Error("invalid-device-token-response");
      return { pending: false as const, response: await exchange(code, verifier, signal) };
    },
    async refresh(request) {
      // Refresh material is in the form body, scoped to this fixed recipient.
      const binding = bindCredentialToDestination({ provider: "chatgpt-codex-auth", role: "catalog", endpoint: TOKEN_ENDPOINT,
        credential: request.refreshToken, credentialKind: "oauth", credentialSource: "protected-store", registeredOrigins: [CODEX_ISSUER] });
      if (!binding.credential) return { ok: false, error: "recipient-not-authorized" };
      const response = await send(TOKEN_ENDPOINT, new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: binding.credential }), true);
      if (!response.ok) return { ok: false, error: `refresh-http-${response.status}` };
      return codexTokenResponse(await response.json(), clientId);
    },
    async revoke() { return { ok: false, error: "remote-revocation-unsupported" }; },
  };
}
