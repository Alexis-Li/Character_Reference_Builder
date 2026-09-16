/**
 * Local session bootstrap (CRB-09 / Issue #10).
 *
 * The application page calls this once before its first privileged request.
 * The response sets the HttpOnly, SameSite=Strict capability cookie and
 * returns only non-secret state: session identity, expiry and the account
 * summary. No provider credential, refresh token or reusable bearer is ever
 * part of this response.
 *
 * The endpoint is deliberately narrow: it is reachable without a session (that
 * is its purpose) but still requires a loopback Host and same-origin evidence,
 * so another page cannot mint a capability for this instance.
 */

import { NextResponse } from "next/server";
import { issueBrowserSession, BROWSER_SESSION_TTL_MS } from "@/lib/security/localSession.server";
import { SESSION_COOKIE, isAllowedLocalHost } from "@/lib/security/requestGuard.server";
import { oauthSession } from "@/lib/security/oauthSession.server";

export const dynamic = "force-dynamic";

function sameOriginEvidence(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (origin.trim().toLowerCase() === "null") return false;
    try {
      return new URL(origin).origin === expectedOrigin;
    } catch {
      return false;
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  return fetchSite === "same-origin" || fetchSite === "none";
}

export async function GET(request: Request) {
  if (!isAllowedLocalHost(request.headers.get("host"))) {
    return NextResponse.json(
      { success: false, error: "Request host is not this local instance", reason: "unexpected-host" },
      { status: 403 },
    );
  }

  let origin: string;
  try {
    // Same authority rule as the guard: the Host header the caller addressed.
    const protocol = new URL(request.url).protocol;
    origin = new URL(`${protocol}//${request.headers.get("host")}`).origin;
  } catch {
    return NextResponse.json(
      { success: false, error: "Request host is not this local instance", reason: "unexpected-host" },
      { status: 403 },
    );
  }

  if (!sameOriginEvidence(request, origin)) {
    return NextResponse.json(
      { success: false, error: "Request origin is not this local instance", reason: "unexpected-origin" },
      { status: 403 },
    );
  }

  const account = oauthSession().browserView();
  const issued = issueBrowserSession(origin, null);
  const response = NextResponse.json({
    success: true,
    sessionId: issued.sessionId,
    expiresAt: issued.expiresAt,
    ttlMs: BROWSER_SESSION_TTL_MS,
    origin: issued.origin,
    oauth: account,
  });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: issued.capability,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(BROWSER_SESSION_TTL_MS / 1000),
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
