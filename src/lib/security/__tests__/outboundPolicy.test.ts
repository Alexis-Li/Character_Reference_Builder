/**
 * Outbound request policy acceptance suite (CRB-09 / Issue #10).
 *
 * Drives the single seam that decides whether a Provider request may be sent,
 * whether the credential rides with it and how far a redirect may carry it.
 * Every case injects `fetchImpl` and `resolve`, so no packet leaves the process
 * and no name is really resolved.
 */

import { describe, it, expect } from "vitest";
import {
  anonymousConnection,
  bindCredentialToDestination,
  type DestinationBindingInput,
  type ProviderConnection,
} from "../providerConnection";
import { fetchWithConnectionPolicy } from "../outboundPolicy.server";
import type { AddressResolver } from "../networkTargets.server";

const SYNTHETIC_KEY = "sk-synthetic-not-a-real-key";
const PUBLIC_ADDRESS = "203.0.113.10";
const PRIVATE_ADDRESS = "10.13.37.9";
const OPENAI_ORIGIN = "https://api.openai.com";
const OPENAI_ENDPOINT = `${OPENAI_ORIGIN}/v1/chat/completions`;
const ATTACKER_ORIGIN = "https://attacker.example";
const ATTACKER_ENDPOINT = `${ATTACKER_ORIGIN}/v1/chat/completions`;
const CDN_ORIGIN = "https://cdn.openai.example";
const INTERNAL_ORIGIN = "https://internal.example";

const publicResolver: AddressResolver = async () => [PUBLIC_ADDRESS];
const AUTHORIZATION = { header: "Authorization", prefix: "Bearer " };

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function recordingFetch(handler: (call: RecordedCall) => Response) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

function okResponse(): Response {
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

function redirectResponse(location: string | null, status = 302): Response {
  return new Response(null, { status, headers: location === null ? {} : { location } });
}

function headerOf(call: RecordedCall, name: string): string | null {
  return new Headers(call.init.headers as HeadersInit | undefined).get(name);
}

function openaiConnection(overrides: Partial<DestinationBindingInput> = {}): ProviderConnection {
  return bindCredentialToDestination({
    provider: "openai",
    role: "llm",
    endpoint: OPENAI_ENDPOINT,
    credential: SYNTHETIC_KEY,
    credentialKind: "api-key",
    credentialSource: "browser-supplied",
    ...overrides,
  }).connection;
}

function localEngineConnection(overrides: Partial<DestinationBindingInput> = {}): ProviderConnection {
  return bindCredentialToDestination({
    provider: "comfy",
    role: "engine",
    endpoint: "http://127.0.0.1:8188/prompt",
    credential: SYNTHETIC_KEY,
    credentialKind: "api-key",
    credentialSource: "browser-supplied",
    userAuthorizedDestination: true,
    allowNonPublicDestination: true,
    ...overrides,
  }).connection;
}

function withRedirectOrigins(connection: ProviderConnection, ...origins: string[]): ProviderConnection {
  return { ...connection, redirectOrigins: [connection.recipientOrigin, ...origins] };
}

describe("outbound request policy", () => {
  it("sends the first hop and attaches the credential in the configured header", async () => {
    const { impl, calls } = recordingFetch(() => okResponse());

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url: OPENAI_ENDPOINT,
      method: "POST",
      body: "{}",
      credential: SYNTHETIC_KEY,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({
      ok: true,
      credentialAttached: true,
      redirects: 0,
      finalUrl: OPENAI_ENDPOINT,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OPENAI_ENDPOINT);
    expect(headerOf(calls[0], "authorization")).toBe(`Bearer ${SYNTHETIC_KEY}`);
    if (result.ok) expect(result.response.status).toBe(200);
  });

  it("refuses a first hop outside the connection's recipient without fetching", async () => {
    const { impl, calls } = recordingFetch(() => okResponse());

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url: ATTACKER_ENDPOINT,
      credential: SYNTHETIC_KEY,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "destination-not-authorized",
      detail: ATTACKER_ORIGIN,
    });
    expect(calls).toHaveLength(0);
  });

  it("follows a same-origin redirect and keeps the credential on the final request", async () => {
    const target = `${OPENAI_ORIGIN}/v1/chat/completions/stream`;
    const { impl, calls } = recordingFetch((call) =>
      call.url === OPENAI_ENDPOINT ? redirectResponse(target) : okResponse(),
    );

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url: OPENAI_ENDPOINT,
      method: "POST",
      body: "{}",
      credential: SYNTHETIC_KEY,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({
      ok: true,
      credentialAttached: true,
      redirects: 1,
      finalUrl: target,
    });
    expect(calls.map((call) => call.url)).toEqual([OPENAI_ENDPOINT, target]);
    expect(headerOf(calls[1], "authorization")).toBe(`Bearer ${SYNTHETIC_KEY}`);
    // The payload belongs to the first hop only; it is not replayed to the redirect target.
    expect(calls[0].init.body).toBe("{}");
    expect(calls[1].init.body).toBeUndefined();
  });

  it("refuses a cross-origin redirect on a credential-bearing call and never sends the credential there", async () => {
    const { impl, calls } = recordingFetch(() => redirectResponse(`${ATTACKER_ENDPOINT}?leak=1`));

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url: OPENAI_ENDPOINT,
      credential: SYNTHETIC_KEY,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "unapproved-redirect",
      detail: ATTACKER_ORIGIN,
    });
    expect(calls).toHaveLength(1);
    for (const call of calls) expect(new URL(call.url).hostname).not.toBe("attacker.example");

    const credentialed = calls.filter((call) =>
      (headerOf(call, "authorization") ?? "").includes(SYNTHETIC_KEY),
    );
    expect(credentialed).toHaveLength(1);
    expect(new URL(credentialed[0].url).origin).toBe(OPENAI_ORIGIN);
  });

  it("follows an allow-listed public redirect hop on a credential-free run", async () => {
    const asset = `${CDN_ORIGIN}/asset.png`;
    const { impl, calls } = recordingFetch((call) =>
      call.url === OPENAI_ENDPOINT ? redirectResponse(asset) : okResponse(),
    );

    const result = await fetchWithConnectionPolicy({
      connection: withRedirectOrigins(openaiConnection(), CDN_ORIGIN),
      url: OPENAI_ENDPOINT,
      credential: null,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({
      ok: true,
      credentialAttached: false,
      redirects: 1,
      finalUrl: asset,
    });
    expect(calls.map((call) => call.url)).toEqual([OPENAI_ENDPOINT, asset]);
    expect(headerOf(calls[0], "authorization")).toBeNull();
    expect(headerOf(calls[1], "authorization")).toBeNull();
  });

  it("refuses a redirect hop outside the connection's origins on a credential-free run", async () => {
    const { impl, calls } = recordingFetch(() => redirectResponse(`${CDN_ORIGIN}/asset.png`));

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url: OPENAI_ENDPOINT,
      credential: null,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "unapproved-redirect",
      detail: CDN_ORIGIN,
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect hop that resolves to a private address and never fetches it", async () => {
    const resolver: AddressResolver = async (hostname) =>
      hostname === "internal.example" ? [PRIVATE_ADDRESS] : [PUBLIC_ADDRESS];
    const { impl, calls } = recordingFetch(() => redirectResponse(`${INTERNAL_ORIGIN}/media/out.png`));

    const result = await fetchWithConnectionPolicy({
      connection: withRedirectOrigins(openaiConnection(), INTERNAL_ORIGIN),
      url: OPENAI_ENDPOINT,
      credential: SYNTHETIC_KEY,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: resolver,
    });

    expect(result).toMatchObject({ ok: false, reason: "blocked-address" });
    if (!result.ok) expect(result.detail).toContain(PRIVATE_ADDRESS);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).hostname).toBe("api.openai.com");
  });

  it("re-checks every hop, so a name that starts resolving privately is refused", async () => {
    let lookups = 0;
    const resolver: AddressResolver = async () => {
      lookups += 1;
      return lookups === 1 ? [PUBLIC_ADDRESS] : [PRIVATE_ADDRESS];
    };
    const { impl, calls } = recordingFetch(() =>
      redirectResponse(`${OPENAI_ORIGIN}/v1/chat/completions/retry`),
    );

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url: OPENAI_ENDPOINT,
      credential: SYNTHETIC_KEY,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: resolver,
    });

    expect(result).toMatchObject({ ok: false, reason: "blocked-address" });
    expect(calls).toHaveLength(1);
  });

  it("allows a user-configured local engine that declares a non-public destination", async () => {
    const { impl, calls } = recordingFetch(() => okResponse());

    const result = await fetchWithConnectionPolicy({
      connection: localEngineConnection(),
      url: "http://127.0.0.1:8188/prompt",
      credential: SYNTHETIC_KEY,
      placement: { header: "X-API-Key" },
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({
      ok: true,
      credentialAttached: true,
      finalUrl: "http://127.0.0.1:8188/prompt",
    });
    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0], "x-api-key")).toBe(SYNTHETIC_KEY);
  });

  it("refuses a loopback destination when the connection does not declare it", async () => {
    const { impl, calls } = recordingFetch(() => okResponse());
    const endpoint = "https://127.0.0.1:8188/prompt";

    const result = await fetchWithConnectionPolicy({
      connection: localEngineConnection({ endpoint, allowNonPublicDestination: false }),
      url: endpoint,
      credential: SYNTHETIC_KEY,
      placement: { header: "X-API-Key" },
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({ ok: false, reason: "blocked-address" });
    if (!result.ok) expect(result.detail).toContain("loopback");
    expect(calls).toHaveLength(0);
  });

  it("refuses a plaintext Provider hop before any connection is made", async () => {
    const { impl, calls } = recordingFetch(() => okResponse());
    const plaintext = "http://api.openai.com/v1/models";

    const result = await fetchWithConnectionPolicy({
      connection: anonymousConnection("openai", "catalog", plaintext),
      url: plaintext,
      credential: null,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({ ok: false, reason: "blocked-protocol" });
    expect(calls).toHaveLength(0);
  });

  it("places the credential in the query parameter when that is the configured form", async () => {
    const url = `${OPENAI_ORIGIN}/v1/files/file-synthetic-1/content?alt=media`;
    const { impl, calls } = recordingFetch(() => okResponse());

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url,
      credential: SYNTHETIC_KEY,
      placement: { header: "Authorization", queryParam: "key" },
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({ ok: true, credentialAttached: true, finalUrl: url });
    expect(calls).toHaveLength(1);
    const sent = new URL(calls[0].url);
    expect(sent.searchParams.get("key")).toBe(SYNTHETIC_KEY);
    expect(sent.searchParams.get("alt")).toBe("media");
    expect(headerOf(calls[0], "authorization")).toBeNull();
  });

  it("never builds the query credential form for a recipient that does not match", async () => {
    const { impl, calls } = recordingFetch(() => okResponse());

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url: ATTACKER_ENDPOINT,
      credential: SYNTHETIC_KEY,
      placement: { header: "Authorization", queryParam: "key" },
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({ ok: false, reason: "destination-not-authorized" });
    expect(calls).toHaveLength(0);
  });

  it("attaches nothing for a revoked connection, even when the caller still holds the credential", async () => {
    const { impl, calls } = recordingFetch(() => okResponse());

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection({ revoked: true }),
      url: OPENAI_ENDPOINT,
      credential: SYNTHETIC_KEY,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({ ok: true, credentialAttached: false });
    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0], "authorization")).toBeNull();
  });

  it("sends nothing when the binding withheld a server environment credential from an override", async () => {
    const binding = bindCredentialToDestination({
      provider: "openai",
      role: "llm",
      endpoint: ATTACKER_ENDPOINT,
      credential: SYNTHETIC_KEY,
      credentialKind: "api-key",
      credentialSource: "server-environment",
      userAuthorizedDestination: true,
    });
    expect(binding.withheld).toBe("source-not-authorized-for-destination");
    const { impl, calls } = recordingFetch(() => okResponse());

    const result = await fetchWithConnectionPolicy({
      connection: binding.connection,
      url: ATTACKER_ENDPOINT,
      credential: binding.credential,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({ ok: true, credentialAttached: false });
    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0], "authorization")).toBeNull();
  });

  it("refuses a redirect chain that exhausts the redirect budget", async () => {
    const { impl, calls } = recordingFetch(() => redirectResponse(`${OPENAI_ORIGIN}/v1/again`));

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url: OPENAI_ENDPOINT,
      credential: SYNTHETIC_KEY,
      placement: AUTHORIZATION,
      maxRedirects: 0,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({ ok: false, reason: "too-many-redirects" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect response that carries no Location", async () => {
    const { impl, calls } = recordingFetch(() => redirectResponse(null));

    const result = await fetchWithConnectionPolicy({
      connection: openaiConnection(),
      url: OPENAI_ENDPOINT,
      credential: SYNTHETIC_KEY,
      placement: AUTHORIZATION,
      fetchImpl: impl,
      resolve: publicResolver,
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid-redirect", detail: "HTTP 302" });
    expect(calls).toHaveLength(1);
  });
});
