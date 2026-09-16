/**
 * Request-boundary acceptance suite (CRB-09 / Issue #10).
 *
 * Asserts the shared privileged-request guard as external behavior: what a
 * caller must present, and exactly which rejection each hostile shape produces.
 * Nothing here inspects private helper order — every case drives a wrapped
 * handler the way a route handler is driven.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  GUARD_MARKER,
  evaluateLocalApiRequest,
  guardedEffectsOf,
  withPrivilegedApi,
} from "../requestGuard.server";
import {
  BROWSER_SESSION_TTL_MS,
  issueBrowserSession,
  resetLocalSessionsForTest,
  revokeSessionByCapability,
} from "../localSession.server";
import { localCliToken, resetCliTokenCacheForTest } from "../cliAuth.server";

const ORIGIN = "http://127.0.0.1:3210";

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "POST",
    headers: {
      host: "127.0.0.1:3210",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

function browserHeaders(capability: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: ORIGIN,
    cookie: `crb_local_session=${capability}`,
    "x-crb-request-nonce": `nonce-${Math.random().toString(36).slice(2)}`,
    ...extra,
  };
}

describe("privileged request guard", () => {
  beforeEach(() => {
    resetLocalSessionsForTest();
    resetCliTokenCacheForTest();
  });

  it("accepts a same-origin browser request carrying this session's capability", () => {
    const session = issueBrowserSession(ORIGIN);
    const decision = evaluateLocalApiRequest(
      request("/api/generate", { headers: browserHeaders(session.capability) }),
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.session.requestClass).toBe("browser");
    expect(decision.session.sessionId).toBe(session.sessionId);
    expect(decision.session.origin).toBe(ORIGIN);
  });

  it("refuses a request whose Host is not this local instance", () => {
    const session = issueBrowserSession(ORIGIN);
    const decision = evaluateLocalApiRequest(
      request("/api/generate", {
        headers: browserHeaders(session.capability, { host: "attacker.example" }),
      }),
    );
    expect(decision).toMatchObject({ ok: false, reason: "unexpected-host", status: 403 });
  });

  it("refuses an unexpected Origin and an opaque null Origin", () => {
    const session = issueBrowserSession(ORIGIN);

    const foreign = evaluateLocalApiRequest(
      request("/api/generate", {
        headers: browserHeaders(session.capability, { origin: "http://evil.example" }),
      }),
    );
    expect(foreign).toMatchObject({ ok: false, reason: "unexpected-origin", status: 403 });

    const opaque = evaluateLocalApiRequest(
      request("/api/generate", {
        headers: browserHeaders(session.capability, { origin: "null" }),
      }),
    );
    expect(opaque).toMatchObject({ ok: false, reason: "null-origin", status: 403 });
  });

  it("refuses a state-changing request with no same-origin evidence, but allows a safe read", () => {
    const session = issueBrowserSession(ORIGIN);
    const headers = { cookie: `crb_local_session=${session.capability}` };

    const mutation = evaluateLocalApiRequest(request("/api/workflow", { headers }));
    expect(mutation).toMatchObject({ ok: false, reason: "missing-origin", status: 403 });

    const read = evaluateLocalApiRequest(
      request("/api/workflow", { method: "GET", headers }),
    );
    expect(read.ok).toBe(true);
  });

  it("refuses a cross-site fetch even when a capability cookie value is guessed", () => {
    const session = issueBrowserSession(ORIGIN);
    const decision = evaluateLocalApiRequest(
      request("/api/generate", {
        headers: browserHeaders(session.capability, {
          origin: "http://evil.example",
          "sec-fetch-site": "cross-site",
        }),
      }),
    );
    expect(decision.ok).toBe(false);
  });

  it("refuses a request with no capability, an unknown capability, an expired one and a revoked one", () => {
    const missing = evaluateLocalApiRequest(
      request("/api/generate", { headers: { origin: ORIGIN } }),
    );
    expect(missing).toMatchObject({ ok: false, reason: "missing-capability", status: 401 });

    const unknown = evaluateLocalApiRequest(
      request("/api/generate", {
        headers: browserHeaders("not-a-issued-capability"),
      }),
    );
    expect(unknown).toMatchObject({ ok: false, reason: "invalid-capability", status: 401 });

    // Issued one minute before the window closed: it is expired when presented.
    const expiredSession = issueBrowserSession("http://localhost:3210", null, {
      now: () => Date.now() - BROWSER_SESSION_TTL_MS - 1000,
    });
    const expired = evaluateLocalApiRequest(
      request("/api/generate", {
        headers: browserHeaders(expiredSession.capability, {
          origin: "http://localhost:3210",
          host: "localhost:3210",
        }),
      }),
    );
    expect(expired).toMatchObject({ ok: false, reason: "expired-capability", status: 401 });

    const revokedSession = issueBrowserSession(ORIGIN);
    revokeSessionByCapability(revokedSession.capability);
    const revoked = evaluateLocalApiRequest(
      request("/api/generate", { headers: browserHeaders(revokedSession.capability) }),
    );
    expect(revoked).toMatchObject({ ok: false, reason: "revoked-capability", status: 401 });
  });

  it("refuses a capability issued to a different origin of this instance", () => {
    // A capability minted for `localhost:3210` must be useless at `127.0.0.1:3210`.
    const localhostSession = issueBrowserSession("http://localhost:3210");
    const decision = evaluateLocalApiRequest(
      request("/api/generate", { headers: browserHeaders(localhostSession.capability) }),
    );
    expect(decision).toMatchObject({ ok: false, reason: "unexpected-origin", status: 403 });
  });

  it("refuses a non-JSON media type on a state-changing request", () => {
    const session = issueBrowserSession(ORIGIN);
    const decision = evaluateLocalApiRequest(
      request("/api/workflow", {
        headers: browserHeaders(session.capability, { "content-type": "text/plain" }),
        body: "prompt=hello",
      }),
    );
    expect(decision).toMatchObject({ ok: false, reason: "invalid-content-type", status: 415 });
  });

  it("refuses a replayed request nonce and requires one for state-changing calls", () => {
    const session = issueBrowserSession(ORIGIN);
    const nonce = "replay-me-0001";

    const first = evaluateLocalApiRequest(
      request("/api/workflow", {
        headers: browserHeaders(session.capability, { "x-crb-request-nonce": nonce }),
      }),
    );
    expect(first.ok).toBe(true);

    const replayed = evaluateLocalApiRequest(
      request("/api/workflow", {
        headers: browserHeaders(session.capability, { "x-crb-request-nonce": nonce }),
      }),
    );
    expect(replayed).toMatchObject({ ok: false, reason: "duplicate-request-nonce", status: 409 });

    const missing = evaluateLocalApiRequest(
      request("/api/workflow", {
        headers: browserHeaders(session.capability, { "x-crb-request-nonce": "" }),
      }),
    );
    expect(missing).toMatchObject({ ok: false, reason: "missing-request-nonce", status: 400 });

    const malformed = evaluateLocalApiRequest(
      request("/api/workflow", {
        headers: browserHeaders(session.capability, { "x-crb-request-nonce": "no" }),
      }),
    );
    expect(malformed).toMatchObject({ ok: false, reason: "invalid-request-nonce", status: 400 });
  });

  it("accepts a supported CLI credential as a separate caller class, without Origin", () => {
    const token = localCliToken().token;
    const decision = evaluateLocalApiRequest(
      request("/api/generate", { headers: { authorization: `Bearer ${token}` } }),
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.session.requestClass).toBe("cli");
    expect(decision.session.origin).toBeNull();

    const wrong = evaluateLocalApiRequest(
      request("/api/generate", { headers: { authorization: "Bearer not-the-instance-token" } }),
    );
    expect(wrong).toMatchObject({ ok: false, reason: "invalid-cli-credential", status: 401 });
  });

  it("runs before the handler: a refused request never reaches route code", async () => {
    const handler = vi.fn(async () => new Response("ok", { status: 200 }));
    const guarded = withPrivilegedApi(["cloud-request"], handler);

    const refused = await guarded(
      request("/api/generate", { headers: { origin: "http://evil.example" } }),
      {} as Record<string, never>,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ success: false, reason: "unexpected-origin" });
    expect(handler).not.toHaveBeenCalled();

    const session = issueBrowserSession(ORIGIN);
    const accepted = await guarded(
      request("/api/generate", { headers: browserHeaders(session.capability) }),
      {} as Record<string, never>,
    );
    expect(accepted.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("hands the accepted caller identity to the handler and marks the declared effects", async () => {
    const session = issueBrowserSession(ORIGIN);
    const seen: unknown[] = [];
    const guarded = withPrivilegedApi(
      ["cloud-request", "design-reference-upload"],
      async (_request, context) => {
        seen.push(context.session);
        return new Response("ok");
      },
    );

    await guarded(
      request("/api/generate", { headers: browserHeaders(session.capability) }),
      {} as Record<string, never>,
    );

    expect(seen[0]).toMatchObject({ sessionId: session.sessionId, requestClass: "browser" });
    expect(guardedEffectsOf(guarded)).toEqual(["cloud-request", "design-reference-upload"]);
    expect(guarded[GUARD_MARKER]).toBeDefined();
    expect(guardedEffectsOf(vi.fn())).toBeNull();
  });

  it("keeps browser-native subresource requests working while refusing a cross-site one", () => {
    const session = issueBrowserSession(ORIGIN);
    // An <img src> from the app page: no Origin header, same-origin fetch site.
    const subresource = evaluateLocalApiRequest(
      request("/api/workflow-images", {
        method: "GET",
        headers: {
          cookie: `crb_local_session=${session.capability}`,
          "sec-fetch-site": "same-origin",
          host: "127.0.0.1:3210",
        },
      }),
    );
    expect(subresource.ok).toBe(true);

    // The same request triggered from another site.
    const crossSite = evaluateLocalApiRequest(
      request("/api/workflow-images", {
        method: "GET",
        headers: {
          cookie: `crb_local_session=${session.capability}`,
          "sec-fetch-site": "cross-site",
          host: "127.0.0.1:3210",
        },
      }),
    );
    expect(crossSite).toMatchObject({ ok: false, reason: "unexpected-origin" });
  });
});
