/**
 * Outbound request policy seam (CRB-09 / Issue #10).
 *
 * One function turns "a Provider connection plus a target URL" into either an
 * allowed request or a refusal. It is the only place that decides whether a
 * credential rides, and the only place that follows a redirect on a
 * credential-bearing call.
 *
 * Rules:
 * - the first hop must match the connection's recipient;
 * - a redirect is followed only when the hop stays inside the connection's
 *   redirect origins. A credential-bearing call never follows a redirect to an
 *   unapproved host — it fails instead of forwarding the credential;
 * - when the connection is not allowed to reach non-public addresses, every
 *   hop's resolved addresses are classified first;
 * - the caller supplies the credential value; the seam decides whether it is
 *   allowed to be sent, and reports the refusal rather than sending it.
 */

import {
  credentialAllowedFor,
  redirectAllowedFor,
  type ProviderConnection,
} from "./providerConnection";
import {
  activeAddressResolver,
  checkNetworkTarget,
  LOCAL_ENGINE_ADDRESS_CLASSES,
  type AddressResolver,
} from "./networkTargets.server";

export type OutboundFailureReason =
  | "invalid-url"
  | "blocked-protocol"
  | "blocked-address"
  | "resolution-failed"
  | "destination-not-authorized"
  | "unapproved-redirect"
  | "too-many-redirects"
  | "invalid-redirect";

export interface OutboundSuccess {
  ok: true;
  response: Response;
  finalUrl: string;
  redirects: number;
  /** True when the credential was actually attached to the request that was sent. */
  credentialAttached: boolean;
}

export type OutboundOutcome =
  | OutboundSuccess
  | { ok: false; reason: OutboundFailureReason; detail?: string };

export interface CredentialPlacement {
  /** Header name the credential belongs in. */
  header: string;
  /** Prefix before the value, e.g. `"Bearer "` or `"Key "`. */
  prefix?: string;
  /** Query parameter name instead of a header (Provider file downloads). */
  queryParam?: string;
}

export interface OutboundRequestInput {
  connection: ProviderConnection;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** Credential value already bound to this connection, or null. */
  credential?: string | null;
  placement?: CredentialPlacement;
  signal?: AbortSignal;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  resolve?: AddressResolver;
}

const DEFAULT_MAX_REDIRECTS = 3;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Send one Provider request under the connection's policy.
 *
 * The response is returned with `redirect: "manual"` already handled: callers
 * see the final response, never an intermediate 3xx.
 */
export async function fetchWithConnectionPolicy(
  input: OutboundRequestInput,
): Promise<OutboundOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const { connection } = input;

  const connectionCredentialAllowed =
    input.credential !== null && input.credential !== undefined && credentialAllowedFor(connection, input.url);

  let target = input.url;
  let credentialAttached = connectionCredentialAllowed;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let origin: string;
    try {
      origin = new URL(target).origin;
    } catch {
      return { ok: false, reason: "invalid-url", detail: target };
    }

    if (hop === 0) {
      if (origin !== connection.recipientOrigin) {
        return { ok: false, reason: "destination-not-authorized", detail: origin };
      }
    } else if (!redirectAllowedFor(connection, target)) {
      return { ok: false, reason: "unapproved-redirect", detail: origin };
    }

    if (!connection.allowNonPublicDestination) {
      const check = await checkNetworkTarget(target, {
        resolve: input.resolve ?? activeAddressResolver(),
      });
      if (!check.ok) {
        return {
          ok: false,
          reason: check.reason === "blocked-address" ? "blocked-address" : check.reason ?? "blocked-address",
          detail: check.blocked ? `${check.blocked.address} (${check.blocked.kind})` : target,
        };
      }
    } else {
      // A user-declared local/LAN engine may reach the user's own machines —
      // loopback, RFC1918/ULA and CGNAT — and nothing else. Classification
      // still runs, so pointing the engine at a metadata or link-local address
      // is refused rather than causing a server-side request to it.
      // Plaintext is only reachable for a user-declared local/LAN engine: a
      // Provider call must never carry a key over an unencrypted hop, even when
      // the caller's own destination is unencrypted.
      const check = await checkNetworkTarget(target, {
        resolve: input.resolve ?? activeAddressResolver(),
        allowHttp: new URL(target).protocol === "http:",
        allowedNonPublicClasses: LOCAL_ENGINE_ADDRESS_CLASSES,
      });
      if (!check.ok) {
        return {
          ok: false,
          reason: check.reason === "blocked-address" ? "blocked-address" : check.reason ?? "blocked-address",
          detail: check.blocked ? `${check.blocked.address} (${check.blocked.kind})` : target,
        };
      }
    }

    const headers = new Headers(input.headers ?? {});
    let requestUrl = target;
    if (credentialAttached && input.credential && input.placement) {
      if (input.placement.queryParam) {
        const withCredential = new URL(target);
        withCredential.searchParams.set(input.placement.queryParam, input.credential);
        requestUrl = withCredential.toString();
      } else {
        headers.set(
          input.placement.header,
          `${input.placement.prefix ?? ""}${input.credential}`,
        );
      }
    }

    const response = await fetchImpl(requestUrl, {
      method: input.method ?? "GET",
      headers,
      body: hop === 0 ? (input.body ?? undefined) : undefined,
      redirect: "manual",
      signal: input.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { ok: false, reason: "invalid-redirect", detail: `HTTP ${response.status}` };
      }
      const next = new URL(location, target).toString();
      if (input.credential && !credentialAttached) {
        // A run that never carried a credential may still follow its hop,
        // provided the hop itself is validated on the next iteration.
        target = next;
        continue;
      }
      if (!redirectAllowedFor(connection, next)) {
        return { ok: false, reason: "unapproved-redirect", detail: new URL(next).origin };
      }
      target = next;
      continue;
    }

    return { ok: true, response, finalUrl: target, redirects: hop, credentialAttached };
  }

  return { ok: false, reason: "too-many-redirects", detail: `${maxRedirects} hops` };
}

/** Convenience predicate used by adapters that build their own request. */
export function connectionCoversUrl(connection: ProviderConnection, url: string): boolean {
  return credentialAllowedFor(connection, url) || sameOrigin(url, connection.endpoint);
}
