/**
 * Authenticated local-API request helpers for tests (CRB-09 / Issue #10).
 *
 * Route tests deliberately build minimal request doubles. The privileged
 * request guard still has to run for real, so these helpers supply only the
 * authenticated transport envelope — loopback Host, same-origin evidence, a
 * real local session capability and a one-time nonce — around whatever the test
 * wants the handler to see. Nothing about the guard is bypassed or stubbed.
 *
 * Two flavors:
 * - `localApiRequest(fake)` wraps a request double (an object that implements
 *   only `json()`/`text()`/`nextUrl`) so guard checks pass unchanged;
 * - `localApiNextRequest(url, init)` builds a real `NextRequest`, for tests
 *   that exercise headers, query strings or bodies end to end.
 */

import { NextRequest } from "next/server";
import { issueBrowserSession, resetLocalSessionsForTest } from "@/lib/security/localSession.server";
import { NONCE_HEADER, SESSION_COOKIE } from "@/lib/security/requestGuard.server";
import { localCliToken, resetCliTokenCacheForTest } from "@/lib/security/cliAuth.server";
import { registerProjectRoot, resetProjectRootsForTest } from "@/lib/security/projectRoots.server";

export const TEST_LOCAL_ORIGIN = "http://127.0.0.1:3210";

let capability: string | null = null;
let nonceCounter = 0;

/** The capability a test browser session is bound to, issued through the real store. */
export function testSessionCapability(): string {
  if (!capability) {
    capability = issueBrowserSession(TEST_LOCAL_ORIGIN).capability;
  }
  return capability;
}

/** Drop issued sessions so a test can exercise the missing/expired capability path. */
export function resetTestLocalSessions(): void {
  capability = null;
  nonceCounter = 0;
  resetLocalSessionsForTest();
  resetCliTokenCacheForTest();
  resetProjectRootsForTest();
}

/** A fresh, never-reused nonce; reusing one on purpose tests replay rejection. */
export function testRequestNonce(): string {
  nonceCounter += 1;
  return `test-nonce-${Date.now().toString(36)}-${nonceCounter}`;
}

export interface TestEnvelopeOptions {
  method?: string;
  url?: string;
  /** Extra headers, e.g. an explicit bad Origin or a spoofed Host. */
  headers?: Record<string, string>;
  /** Drop the session cookie to test the missing-capability path. */
  omitSession?: boolean;
  /** Reuse an explicit capability, so a test can present an expired/revoked one. */
  capability?: string | null;
  /** Present a CLI bearer credential instead of a browser session. */
  cli?: boolean;
  /** Content type to advertise; omitted means "no body type". */
  contentType?: string | undefined;
}

export function testEnvelopeHeaders(options: TestEnvelopeOptions = {}): Record<string, string> {
  const method = (options.method ?? "POST").toUpperCase();
  const headers: Record<string, string> = {
    host: "127.0.0.1:3210",
    origin: TEST_LOCAL_ORIGIN,
    "sec-fetch-site": "same-origin",
    [NONCE_HEADER]: testRequestNonce(),
    ...(options.headers ?? {}),
  };

  if (options.contentType !== undefined) {
    headers["content-type"] = options.contentType;
  } else if (method !== "GET" && method !== "HEAD" && !headers["content-type"]) {
    // A real privileged mutation declares JSON; a request double that only
    // implements `json()` is standing in for one.
    headers["content-type"] = "application/json";
  }

  if (options.cli) {
    headers.authorization = `Bearer ${localCliToken().token}`;
    delete headers.cookie;
    return headers;
  }

  const capabilityValue = options.capability === undefined ? testSessionCapability() : options.capability;
  if (!options.omitSession && capabilityValue) {
    headers.cookie = `${SESSION_COOKIE}=${capabilityValue}`;
  }
  return headers;
}

/**
 * Record a temporary directory as an authorized project root, so a route test
 * that writes into a real temp project exercises the write path instead of the
 * refusal path. Registration is what makes a directory writable in production
 * too (folder picker, project read, operator configuration).
 */
export function authorizeTestProjectRoot(directory: string): string | null {
  return registerProjectRoot(directory);
}

/**
 * Wrap a request double with a guarded, authenticated transport envelope.
 * All other properties the handler reads are forwarded to the double.
 */
export function localApiRequest<T extends object>(
  request: T,
  options: TestEnvelopeOptions = {},
): T {
  const envelope = testEnvelopeHeaders(options);
  const method = options.method ?? "POST";
  const url = options.url ?? `${TEST_LOCAL_ORIGIN}/api/test`;
  return new Proxy(request, {
    get(target, property, receiver) {
      if (property === "headers") {
        // The envelope carries the transport authentication; the double's own
        // headers (provider keys, deliberate bad values) win on conflict, so a
        // case that means to present a wrong Origin or a stale credential still
        // presents exactly that.
        const merged = new Headers(envelope);
        const own = Reflect.get(target, property) as
          | Headers
          | Record<string, string>
          | undefined;
        if (own instanceof Headers) {
          for (const [name, value] of own.entries()) merged.set(name, value);
        } else if (own) {
          for (const [name, value] of Object.entries(own)) merged.set(name, value);
        }
        return merged;
      }
      if (property === "method") {
        const own = Reflect.get(target, property) as string | undefined;
        return own ?? method;
      }
      if (property === "url") {
        const own = Reflect.get(target, property) as string | undefined;
        return own ?? url;
      }
      if (property === "nextUrl") {
        const own = Reflect.get(target, property) as unknown;
        return own ?? new URL((Reflect.get(target, "url") as string | undefined) ?? url);
      }
      return Reflect.get(target, property);
    },
    has(target, property) {
      if (property === "headers" || property === "method" || property === "url" || property === "nextUrl") {
        return true;
      }
      return Reflect.has(target, property);
    },
  }) as T;
}

type TestRequestInit = Omit<RequestInit, "signal"> & { signal?: AbortSignal };

/** A real `NextRequest` carrying an authenticated envelope. */
export function localApiNextRequest(
  url: string,
  init: TestRequestInit & TestEnvelopeOptions = {},
): NextRequest {
  const { method, headers, body, ...envelope } = init;
  return new NextRequest(url, {
    method: method ?? "GET",
    body,
    headers: testEnvelopeHeaders({ ...envelope, method: method ?? "GET", ...(headers ? { headers: headers as Record<string, string> } : {}) }),
  });
}

/** A real `NextRequest` carrying a CLI bearer credential instead of a session. */
export function cliApiNextRequest(url: string, init: TestRequestInit = {}): NextRequest {
  return new NextRequest(url, {
    ...init,
    headers: {
      host: "127.0.0.1:3210",
      authorization: `Bearer ${localCliToken().token}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}
