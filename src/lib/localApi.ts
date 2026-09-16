/**
 * Browser-side local API seam (CRB-09 / Issue #10).
 *
 * Every privileged call from the page goes through here. The seam:
 * - bootstraps the local session capability once, before the first call, and
 *   re-bootstraps once when the server reports an expired or unknown
 *   capability (for example after a dev-server restart);
 * - attaches a fresh one-time request nonce to state-changing calls;
 * - normalizes JSON content type for string bodies, so a privileged request is
 *   never sent as `text/plain`.
 *
 * Requests that never touch the API (dev-server assets, images, external URLs)
 * are left untouched.
 */

export const SESSION_ENDPOINT = "/api/session";
export const NONCE_HEADER = "x-crb-request-nonce";
export const CAPABILITY_RETRY_HEADER = "x-crb-session-retry";

let bootstrap: Promise<void> | null = null;

function isLocalApiRequest(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (!url.startsWith("/api/") && !url.startsWith(`${window.location.origin}/api/`)) {
    return false;
  }
  return !url.startsWith(SESSION_ENDPOINT) && !url.endsWith(SESSION_ENDPOINT);
}

/** Issue (or refresh) the local session capability. Memoized per page load. */
export function ensureLocalSession(): Promise<void> {
  if (!bootstrap) {
    bootstrap = fetch(SESSION_ENDPOINT, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Local session bootstrap failed: ${response.status}`);
      })
      .catch((error: unknown) => {
        bootstrap = null;
        throw error;
      });
  }
  return bootstrap;
}

function requestNonce(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Headers a privileged browser request must carry, on top of caller headers. */
export function privilegedHeaders(init: RequestInit | undefined, method: string): Headers {
  const headers = new Headers(init?.headers ?? {});
  if (method !== "GET" && method !== "HEAD") {
    headers.set(NONCE_HEADER, requestNonce());
  }
  const body = init?.body;
  if (typeof body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function retryableSessionFailure(response: Response): boolean {
  return response.status === 401;
}

/**
 * A rejected duplicate nonce means this request's nonce was already used or the
 * session's nonce store is full. Both are fixed by sending the request again
 * with a fresh nonce — that is not a replay, it is the same intent submitted
 * once.
 */
async function retryableNonceFailure(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const payload = await response
    .clone()
    .json()
    .catch(() => null as { reason?: string } | null);
  return payload?.reason === "duplicate-request-nonce";
}

/**
 * Fetch a privileged local API endpoint with the session capability and nonce.
 * One retry is attempted when the capability is missing or expired.
 */
export async function localApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  await ensureLocalSession();
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = privilegedHeaders(init, method);
  const sameOrigin = { credentials: "same-origin" as const };

  const first = await fetch(input, { ...init, ...sameOrigin, headers });
  if (await retryableNonceFailure(first)) {
    const retryHeaders = privilegedHeaders(init, method);
    retryHeaders.set(CAPABILITY_RETRY_HEADER, "1");
    return fetch(input, { ...init, ...sameOrigin, headers: retryHeaders });
  }
  if (!retryableSessionFailure(first) || headers.has(CAPABILITY_RETRY_HEADER)) {
    return first;
  }
  const payload = await first
    .clone()
    .json()
    .catch(() => null as { reason?: string } | null);
  if (payload?.reason !== "missing-capability" && payload?.reason !== "expired-capability") {
    return first;
  }
  bootstrap = null;
  await ensureLocalSession();
  const retryHeaders = privilegedHeaders(init, method);
  retryHeaders.set(CAPABILITY_RETRY_HEADER, "1");
  return fetch(input, { ...init, ...sameOrigin, headers: retryHeaders });
}

/**
 * Route every same-origin `/api/*` call through the seam, including calls made
 * by libraries that hold their own `fetch` reference. Installed once by the
 * application shell; idempotent.
 */
export function installLocalApiFetch(): void {
  const globalWithFlag = globalThis as typeof globalThis & { __crbLocalApiInstalled?: boolean };
  if (globalWithFlag.__crbLocalApiInstalled) return;
  globalWithFlag.__crbLocalApiInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isLocalApiRequest(input)) {
      return nativeFetch(input, init);
    }
    try {
      await ensureLocalSession();
    } catch {
      return nativeFetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = privilegedHeaders(init, method);
    const response = await nativeFetch(input, {
      ...init,
      credentials: "same-origin",
      headers,
    });
    if (await retryableNonceFailure(response)) {
      const retryHeaders = privilegedHeaders(init, method);
      retryHeaders.set(CAPABILITY_RETRY_HEADER, "1");
      return await nativeFetch(input, { ...init, credentials: "same-origin", headers: retryHeaders });
    }
    if (retryableSessionFailure(response)) {
      const payload = await response
        .clone()
        .json()
        .catch(() => null as { reason?: string } | null);
      if (payload?.reason === "missing-capability" || payload?.reason === "expired-capability") {
        bootstrap = null;
        try {
          await ensureLocalSession();
          const retryHeaders = privilegedHeaders(init, method);
          retryHeaders.set(CAPABILITY_RETRY_HEADER, "1");
          return await nativeFetch(input, { ...init, credentials: "same-origin", headers: retryHeaders });
        } catch {
          return response;
        }
      }
    }
    return response;
  }) as typeof window.fetch;
}
