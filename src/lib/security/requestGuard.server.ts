/**
 * Privileged request guard (CRB-09 / Issue #10).
 *
 * One entry point in front of every API route that can spend cloud quota,
 * upload Design References, read or write local files, reach a configurable
 * backend, write logs or change authentication state. It runs before provider
 * credentials are resolved, before any filesystem mutation, before any
 * outbound call and before authentication state changes.
 *
 * Result contract: an accepted request identifies the caller
 * (`requestClass`, `sessionId`, bound `origin`, non-secret `account`) and the
 * privileged effects it is allowed to cause; a rejected request carries a
 * stable machine-readable `reason` that callers and tests assert on.
 *
 * Two caller classes, deliberately different:
 * - `browser`: an exact same-origin request carrying the HttpOnly,
 *   SameSite=Strict local session capability, an explicit JSON media type and
 *   a one-time request nonce for state-changing methods;
 * - `cli`: a bearer credential from the protected runtime token store. Origin
 *   evidence does not exist for a script, so it is not required; the token
 *   itself is the authentication.
 */

import { NextResponse, type NextRequest } from "next/server";
import { authorizeCliToken } from "./cliAuth.server";
import {
  authorizeBrowserCapability,
  claimRequestNonce,
  type AccountSummary,
} from "./localSession.server";

/** Cookie carrying the local session capability. HttpOnly, SameSite=Strict. */
export const SESSION_COOKIE = "crb_local_session";
/** One-time nonce header for state-changing privileged requests. */
export const NONCE_HEADER = "x-crb-request-nonce";
/** Marker property set on guarded handlers, asserted by the coverage test. */
export const GUARD_MARKER = Symbol.for("crb.privileged-request-guard");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * What a guarded route can cause. Declared per route, recorded for audits and
 * asserted by the guard-coverage test so no privileged entry is unclassified.
 */
export type PrivilegedEffect =
  | "cloud-request"
  | "design-reference-upload"
  | "remote-media-fetch"
  | "local-file-read"
  | "local-file-write"
  | "configurable-backend"
  | "log-write"
  | "auth-state-change";

export type RequestClass = "browser" | "cli";

export interface GuardedSession {
  sessionId: string;
  requestClass: RequestClass;
  /** Exact origin the capability is bound to; null for CLI callers. */
  origin: string | null;
  /** Non-secret account summary, when an account session is attached. */
  account: AccountSummary | null;
}

export type GuardRejectionReason =
  | "unexpected-host"
  | "unexpected-origin"
  | "null-origin"
  | "missing-origin"
  | "missing-capability"
  | "invalid-capability"
  | "expired-capability"
  | "revoked-capability"
  | "invalid-content-type"
  | "missing-request-nonce"
  | "invalid-request-nonce"
  | "duplicate-request-nonce"
  | "invalid-cli-credential";

export interface GuardRejection {
  ok: false;
  reason: GuardRejectionReason;
  status: number;
  message: string;
}

export type LocalApiRequestDecision = { ok: true; session: GuardedSession } | GuardRejection;

export interface GuardClock {
  now(): number;
}

const systemClock: GuardClock = { now: () => Date.now() };

const REJECTION_STATUS: Record<GuardRejectionReason, number> = {
  "unexpected-host": 403,
  "unexpected-origin": 403,
  "null-origin": 403,
  "missing-origin": 403,
  "missing-capability": 401,
  "invalid-capability": 401,
  "expired-capability": 401,
  "revoked-capability": 401,
  "invalid-content-type": 415,
  "missing-request-nonce": 400,
  "invalid-request-nonce": 400,
  "duplicate-request-nonce": 409,
  "invalid-cli-credential": 401,
};

const REJECTION_MESSAGE: Record<GuardRejectionReason, string> = {
  "unexpected-host": "Request host is not this local instance",
  "unexpected-origin": "Request origin is not this local session's origin",
  "null-origin": "Requests from an opaque origin are not accepted",
  "missing-origin": "State-changing local requests require same-origin evidence",
  "missing-capability": "Missing local session capability",
  "invalid-capability": "Unknown local session capability",
  "expired-capability": "Local session capability expired",
  "revoked-capability": "Local session capability was revoked",
  "invalid-content-type": "Privileged requests must use application/json",
  "missing-request-nonce": "State-changing local requests require a request nonce",
  "invalid-request-nonce": "Request nonce is malformed",
  "duplicate-request-nonce": "Request nonce was already used by this session",
  "invalid-cli-credential": "CLI credential is not valid for this instance",
};

function reject(reason: GuardRejectionReason): GuardRejection {
  return {
    ok: false,
    reason,
    status: REJECTION_STATUS[reason],
    message: REJECTION_MESSAGE[reason],
  };
}

/** Additional accepted host names beyond loopback, for non-default deployments. */
function configuredHosts(): string[] {
  const raw = process.env.CRB_ALLOWED_HOSTS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Host names this instance answers to. Loopback binding is not authorization,
 * so anything else (a LAN name, a rebound DNS name, a tunnel host) is refused
 * before credentials or files are touched.
 */
export function isAllowedLocalHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  if (host.length === 0) return false;

  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  const withoutBrackets = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(withoutBrackets)) return true;
  if (withoutBrackets === "::1" || withoutBrackets === "0:0:0:0:0:0:0:1") return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(withoutBrackets)) return true;

  return configuredHosts().includes(host);
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function sameLocalOrigin(candidate: string, expectedOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!isAllowedLocalHost(parsed.host)) return false;
  return parsed.origin === expectedOrigin;
}

function checkMediaType(headers: Headers, method: string): GuardRejection | null {
  if (!MUTATING_METHODS.has(method)) return null;
  const contentType = headers.get("content-type");
  if (contentType && contentType.toLowerCase().startsWith("application/json")) return null;

  // Provably bodyless requests (a browser sends `Content-Length: 0` for those)
  // are allowed without a media type; everything else must declare JSON. The
  // rule fails closed, so a chunked body cannot slip past by omitting headers.
  const contentLength = headers.get("content-length");
  const transferEncoding = headers.get("transfer-encoding");
  const provablyBodyless = contentLength === "0" && !transferEncoding;
  if (!contentType && provablyBodyless) return null;

  return reject("invalid-content-type");
}

function checkNonce(headers: Headers, method: string, sessionId: string, clock: GuardClock): GuardRejection | null {
  if (!MUTATING_METHODS.has(method)) return null;
  const nonce = headers.get(NONCE_HEADER);
  if (!nonce) return reject("missing-request-nonce");
  if (!NONCE_PATTERN.test(nonce)) return reject("invalid-request-nonce");
  if (!claimRequestNonce(sessionId, nonce, clock)) return reject("duplicate-request-nonce");
  return null;
}

/**
 * Decide whether a request may reach a privileged handler.
 *
 * Order is deliberate: host, then origin evidence, then caller credential,
 * then request shape. No credential lookup or file access happens before a
 * decision, and every rejection names one concrete failure.
 */
export function evaluateLocalApiRequest(
  request: Request,
  clock: GuardClock = systemClock,
): LocalApiRequestDecision {
  if (!request.headers) return reject("unexpected-host");
  const headers = request.headers;
  const method = (request.method || "GET").toUpperCase();

  if (!isAllowedLocalHost(headers.get("host"))) {
    return reject("unexpected-host");
  }

  let expectedOrigin: string;
  try {
    // The Host header is the authority the caller actually addressed, and it is
    // already checked above. `request.url` is not used: a server runtime may
    // normalize its host (Next rewrites it to `localhost`), which would compare
    // the capability's bound origin against the wrong authority.
    const protocol = new URL(request.url).protocol;
    expectedOrigin = new URL(`${protocol}//${headers.get("host")}`).origin;
  } catch {
    return reject("unexpected-host");
  }

  const mediaTypeRejection = checkMediaType(headers, method);
  if (mediaTypeRejection) return mediaTypeRejection;

  const authorization = headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (bearer) {
    if (!authorizeCliToken(bearer)) return reject("invalid-cli-credential");
    const session: GuardedSession = {
      sessionId: `cli:${bearer.slice(0, 8)}`,
      requestClass: "cli",
      origin: null,
      account: null,
    };
    return { ok: true, session };
  }

  const origin = headers.get("origin");
  const fetchSite = headers.get("sec-fetch-site")?.toLowerCase() ?? null;

  if (origin !== null) {
    if (origin.trim().toLowerCase() === "null") return reject("null-origin");
    if (!sameLocalOrigin(origin, expectedOrigin)) return reject("unexpected-origin");
  } else {
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
      return reject("unexpected-origin");
    }
    if (MUTATING_METHODS.has(method) && fetchSite !== "same-origin") {
      return reject("missing-origin");
    }
    if (
      SAFE_METHODS.has(method) &&
      fetchSite !== null &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none"
    ) {
      return reject("unexpected-origin");
    }
  }

  const capability = readCookie(headers.get("cookie"), SESSION_COOKIE);
  if (!capability) return reject("missing-capability");

  const check = authorizeBrowserCapability(capability, expectedOrigin, clock);
  if (!check.ok) {
    if (check.failure === "expired") return reject("expired-capability");
    if (check.failure === "revoked") return reject("revoked-capability");
    if (check.failure === "origin-mismatch") return reject("unexpected-origin");
    return reject("invalid-capability");
  }

  const session = check.session!;
  const nonceRejection = checkNonce(headers, method, session.sessionId, clock);
  if (nonceRejection) return nonceRejection;

  return {
    ok: true,
    session: {
      sessionId: session.sessionId,
      requestClass: "browser",
      origin: session.origin,
      account: session.account,
    },
  };
}

/** JSON body for a rejection. Never echoes a credential-shaped field back. */
export function guardRejectionResponse(rejection: GuardRejection): NextResponse {
  return NextResponse.json(
    { success: false, error: rejection.message, reason: rejection.reason },
    { status: rejection.status },
  );
}

export type GuardedContext<C> = C & { session: GuardedSession };

/**
 * Wrap a route handler so no code path in it can run before the guard accepts
 * the request. The wrapped handler exposes the accepted session identity to
 * the route and is marked so a coverage test can prove every privileged route
 * is guarded.
 */
export function withPrivilegedApi<
  C extends object = { params: Promise<Record<string, string | string[]>> },
>(
  effects: readonly PrivilegedEffect[],
  handler: (request: NextRequest, context: GuardedContext<C>) => Promise<Response> | Response,
): ((request: NextRequest, context: C) => Promise<Response>) & {
  [GUARD_MARKER]?: { effects: readonly PrivilegedEffect[] };
} {
  const wrapped = async (request: NextRequest, context?: C): Promise<Response> => {
    const decision = evaluateLocalApiRequest(request);
    if (!decision.ok) return guardRejectionResponse(decision);
    const merged = { ...(context ?? ({} as C)), session: decision.session } as GuardedContext<C>;
    return handler(request, merged);
  };
  return Object.assign(wrapped, { [GUARD_MARKER]: { effects } });
}

/** Declared effect set of a guarded handler, or null when it is not guarded. */
export function guardedEffectsOf(
  handler: unknown,
): readonly PrivilegedEffect[] | null {
  const marker = (handler as { [GUARD_MARKER]?: { effects: readonly PrivilegedEffect[] } } | undefined)?.[
    GUARD_MARKER
  ];
  return marker ? marker.effects : null;
}
