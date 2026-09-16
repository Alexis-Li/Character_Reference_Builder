/**
 * Provider connection records (CRB-09 / Issue #10).
 *
 * A credential is only meaningful together with the recipient it was issued
 * for. This module makes that explicit: a connection record names the Provider,
 * the account, the recipient origin, the protocol, the credential reference,
 * granted scopes, expiry and revocation state, and one function decides whether
 * a credential may ride to a destination.
 *
 * Two rules that used to be implicit and are now enforced:
 * - a destination override (a request-supplied base URL, a Provider-supplied
 *   poll or output URL) never inherits a server environment credential;
 * - engine credentials and partner-node credentials are separate connections,
 *   so an engine key cannot silently authenticate a different service.
 */

/** Which capability a connection serves. Engine and partner-node roles are distinct on purpose. */
export type ProviderRole = "image" | "llm" | "engine" | "partner-node" | "catalog" | "output";

export type CredentialKind = "api-key" | "oauth" | "subscription" | "none";

/** Where the credential came from — decides which destinations may receive it. */
export type CredentialSource =
  | "browser-supplied"
  | "server-environment"
  | "protected-store"
  | "none";

export interface ProviderConnection {
  connectionId: string;
  provider: string;
  role: ProviderRole;
  /** Origin the credential may be sent to. Never empty for a credentialed connection. */
  recipientOrigin: string;
  /** Exact endpoint the connection was created for. */
  endpoint: string;
  credentialKind: CredentialKind;
  credentialSource: CredentialSource;
  /** True when the user explicitly authorized this destination in settings. */
  userAuthorizedDestination: boolean;
  /** Granted scopes; empty for API-key channels. */
  scopes: readonly string[];
  expiresAt: number | null;
  revoked: boolean;
  /**
   * Origins a credential-bearing request may be redirected to. Same-origin
   * only by default: a valid Provider URL must not forward a credential to
   * another host.
   */
  redirectOrigins: readonly string[];
  /**
   * Whether the destination may resolve to a loopback/private address. Only a
   * user-configured local ComfyUI engine sets this.
   */
  allowNonPublicDestination: boolean;
}

/** Withheld means: a credential existed, and policy kept it off this request. */
export type CredentialWithheldReason = "recipient-not-authorized" | "source-not-authorized-for-destination";

export interface DestinationBinding {
  connection: ProviderConnection;
  /** Credential that may be sent, or null when none may. */
  credential: string | null;
  withheld: CredentialWithheldReason | null;
}

export interface DestinationBindingInput {
  provider: string;
  role: ProviderRole;
  endpoint: string;
  credential: string | null;
  credentialKind: CredentialKind;
  credentialSource: CredentialSource;
  /** Registered recipients for this provider+role; defaults to the built-in registry. */
  registeredOrigins?: readonly string[];
  /** The user authorized this exact destination (custom base URL, LAN engine). */
  userAuthorizedDestination?: boolean;
  scopes?: readonly string[];
  expiresAt?: number | null;
  revoked?: boolean;
  allowNonPublicDestination?: boolean;
}

/**
 * Recipient origins the product registers for each Provider. A destination
 * outside this list is only usable when the user authorized it explicitly, and
 * then never with a server environment credential.
 */
export const PROVIDER_RECIPIENTS: Readonly<Record<string, Partial<Record<ProviderRole, readonly string[]>>>> = {
  openai: {
    image: ["https://api.openai.com"],
    llm: ["https://api.openai.com"],
    catalog: ["https://api.openai.com"],
  },
  gemini: {
    image: ["https://generativelanguage.googleapis.com"],
    llm: ["https://generativelanguage.googleapis.com"],
  },
  replicate: {
    image: ["https://api.replicate.com"],
    catalog: ["https://api.replicate.com"],
  },
  fal: {
    image: [
      "https://queue.fal.run",
      "https://rest.alpha.fal.ai",
      "https://api.fal.ai",
    ],
    catalog: ["https://api.fal.ai"],
  },
  kie: {
    image: ["https://api.kie.ai", "https://kieai.redpandaai.co"],
  },
  wavespeed: {
    image: ["https://api.wavespeed.ai"],
    catalog: ["https://api.wavespeed.ai"],
  },
  anthropic: {
    llm: ["https://api.anthropic.com"],
  },
  comfy: {
    engine: ["https://cloud.comfy.org"],
  },
  "openai-oauth-experimental": {
    image: ["https://chatgpt.com"],
  },
};

function registeredOriginsFor(provider: string, role: ProviderRole): readonly string[] {
  return PROVIDER_RECIPIENTS[provider]?.[role] ?? [];
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Bind a credential to the destination this call will actually use.
 *
 * Returns the connection record plus the credential that may be attached, or
 * `withheld` naming why nothing may be sent. Callers must send exactly the
 * returned credential — never the input.
 */
export function bindCredentialToDestination(input: DestinationBindingInput): DestinationBinding {
  const recipientOrigin = originOf(input.endpoint) ?? "";
  const registered = input.registeredOrigins ?? registeredOriginsFor(input.provider, input.role);
  const registeredMatch = recipientOrigin.length > 0 && registered.includes(recipientOrigin);
  const recipientAuthorized = registeredMatch || input.userAuthorizedDestination === true;

  const connection: ProviderConnection = {
    connectionId: `${input.provider}:${input.role}:${recipientOrigin || "unresolved"}`,
    provider: input.provider,
    role: input.role,
    recipientOrigin,
    endpoint: input.endpoint,
    credentialKind: input.credentialKind,
    credentialSource: input.credentialSource,
    userAuthorizedDestination: input.userAuthorizedDestination === true,
    scopes: input.scopes ?? [],
    expiresAt: input.expiresAt ?? null,
    revoked: input.revoked === true,
    redirectOrigins: recipientOrigin.length > 0 ? [recipientOrigin] : [],
    allowNonPublicDestination: input.allowNonPublicDestination === true,
  };

  const hasCredential = input.credentialKind !== "none" && Boolean(input.credential);
  if (!hasCredential) {
    return { connection, credential: null, withheld: null };
  }
  if (connection.revoked) {
    return { connection, credential: null, withheld: "recipient-not-authorized" };
  }
  if (!recipientAuthorized) {
    return { connection, credential: null, withheld: "recipient-not-authorized" };
  }
  // A server environment credential belongs to the registered recipient only.
  // Once a caller can name the destination, the environment credential stops
  // being eligible: that is the difference between a configured Provider and an
  // arbitrary endpoint.
  if (input.credentialSource === "server-environment" && !registeredMatch) {
    return { connection, credential: null, withheld: "source-not-authorized-for-destination" };
  }
  return { connection, credential: input.credential, withheld: null };
}

/** True when a credential may be attached to this URL under this connection. */
export function credentialAllowedFor(connection: ProviderConnection, targetUrl: string): boolean {
  if (connection.credentialKind === "none" || connection.revoked) return false;
  const origin = originOf(targetUrl);
  if (origin === null) return false;
  if (origin === connection.recipientOrigin) return true;
  return connection.redirectOrigins.includes(origin);
}

/** True when a credential-free request may follow this redirect hop. */
export function redirectAllowedFor(connection: ProviderConnection, targetUrl: string): boolean {
  return credentialAllowedFor(connection, targetUrl);
}

/**
 * A credential-free connection for calls that intentionally carry nothing
 * (public catalog reads, unauthenticated Provider calls).
 */
export function anonymousConnection(provider: string, role: ProviderRole, endpoint: string): ProviderConnection {
  return bindCredentialToDestination({
    provider,
    role,
    endpoint,
    credential: null,
    credentialKind: "none",
    credentialSource: "none",
  }).connection;
}
