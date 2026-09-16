/**
 * Reading a ComfyUI connection off an incoming request.
 *
 * The browser holds the user's engine settings (same as every other provider
 * key in Node Banana) and forwards them per request, so an API route never
 * needs server-side configuration to reach the right engine. Environment
 * variables act as a fallback for a headless / shared deployment.
 *
 * CRB-09: a credential is only ever used together with the destination it was
 * bound to, and this module is where that binding is decided. Three channels
 * meet here, and none of them widens another:
 * - the engine key authenticates the engine this request names (or the one the
 *   environment configures);
 * - the partner-node key pays for comfy.org API nodes *inside* a graph — a
 *   different capability, held by a different person in a shared deployment;
 * - a server environment credential never rides to a destination a request just
 *   named unless that destination is the registered recipient.
 */

import {
  bindCredentialToDestination,
  credentialAllowedFor,
  PROVIDER_RECIPIENTS,
  type CredentialSource,
  type ProviderConnection,
} from "@/lib/security/providerConnection";
import {
  fetchWithConnectionPolicy,
  type CredentialPlacement,
  type OutboundOutcome,
} from "@/lib/security/outboundPolicy.server";
import {
  clampJobTimeoutMs,
  COMFY_HEADERS,
  COMFY_CLOUD_URL,
  COMFY_DEFAULT_JOB_TIMEOUT_MS,
} from "../settings";
import type { ComfyBackendMode, ComfyConnection } from "../types";
import { ComfyEngineError } from "./engine";
import { resilientFetch } from "./fetch";

export class ComfyConfigError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ComfyConfigError";
    this.status = status;
  }
}

/**
 * Validate an engine base URL.
 *
 * This is a shape check only: private and loopback addresses are allowed here
 * because pointing at `127.0.0.1:8188` is the entire purpose of local mode.
 * Whether the host may actually be reached is a second decision, made per
 * request: the binding's `allowNonPublicDestination` decides if a destination
 * may resolve to the user's own machines, and the outbound policy seam
 * classifies every hop (cloud metadata and link-local addresses never qualify).
 * See {@link connectionFromRequest}.
 */
export function validateEngineUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ComfyConfigError(`"${raw}" is not a valid ComfyUI URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ComfyConfigError(`ComfyUI URL must be http or https, not ${parsed.protocol}`);
  }
  return raw.replace(/\/+$/, "");
}

/* ── credential binding ────────────────────────────────────────── */

/** The destinations the product registers for the comfy.org engine role. */
const COMFY_ENGINE_RECIPIENTS: readonly string[] = PROVIDER_RECIPIENTS.comfy?.engine ?? [];

interface EngineBindingInput {
  mode: ComfyBackendMode;
  baseUrl: string;
  useSdk: boolean;
  jobTimeoutMs: number;
  /** The key offered for this destination, or null when none was. */
  credential: string | null;
  credentialSource: CredentialSource;
  /**
   * True only when this configuration itself paired the key with the
   * destination. Naming a destination — in a request or anywhere else — is not
   * on its own an authorization for a credential the caller did not supply.
   */
  userAuthorizedDestination: boolean;
  /**
   * Whether the destination may resolve to a loopback/private address. True for
   * a user-declared local/LAN engine; false for a destination a request named
   * without also carrying its key, so naming an internal host is not enough to
   * make the server reach into the network.
   */
  allowNonPublicDestination: boolean;
}

/**
 * Bind the offered engine key to the destination it is for, and turn the result
 * into the connection record callers see.
 *
 * The credential that lands on the record is the *bound* one: when policy
 * withholds the key, `apiKey` is null and `credentialWithheld` says why, so
 * nothing downstream — the SDK reads `apiKey` directly — can send it.
 */
function bindEngineConnection(input: EngineBindingInput): ComfyConnection {
  const binding = bindCredentialToDestination({
    provider: "comfy",
    role: "engine",
    endpoint: input.baseUrl,
    credential: input.credential,
    // A connection with nothing to send is not an api-key channel at all.
    credentialKind: input.credential ? "api-key" : "none",
    credentialSource: input.credentialSource,
    userAuthorizedDestination: input.userAuthorizedDestination,
    allowNonPublicDestination: input.allowNonPublicDestination,
  });
  return {
    mode: input.mode,
    baseUrl: input.baseUrl,
    apiKey: binding.credential,
    useSdk: input.useSdk,
    jobTimeoutMs: input.jobTimeoutMs,
    providerConnection: binding.connection,
    credentialWithheld: binding.withheld,
  };
}

/**
 * The binding for a connection that carries none.
 *
 * Only a record built by hand has no binding (the client-side settings
 * resolver, a test double): it has no provenance to state, and is treated as
 * what it literally is — a credential offered together with the destination it
 * addresses. Every connection resolved from a request or the environment
 * carries the binding that was actually computed for it.
 */
export function providerConnectionFor(connection: ComfyConnection): ProviderConnection {
  if (connection.providerConnection) return connection.providerConnection;
  return bindCredentialToDestination({
    provider: "comfy",
    role: "engine",
    endpoint: connection.baseUrl,
    credential: connection.apiKey,
    credentialKind: connection.apiKey ? "api-key" : "none",
    credentialSource: connection.apiKey ? "browser-supplied" : "none",
    userAuthorizedDestination: true,
    allowNonPublicDestination: true,
  }).connection;
}

/**
 * The engine the environment configures, used when a request names none.
 *
 * The endpoint and the key here come from the same operator configuration —
 * nothing request-scoped named either — so the pairing is authorized by that
 * configuration, and it is recorded as a server-held credential rather than as
 * a request-supplied one. A request-named destination never reaches this path:
 * {@link connectionFromRequest} binds that case itself.
 */
function envConnection(): ComfyConnection | null {
  const mode = (process.env.COMFY_MODE as ComfyBackendMode | undefined) ?? "cloud";
  if (mode === "cloud") {
    const apiKey = process.env.COMFY_CLOUD_API_KEY?.trim();
    if (!apiKey) return null;
    return bindEngineConnection({
      mode: "cloud",
      baseUrl: validateEngineUrl(process.env.COMFY_CLOUD_URL?.trim() || COMFY_CLOUD_URL),
      useSdk: true,
      jobTimeoutMs: COMFY_DEFAULT_JOB_TIMEOUT_MS,
      credential: apiKey,
      credentialSource: "protected-store",
      userAuthorizedDestination: true,
      // The operator configured this endpoint; nothing request-scoped named it.
      allowNonPublicDestination: true,
    });
  }
  const url = (mode === "local" ? process.env.COMFY_LOCAL_URL : process.env.COMFY_REMOTE_URL)?.trim();
  if (!url) return null;
  return bindEngineConnection({
    mode,
    baseUrl: validateEngineUrl(url),
    useSdk: process.env.COMFY_API_V2 === "1",
    jobTimeoutMs: COMFY_DEFAULT_JOB_TIMEOUT_MS,
    credential: process.env.COMFY_API_KEY?.trim() || null,
    credentialSource: "protected-store",
    userAuthorizedDestination: true,
    allowNonPublicDestination: true,
  });
}

/**
 * The engine this request targets.
 *
 * @throws {ComfyConfigError} when neither the request nor the environment
 * names a reachable engine — the message is shown to the user verbatim.
 */
export function connectionFromRequest(request: Request): ComfyConnection {
  const headers = request.headers;
  const rawMode = headers.get(COMFY_HEADERS.mode);
  const rawBaseUrl = headers.get(COMFY_HEADERS.baseUrl);

  if (!rawBaseUrl) {
    const fallback = envConnection();
    if (fallback) return fallback;
    throw new ComfyConfigError(
      "No ComfyUI engine is configured. Open Settings → ComfyUI to connect to Comfy Cloud or a local install."
    );
  }

  const mode: ComfyBackendMode =
    rawMode === "local" || rawMode === "remote" || rawMode === "cloud" ? rawMode : "cloud";
  const timeout = headers.get(COMFY_HEADERS.jobTimeout);
  const baseUrl = validateEngineUrl(rawBaseUrl);
  const requestKey = headers.get(COMFY_HEADERS.apiKey)?.trim() || null;
  const envKey = process.env.COMFY_API_KEY?.trim() || null;

  // `userAuthorizedDestination` is exactly "this request carried both the
  // destination and the key". Naming a destination but no key proves nothing
  // about the server's key, so for any origin outside the registered
  // Comfy Cloud recipient that key is withheld — the call then runs
  // unauthenticated and fails honestly upstream, instead of handing the
  // environment credential to whatever host the caller named.
  const userAuthorizedDestination = Boolean(requestKey);
  return bindEngineConnection({
    mode,
    baseUrl,
    useSdk: headers.get(COMFY_HEADERS.apiV2) === "1",
    jobTimeoutMs: clampJobTimeoutMs(timeout),
    credential: requestKey ?? envKey,
    credentialSource: requestKey ? "browser-supplied" : "server-environment",
    userAuthorizedDestination,
    // Local mode means the machine's own engine, where loopback is the point.
    // Any other request-named destination may resolve to public addresses only,
    // unless the request also carried the key that destination expects — naming
    // an internal host is not on its own a reason to reach into the network.
    allowNonPublicDestination: mode === "local" || userAuthorizedDestination,
  });
}

/**
 * The comfy.org key that authenticates **partner/API nodes inside a workflow**
 * (Gemini, Kling, …). Sent as `extra_data.api_key_comfy_org` alongside the
 * graph; without it those nodes fail with "Please login first to use this node"
 * even when the job itself is authorized.
 *
 * A separate channel on purpose. The engine key authenticates the engine; this
 * key pays for comfy.org services the graph reaches *from inside*, and in a
 * shared deployment the two belong to different people. Reusing one for the
 * other let an engine key authenticate a partner service, and let a partner key
 * ride to whatever engine a request named — so neither falls back to the other,
 * and the environment is never used for a destination the request chose.
 */
export function orgKeyFromRequest(request: Request, connection: ComfyConnection): string | null {
  const requestKey = request.headers.get(COMFY_HEADERS.orgKey)?.trim() || null;
  const envKey = process.env.COMFY_ORG_API_KEY?.trim() || null;
  const credential = requestKey ?? envKey;
  if (!credential) return null;

  const binding = bindCredentialToDestination({
    provider: "comfy",
    // It travels to the same endpoint as the engine key, but serves a different
    // service: the engine forwards it to comfy.org's API nodes.
    role: "partner-node",
    endpoint: connection.baseUrl,
    credential,
    credentialKind: "api-key",
    credentialSource: requestKey ? "browser-supplied" : "server-environment",
    // Only a request that named the destination itself authorized this key for
    // it; an environment-configured engine is authorized only where the product
    // registers one — Comfy Cloud.
    userAuthorizedDestination: Boolean(requestKey && request.headers.get(COMFY_HEADERS.baseUrl)),
    registeredOrigins: COMFY_ENGINE_RECIPIENTS,
    allowNonPublicDestination: true,
  });
  return binding.credential;
}

/* ── requests to the engine ────────────────────────────────────── */

/** The header a credential to this engine rides in. */
export function engineCredentialPlacement(connection: ComfyConnection): CredentialPlacement {
  // Comfy Cloud accepts either; a proxied v2 endpoint expects Bearer.
  return connection.useSdk
    ? { header: "Authorization", prefix: "Bearer " }
    : { header: "X-API-Key" };
}

/** The URL of a fetch argument, whatever shape it arrived in. */
function requestUrlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

export interface EngineRequestOptions {
  method?: string;
  /** Headers other than the credential, whose placement the binding decides. */
  headers?: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  /** Name used in a refusal message; the engine's own label when it has one. */
  label?: string;
}

/** A refusal from the policy seam, as an error a route can show the user. */
function engineRequestRefused(
  outcome: Extract<OutboundOutcome, { ok: false }>,
  label: string,
  carriedCredential: boolean
): ComfyEngineError {
  const detail = outcome.detail ? ` (${outcome.detail})` : "";
  switch (outcome.reason) {
    case "unapproved-redirect":
    case "invalid-redirect":
    case "too-many-redirects":
      // The message has to say the call was stopped, or a redirected request
      // reads as an engine fault and the key it carried looks incidental.
      return new ComfyEngineError(
        `${label} answered with a redirect to another host${detail}; the request was stopped.${
          carriedCredential ? " The API key was not forwarded to it." : ""
        }`,
        502
      );
    case "destination-not-authorized":
      return new ComfyEngineError(
        `${label} is not the destination this connection is bound to${detail}; the request was not sent.`,
        502
      );
    default:
      return new ComfyEngineError(`${label} request was blocked: ${outcome.reason}${detail}`, 502);
  }
}

/**
 * One request to this connection's engine.
 *
 * Every call goes through the outbound policy seam, credential or not: the
 * credential is attached only to the bound destination, every hop's resolved
 * address is classified when the connection does not allow non-public
 * destinations, and a redirect away from the bound origin fails the call
 * instead of being followed. Timeouts, retries and body buffering are unchanged
 * — {@link resilientFetch} still makes the actual request, under the seam's
 * `redirect: "manual"`.
 */
export async function engineRequest(
  connection: ComfyConnection,
  url: string,
  options: EngineRequestOptions = {}
): Promise<Response> {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = 30_000,
    retries = 0,
    signal,
    label = connection.mode === "cloud" ? "Comfy Cloud" : "ComfyUI",
  } = options;

  const outcome = await fetchWithConnectionPolicy({
    connection: providerConnectionFor(connection),
    url,
    method,
    headers,
    body,
    // May be null: a credential-free call is still checked, so a redirect
    // cannot walk it into the network either.
    credential: connection.apiKey,
    placement: engineCredentialPlacement(connection),
    signal,
    // The seam owns the redirect chain; each hop keeps the caller's timeout,
    // retry budget and body buffering, so status handling is unchanged.
    fetchImpl: (input, init) =>
      resilientFetch(requestUrlOf(input), {
        method: init?.method ?? "GET",
        headers: init?.headers,
        body: init?.body ?? undefined,
        redirect: "manual",
        timeoutMs,
        retries,
        signal,
      }),
  });
  if (!outcome.ok) throw engineRequestRefused(outcome, label, connection.apiKey !== null);
  return outcome.response;
}

/** What one output download may cost, matching the previous collect budget. */
const MEDIA_TIMEOUT_MS = 180_000;
const MEDIA_RETRIES = 3;

/**
 * A `fetch` for engine output downloads.
 *
 * Comfy Cloud answers `/api/view` with a 302 to a signed storage URL, so the
 * download must be able to leave the engine's origin — which is exactly what
 * the redirect-refusing policy seam cannot express. The credential is scoped
 * here instead: it is attached only to a hop the binding allows (for an engine
 * connection, its own origin), so the storage hop is followed *without* it.
 *
 * Invariant — do not "simplify" this away: no hop outside the bound recipient
 * ever receives the credential value. Setting the real header on the initial
 * request and letting `fetch` follow the redirect for us would forward
 * `X-API-Key` (which `fetch` does not strip across origins, unlike
 * `Authorization`) to whatever host the engine — or an attacker able to answer
 * for it — names.
 */
export function createMediaFetch(
  connection: ComfyConnection,
  options: { timeoutMs?: number; retries?: number } = {}
): typeof fetch {
  const { timeoutMs = MEDIA_TIMEOUT_MS, retries = MEDIA_RETRIES } = options;
  const credential = connection.apiKey;
  const binding = providerConnectionFor(connection);
  const placement = engineCredentialPlacement(connection);

  return (input, init) => {
    const url = requestUrlOf(input);
    const headers = new Headers(init?.headers);
    if (credential && credentialAllowedFor(binding, url)) {
      headers.set(placement.header, `${placement.prefix ?? ""}${credential}`);
    }
    return resilientFetch(url, {
      method: init?.method ?? "GET",
      headers,
      // The media seam drives the chain one hop at a time; `fetch` must not
      // follow it, or the scoping above would be pointless.
      redirect: "manual",
      timeoutMs,
      retries,
      signal: init?.signal ?? undefined,
    });
  };
}

/**
 * Whether the Comfy SDK transport may be used for this connection.
 *
 * The SDK owns its own HTTP stack, so nothing in it can be redirected or
 * address-classified by this boundary. It is therefore limited to the one
 * destination the product registered — Comfy Cloud over HTTPS. Every other
 * destination (a local box, a LAN host, or an endpoint a request named) is
 * served by the legacy engine, which goes through the outbound policy seam with
 * manual redirects and per-hop address checks.
 */
export function sdkTransportAllowed(connection: ComfyConnection): boolean {
  let url: URL;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return COMFY_ENGINE_RECIPIENTS.includes(url.origin);
}

/**
 * Refuse an SDK transport this connection does not authorize.
 *
 * `createEngine` never builds one, and this states the same rule where the SDK
 * is actually created, so a caller holding the class directly cannot point it
 * at a destination the product would not have chosen.
 */
export function assertSdkTransportAllowed(connection: ComfyConnection): void {
  if (sdkTransportAllowed(connection)) return;
  throw new ComfyEngineError(
    "The Comfy API v2 transport is only used with Comfy Cloud over HTTPS; other engines go through the policy-controlled engine.",
    400
  );
}
