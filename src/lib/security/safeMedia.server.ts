/**
 * Safe media download seam (CRB-09 / Issue #10).
 *
 * Every Provider output and every imported remote media item goes through this
 * one function. It:
 * - requires an authorized destination: either an origin registered by the
 *   Provider connection that produced the URL, or a destination the user
 *   explicitly authorized;
 * - validates every redirect hop (scheme, authorized origin, resolved address)
 *   before following it, so a Provider URL cannot forward the request to
 *   loopback, private, link-local or metadata services;
 * - refuses to buffer more than a byte budget;
 * - requires a media response type instead of renaming whatever came back as an
 *   image.
 *
 * DNS resolution happens before each connection. A resolver that answers
 * differently between resolution and connect (rebinding) is out of reach of a
 * `fetch`-based client; the mitigation and its residue are recorded in the
 * security gate result rather than claimed away.
 */

import {
  activeAddressResolver,
  checkNetworkTarget,
  type AddressPolicy,
  type AddressResolver,
} from "./networkTargets.server";

export type MediaDownloadFailure =
  | "invalid-url"
  | "blocked-protocol"
  | "blocked-address"
  | "destination-not-authorized"
  | "resolution-failed"
  | "too-many-redirects"
  | "upstream-error"
  | "oversized"
  | "unsupported-media-type";

export interface SafeMediaPolicy extends AddressPolicy {
  /**
   * Origins the caller is authorized to download from:
   * - an explicit list, when the destination is a registered Provider origin;
   * - `"provider-output"`, when the URL was returned by a registered Provider
   *   during this call or was supplied by the user as the media to keep. The
   *   destination class is still validated per hop (scheme, resolved address,
   *   size, media type); only the origin allowlist is widened.
   * An empty list authorizes nothing.
   */
  authorizedOrigins: readonly string[] | "provider-output";
  /** Accepted response media types, e.g. `["image/png", "image/jpeg"]`. */
  allowedMediaTypes: readonly string[];
  /**
   * Accept `application/octet-stream` when the URL path carries a recognized
   * media extension. Used for Provider CDNs that serve opaque binaries.
   */
  allowOctetStreamForMediaPaths?: boolean;
  extensionsForOpaqueMedia?: readonly string[];
  maxBytes: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  resolve?: AddressResolver;
  signal?: AbortSignal;
}

export interface SafeMediaResult {
  bytes: Uint8Array;
  mediaType: string;
  finalUrl: string;
  redirects: number;
}

export type SafeMediaOutcome =
  | ({ ok: true } & SafeMediaResult)
  | { ok: false; reason: MediaDownloadFailure; detail?: string; status?: number };

const DEFAULT_MAX_REDIRECTS = 5;

function mediaTypeOf(header: string | null): string {
  if (!header) return "";
  return header.split(";")[0].trim().toLowerCase();
}

function mediaTypeAllowed(mediaType: string, policy: SafeMediaPolicy, url: string): boolean {
  if (policy.allowedMediaTypes.includes(mediaType)) return true;
  if (mediaType === "application/octet-stream" && policy.allowOctetStreamForMediaPaths) {
    const extensions = policy.extensionsForOpaqueMedia ?? [];
    const path = new URL(url).pathname.toLowerCase();
    return extensions.some((extension) => path.endsWith(`.${extension}`));
  }
  return false;
}

/**
 * Read at most `maxBytes` from a response body, failing instead of truncating
 * when the upstream sends more.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | "oversized"> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) return "oversized";

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? "oversized" : buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "oversized";
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Download one authorized media URL with per-hop validation.
 *
 * The caller decides the authorization set; this function never widens it, and
 * a redirect that leaves the set fails the download instead of silently
 * following.
 */
export async function downloadSafeMedia(
  url: string,
  policy: SafeMediaPolicy,
): Promise<SafeMediaOutcome> {
  const fetchImpl = policy.fetchImpl ?? fetch;
  const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const addressPolicy: AddressPolicy = {
    allowLoopback: policy.allowLoopback,
    allowPrivate: policy.allowPrivate,
  };

  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let origin: string;
    try {
      origin = new URL(target).origin;
    } catch {
      return { ok: false, reason: "invalid-url", detail: target };
    }
    const originAuthorized =
      policy.authorizedOrigins === "provider-output" ||
      policy.authorizedOrigins.includes(origin);
    if (!originAuthorized) {
      return { ok: false, reason: "destination-not-authorized", detail: origin };
    }

    const targetCheck = await checkNetworkTarget(target, {
      ...addressPolicy,
      resolve: policy.resolve ?? activeAddressResolver(),
    });
    if (!targetCheck.ok) {
      return {
        ok: false,
        reason: targetCheck.reason === "blocked-address" ? "blocked-address" : targetCheck.reason ?? "blocked-address",
        detail: targetCheck.blocked
          ? `${targetCheck.blocked.address} (${targetCheck.blocked.kind})`
          : target,
      };
    }

    const response = await fetchImpl(target, {
      method: "GET",
      redirect: "manual",
      signal: policy.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { ok: false, reason: "upstream-error", detail: `HTTP ${response.status}`, status: response.status };
      }
      target = new URL(location, target).toString();
      continue;
    }

    if (!response.ok) {
      return { ok: false, reason: "upstream-error", status: response.status, detail: `HTTP ${response.status}` };
    }

    const mediaType = mediaTypeOf(response.headers.get("content-type"));
    if (!mediaType || !mediaTypeAllowed(mediaType, policy, target)) {
      return {
        ok: false,
        reason: "unsupported-media-type",
        detail: mediaType || "(missing content-type)",
      };
    }

    const bytes = await readBounded(response, policy.maxBytes);
    if (bytes === "oversized") {
      return { ok: false, reason: "oversized", detail: `limit ${policy.maxBytes} bytes` };
    }
    if (bytes.byteLength === 0) {
      return { ok: false, reason: "upstream-error", detail: "empty response body" };
    }

    return { ok: true, bytes, mediaType, finalUrl: target, redirects: hop };
  }

  return { ok: false, reason: "too-many-redirects", detail: `${maxRedirects} hops` };
}
