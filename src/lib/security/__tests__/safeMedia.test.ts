/**
 * Safe media download acceptance suite (CRB-09 / Issue #10).
 *
 * `downloadSafeMedia` is the one seam every Provider output and every imported
 * remote media item passes through, so this suite drives it the way a caller
 * does: a URL plus a policy, never an internal helper. No case performs DNS or
 * network I/O — each one injects a resolver or a `fetch` double.
 *
 * Every refusal asserts two things: the exact refusal reason, and that the
 * blocked destination was never contacted. A guard that refuses *after*
 * connecting would be worse than no guard, because the request (and any
 * credentials on it) has already left the process.
 */

import { describe, it, expect, vi } from "vitest";
import { checkNetworkTarget, classifyAddress, isDisallowedAddress } from "../networkTargets.server";
import {
  downloadSafeMedia,
  type MediaDownloadFailure,
  type SafeMediaOutcome,
  type SafeMediaPolicy,
} from "../safeMedia.server";

const PUBLIC_HOST = "media.example.test";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const PUBLIC_URL = `${PUBLIC_ORIGIN}/output/picture.png`;
/** Documentation address (TEST-NET-3): the answer injected resolvers give by default. */
const PUBLIC_IP = "203.0.113.10";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x7f, 0x40]);

type FetchLike = typeof fetch;

interface FetchDouble {
  impl: FetchLike;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
}

/** A `fetch` double that records every URL it is asked for. */
function fetchDouble(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchDouble {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  });
  return { impl: impl as unknown as FetchLike, calls };
}

/** Injected resolver: known hosts get their answers, anything else the public one. */
function resolver(answers: Record<string, string[] | Error>): (hostname: string) => Promise<string[]> {
  return async (hostname) => {
    const answer = answers[hostname] ?? [PUBLIC_IP];
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

function policy(overrides: Partial<SafeMediaPolicy> = {}): SafeMediaPolicy {
  return {
    authorizedOrigins: "provider-output",
    allowedMediaTypes: ["image/png", "image/jpeg"],
    maxBytes: 4096,
    ...overrides,
  };
}

/** Asserts the refusal reason and returns the failure for its detail. */
function expectRefusal(
  outcome: SafeMediaOutcome,
  reason: MediaDownloadFailure,
): { detail?: string; status?: number } {
  if (outcome.ok) throw new Error(`expected the download to be refused with "${reason}", but it succeeded`);
  expect(outcome.reason).toBe(reason);
  return outcome;
}

function streamOf(...chunkSizes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const size of chunkSizes) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

const BLOCKED_ADDRESSES: Array<[string, string]> = [
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback"],
  ["::1", "loopback"],
  ["[::1]", "loopback"],
  ["10.0.0.1", "private"],
  ["172.16.0.1", "private"],
  ["172.31.255.254", "private"],
  ["192.168.1.1", "private"],
  ["169.254.169.254", "metadata"],
  ["fc00::1", "unique-local"],
  ["fd12:3456:789a::1", "unique-local"],
  ["fe80::1", "link-local"],
  ["febf::1", "link-local"],
  ["100.64.0.1", "carrier-grade-nat"],
  ["100.127.255.254", "carrier-grade-nat"],
  ["::ffff:169.254.169.254", "metadata"],
  ["::ffff:10.0.0.1", "private"],
  ["::ffff:127.0.0.1", "loopback"],
  ["64:ff9b::a9fe:a9fe", "metadata"],
  ["2002:a9fe:a9fe::", "metadata"],
  ["224.0.0.1", "multicast"],
  ["ff02::1", "multicast"],
  ["0.0.0.0", "unspecified"],
  ["::", "unspecified"],
  ["240.0.0.1", "reserved"],
  ["198.18.0.1", "reserved"],
  ["2001:db8::1", "reserved"],
];

/** Addresses next to every blocked range that must stay reachable. */
const PUBLIC_ADDRESSES = [
  "203.0.113.10",
  "8.8.8.8",
  "93.184.216.34",
  "172.32.0.1",
  "100.128.0.1",
  "192.169.0.1",
  "2606:4700:4700::1111",
];

describe("classifyAddress", () => {
  it.each(BLOCKED_ADDRESSES)("classifies %s as %s", (address, kind) => {
    expect(classifyAddress(address)).toBe(kind);
  });

  it.each(PUBLIC_ADDRESSES)("classifies %s as public", (address) => {
    expect(classifyAddress(address)).toBe("public");
  });
});

describe("isDisallowedAddress", () => {
  it.each(BLOCKED_ADDRESSES)("refuses %s (%s) under the default policy", (address) => {
    expect(isDisallowedAddress(address)).toBe(true);
  });

  it.each(PUBLIC_ADDRESSES)("permits %s", (address) => {
    expect(isDisallowedAddress(address)).toBe(false);
  });

  it("permits loopback, RFC1918 and unique-local addresses only behind the matching flag", () => {
    const permissive = { allowLoopback: true, allowPrivate: true };
    for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "fc00::1"]) {
      expect(isDisallowedAddress(address, permissive)).toBe(false);
    }
    expect(isDisallowedAddress("127.0.0.1", { allowPrivate: true })).toBe(true);
    expect(isDisallowedAddress("10.0.0.1", { allowLoopback: true })).toBe(true);
    expect(isDisallowedAddress("fc00::1", { allowLoopback: true })).toBe(true);
  });

  it("never permits metadata, link-local, CGNAT, multicast or reserved addresses, whatever the flags", () => {
    const permissive = { allowLoopback: true, allowPrivate: true };
    for (const address of [
      "169.254.169.254",
      "fe80::1",
      "100.64.0.1",
      "224.0.0.1",
      "0.0.0.0",
      "2001:db8::1",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "2002:a9fe:a9fe::",
    ]) {
      expect(isDisallowedAddress(address, permissive)).toBe(true);
    }
  });
});

describe("checkNetworkTarget", () => {
  it("refuses a public hostname that resolves into a private range and reports the answer", async () => {
    const check = await checkNetworkTarget(PUBLIC_URL, { resolve: resolver({ [PUBLIC_HOST]: ["10.0.0.5"] }) });

    expect(check.ok).toBe(false);
    expect(check.reason).toBe("blocked-address");
    expect(check.addresses).toEqual(["10.0.0.5"]);
    expect(check.blocked).toEqual({ address: "10.0.0.5", kind: "private" });
  });

  it("refuses a host that answers with any blocked address next to a public one", async () => {
    const check = await checkNetworkTarget(PUBLIC_URL, {
      resolve: resolver({ [PUBLIC_HOST]: [PUBLIC_IP, "169.254.169.254"] }),
    });

    expect(check.reason).toBe("blocked-address");
    expect(check.blocked).toEqual({ address: "169.254.169.254", kind: "metadata" });
  });

  it("accepts a resolvable public destination and reports a failed or empty lookup as unresolvable", async () => {
    const accepted = await checkNetworkTarget(PUBLIC_URL, { resolve: resolver({}) });
    expect(accepted.ok).toBe(true);
    expect(accepted.addresses).toEqual([PUBLIC_IP]);

    const failed = await checkNetworkTarget(PUBLIC_URL, {
      resolve: async () => {
        throw new Error("resolver unavailable");
      },
    });
    expect(failed.reason).toBe("resolution-failed");

    const empty = await checkNetworkTarget(PUBLIC_URL, { resolve: async () => [] });
    expect(empty.reason).toBe("resolution-failed");
  });

  it("refuses plaintext http unless the caller explicitly opts in", async () => {
    const refused = await checkNetworkTarget("http://media.example.test/picture.png", { resolve: resolver({}) });
    expect(refused.reason).toBe("blocked-protocol");

    const optIn = await checkNetworkTarget("http://media.example.test/picture.png", {
      allowHttp: true,
      resolve: resolver({}),
    });
    expect(optIn.ok).toBe(true);
  });
});

describe("downloadSafeMedia blocked destinations", () => {
  const BLOCKED_DESTINATIONS: Array<[string, string]> = [
    ["https://127.0.0.1/output/picture.png", "loopback"],
    ["https://[::1]/output/picture.png", "loopback"],
    ["https://10.1.2.3/output/picture.png", "private"],
    ["https://172.16.0.1/output/picture.png", "private"],
    ["https://172.31.255.254/output/picture.png", "private"],
    ["https://192.168.1.1/output/picture.png", "private"],
    ["https://169.254.169.254/latest/meta-data/iam/security-credentials/", "metadata"],
    ["https://[fc00::1]/output/picture.png", "unique-local"],
    ["https://[fd12:3456:789a::1]/output/picture.png", "unique-local"],
    ["https://[fe80::1]/output/picture.png", "link-local"],
    ["https://100.64.0.1/output/picture.png", "carrier-grade-nat"],
    ["https://[::ffff:169.254.169.254]/output/picture.png", "metadata"],
    ["https://[64:ff9b::a9fe:a9fe]/output/picture.png", "metadata"],
    ["https://[2002:a9fe:a9fe::]/output/picture.png", "metadata"],
  ];

  it.each(BLOCKED_DESTINATIONS)("refuses %s (%s) without connecting to it", async (url, kind) => {
    const double = fetchDouble(() => {
      throw new Error(`the blocked destination ${url} must never be contacted`);
    });

    const outcome = await downloadSafeMedia(url, policy({ fetchImpl: double.impl, resolve: resolver({}) }));

    const refusal = expectRefusal(outcome, "blocked-address");
    expect(refusal.detail).toContain(`(${kind})`);
    expect(double.calls).toEqual([]);
  });
});

describe("downloadSafeMedia DNS rebinding", () => {
  it("refuses a public URL whose hostname resolves to a private address", async () => {
    const double = fetchDouble(() => {
      throw new Error("a rebound host must never be contacted");
    });

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: double.impl,
      resolve: resolver({ [PUBLIC_HOST]: ["10.0.0.5"] }),
    }));

    const refusal = expectRefusal(outcome, "blocked-address");
    expect(refusal.detail).toContain("10.0.0.5");
    expect(double.calls).toEqual([]);
  });

  it("refuses a hostname that answers with a mix of public and private addresses", async () => {
    const double = fetchDouble(() => {
      throw new Error("a host with any blocked answer must never be contacted");
    });

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: double.impl,
      resolve: resolver({ [PUBLIC_HOST]: [PUBLIC_IP, "10.0.0.5"] }),
    }));

    const refusal = expectRefusal(outcome, "blocked-address");
    expect(refusal.detail).toContain("10.0.0.5");
    expect(double.calls).toEqual([]);
  });

  it("refuses `localhost` and a name answering with a metadata address", async () => {
    for (const [target, answers] of [
      ["https://localhost/output/picture.png", { localhost: ["127.0.0.1"] }],
      ["https://cdn.example.test/output/picture.png", { "cdn.example.test": ["169.254.169.254"] }],
    ] as Array<[string, Record<string, string[]>]>) {
      const double = fetchDouble(() => {
        throw new Error(`the blocked destination ${target} must never be contacted`);
      });

      const outcome = await downloadSafeMedia(target, policy({ fetchImpl: double.impl, resolve: resolver(answers) }));

      expectRefusal(outcome, "blocked-address");
      expect(double.calls).toEqual([]);
    }
  });

  it("reports resolution-failed and connects to nothing when the resolver fails or answers nothing", async () => {
    for (const answer of [new Error("resolver unavailable"), [] as string[]]) {
      const double = fetchDouble(() => {
        throw new Error("an unresolvable destination must never be contacted");
      });

      const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
        fetchImpl: double.impl,
        resolve: resolver({ [PUBLIC_HOST]: answer }),
      }));

      expectRefusal(outcome, "resolution-failed");
      expect(double.calls).toEqual([]);
    }
  });
});

describe("downloadSafeMedia redirects", () => {
  const LOOPBACK_REDIRECT = "https://127.0.0.1/output/picture.png";

  it("refuses a hop that redirects to a private destination and never contacts it", async () => {
    const double = fetchDouble((url) => {
      if (url === PUBLIC_URL) {
        return new Response(null, { status: 302, headers: { location: LOOPBACK_REDIRECT } });
      }
      return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
    });

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    const refusal = expectRefusal(outcome, "blocked-address");
    expect(refusal.detail).toContain("127.0.0.1");
    expect(double.calls.map((call) => call.url)).toEqual([PUBLIC_URL]);
  });

  it("refuses a plaintext redirect to loopback before any connection", async () => {
    const double = fetchDouble((url) => {
      if (url === PUBLIC_URL) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/output/picture.png" } });
      }
      return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
    });

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    expectRefusal(outcome, "blocked-protocol");
    expect(double.calls.map((call) => call.url)).toEqual([PUBLIC_URL]);
  });

  it("refuses a redirect that leaves the authorized origin list, even to a public host", async () => {
    const double = fetchDouble((url) => {
      if (url === PUBLIC_URL) {
        return new Response(null, { status: 302, headers: { location: "https://cdn.other.test/output/picture.png" } });
      }
      return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
    });

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      authorizedOrigins: [PUBLIC_ORIGIN],
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    const refusal = expectRefusal(outcome, "destination-not-authorized");
    expect(refusal.detail).toBe("https://cdn.other.test");
    expect(double.calls.map((call) => call.url)).toEqual([PUBLIC_URL]);
  });

  it("follows a redirect inside the authorized list and reports the hop count and final URL", async () => {
    const second = `${PUBLIC_ORIGIN}/output/picture-1.png`;
    const double = fetchDouble((url) => {
      if (url === PUBLIC_URL) {
        return new Response(null, { status: 302, headers: { location: "/output/picture-1.png" } });
      }
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    });

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    if (!outcome.ok) throw new Error(`expected the download to succeed, got ${outcome.reason}`);
    expect(outcome.bytes).toEqual(PNG_BYTES);
    expect(outcome.mediaType).toBe("image/png");
    expect(outcome.finalUrl).toBe(second);
    expect(outcome.redirects).toBe(1);
    expect(double.calls.map((call) => call.url)).toEqual([PUBLIC_URL, second]);
    // The seam follows hops itself, so no hop can bypass its own checks.
    expect(double.calls.every((call) => call.init?.redirect === "manual")).toBe(true);
    expect(double.calls.every((call) => call.init?.method === "GET")).toBe(true);
  });

  it("refuses a chain longer than maxRedirects", async () => {
    let hop = 0;
    const double = fetchDouble(() => {
      hop += 1;
      return new Response(null, { status: 302, headers: { location: `/hop-${hop}` } });
    });

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: double.impl,
      resolve: resolver({}),
      maxRedirects: 2,
    }));

    const refusal = expectRefusal(outcome, "too-many-redirects");
    expect(refusal.detail).toContain("2");
    expect(double.calls).toHaveLength(3);
  });
});

describe("downloadSafeMedia size budget", () => {
  const MAX_BYTES = 64;

  it("refuses a response whose declared content-length exceeds the budget", async () => {
    const double = fetchDouble(() => new Response(PNG_BYTES, {
      headers: { "content-type": "image/png", "content-length": String(MAX_BYTES * 100) },
    }));

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: double.impl,
      resolve: resolver({}),
      maxBytes: MAX_BYTES,
    }));

    const refusal = expectRefusal(outcome, "oversized");
    expect(refusal).not.toHaveProperty("bytes");
  });

  it("refuses a streamed body that runs past the budget when no content-length is declared", async () => {
    const double = fetchDouble(() => new Response(streamOf(32, 32, 32), {
      headers: { "content-type": "image/png" },
    }));

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: double.impl,
      resolve: resolver({}),
      maxBytes: MAX_BYTES,
    }));

    const refusal = expectRefusal(outcome, "oversized");
    // Refused rather than truncated: no partial body leaks to the caller.
    expect(refusal).not.toHaveProperty("bytes");
  });

  it("accepts a body exactly at the budget and refuses one byte more", async () => {
    const atBudget = fetchDouble(() => new Response(streamOf(MAX_BYTES), {
      headers: { "content-type": "image/png" },
    }));
    const accepted = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: atBudget.impl,
      resolve: resolver({}),
      maxBytes: MAX_BYTES,
    }));
    if (!accepted.ok) throw new Error(`expected the download to succeed, got ${accepted.reason}`);
    expect(accepted.bytes.byteLength).toBe(MAX_BYTES);

    const overBudget = fetchDouble(() => new Response(streamOf(MAX_BYTES, 1), {
      headers: { "content-type": "image/png" },
    }));
    const refused = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: overBudget.impl,
      resolve: resolver({}),
      maxBytes: MAX_BYTES,
    }));
    expectRefusal(refused, "oversized");
  });
});

describe("downloadSafeMedia media type gate", () => {
  async function downloadWithContentType(contentType: string | null, url = PUBLIC_URL) {
    const headers = contentType === null ? {} : { "content-type": contentType };
    const double = fetchDouble(() => new Response(PNG_BYTES, { status: 200, headers }));
    const outcome = await downloadSafeMedia(url, policy({ fetchImpl: double.impl, resolve: resolver({}) }));
    return { outcome, double };
  }

  it("refuses an html body from an authorized destination", async () => {
    const { outcome } = await downloadWithContentType("text/html");

    const refusal = expectRefusal(outcome, "unsupported-media-type");
    expect(refusal.detail).toBe("text/html");
  });

  it("refuses a response with no media type at all", async () => {
    const { outcome } = await downloadWithContentType(null);

    const refusal = expectRefusal(outcome, "unsupported-media-type");
    expect(refusal.detail).toBe("(missing content-type)");
  });

  it("refuses a media type outside the allowed list", async () => {
    const { outcome } = await downloadWithContentType("image/gif");

    const refusal = expectRefusal(outcome, "unsupported-media-type");
    expect(refusal.detail).toBe("image/gif");
  });

  it("keeps the declared media type, ignoring parameters", async () => {
    const { outcome } = await downloadWithContentType("IMAGE/PNG; charset=binary");

    if (!outcome.ok) throw new Error(`expected the download to succeed, got ${outcome.reason}`);
    expect(outcome.mediaType).toBe("image/png");
  });

  it("accepts application/octet-stream only on a media path with a configured extension", async () => {
    const octetStream = fetchDouble(() => new Response(PNG_BYTES, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    }));
    const accepted = await downloadSafeMedia(`${PUBLIC_ORIGIN}/output/picture.png`, policy({
      fetchImpl: octetStream.impl,
      resolve: resolver({}),
      allowOctetStreamForMediaPaths: true,
      extensionsForOpaqueMedia: ["png", "jpg"],
    }));
    if (!accepted.ok) throw new Error(`expected the opaque media download to succeed, got ${accepted.reason}`);
    expect(accepted.mediaType).toBe("application/octet-stream");
    expect(accepted.bytes).toEqual(PNG_BYTES);
  });

  it("refuses application/octet-stream without the flag, without an extension and off a media path", async () => {
    const cases: Array<[string, Partial<SafeMediaPolicy>]> = [
      [`${PUBLIC_ORIGIN}/output/picture.png`, {}],
      [`${PUBLIC_ORIGIN}/output/picture.png`, { extensionsForOpaqueMedia: ["png", "jpg"] }],
      [`${PUBLIC_ORIGIN}/output/picture.png`, { allowOctetStreamForMediaPaths: true }],
      [`${PUBLIC_ORIGIN}/download?id=42`, { allowOctetStreamForMediaPaths: true, extensionsForOpaqueMedia: ["png", "jpg"] }],
      [`${PUBLIC_ORIGIN}/output/picture.png.exe`, { allowOctetStreamForMediaPaths: true, extensionsForOpaqueMedia: ["png", "jpg"] }],
    ];

    for (const [url, overrides] of cases) {
      const double = fetchDouble(() => new Response(PNG_BYTES, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }));
      const outcome = await downloadSafeMedia(url, policy({
        fetchImpl: double.impl,
        resolve: resolver({}),
        ...overrides,
      }));

      const refusal = expectRefusal(outcome, "unsupported-media-type");
      expect(refusal.detail).toBe("application/octet-stream");
    }
  });
});

describe("downloadSafeMedia destination authorization", () => {
  it("refuses an authorized-looking public origin that is not in the list, without fetching it", async () => {
    const double = fetchDouble(() => {
      throw new Error("an unauthorized origin must never be contacted");
    });

    const outcome = await downloadSafeMedia("https://cdn.other.test/output/picture.png", policy({
      authorizedOrigins: [PUBLIC_ORIGIN],
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    const refusal = expectRefusal(outcome, "destination-not-authorized");
    expect(refusal.detail).toBe("https://cdn.other.test");
    expect(double.calls).toEqual([]);
  });

  it("authorizes nothing when the origin list is empty", async () => {
    const double = fetchDouble(() => {
      throw new Error("an unauthorized origin must never be contacted");
    });

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      authorizedOrigins: [],
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    expectRefusal(outcome, "destination-not-authorized");
    expect(double.calls).toEqual([]);
  });

  it("accepts any public https origin under provider-output", async () => {
    const cdnUrl = "https://cdn.third-party.test/assets/picture.png";
    const double = fetchDouble(() => new Response(PNG_BYTES, {
      status: 200,
      headers: { "content-type": "image/png" },
    }));

    const first = await downloadSafeMedia(PUBLIC_URL, policy({ fetchImpl: double.impl, resolve: resolver({}) }));
    const second = await downloadSafeMedia(cdnUrl, policy({ fetchImpl: double.impl, resolve: resolver({}) }));

    if (!first.ok || !second.ok) throw new Error("expected both provider-output downloads to succeed");
    expect(first.finalUrl).toBe(PUBLIC_URL);
    expect(second.finalUrl).toBe(cdnUrl);
  });

  it("does not treat an authorized origin as address permission", async () => {
    const double = fetchDouble(() => {
      throw new Error("an authorized origin with a blocked address must never be contacted");
    });

    const outcome = await downloadSafeMedia("https://127.0.0.1:8188/view?filename=render.png", policy({
      authorizedOrigins: ["https://127.0.0.1:8188"],
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    expectRefusal(outcome, "blocked-address");
    expect(double.calls).toEqual([]);
  });

  it("refuses an unparseable destination and a non-https scheme without fetching anything", async () => {
    const double = fetchDouble(() => {
      throw new Error("nothing must be fetched for a refused destination");
    });

    const invalid = await downloadSafeMedia("not a url", policy({ fetchImpl: double.impl, resolve: resolver({}) }));
    expectRefusal(invalid, "invalid-url");

    const file = await downloadSafeMedia("file:///etc/passwd", policy({ fetchImpl: double.impl, resolve: resolver({}) }));
    expectRefusal(file, "blocked-protocol");

    const plaintext = await downloadSafeMedia("http://media.example.test/picture.png", policy({
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));
    expectRefusal(plaintext, "blocked-protocol");

    expect(double.calls).toEqual([]);
  });
});

describe("downloadSafeMedia success path", () => {
  it("returns the provider bytes, media type, final URL and redirect count", async () => {
    const double = fetchDouble(() => new Response(PNG_BYTES, {
      status: 200,
      headers: { "content-type": "image/png" },
    }));

    const outcome = await downloadSafeMedia(PUBLIC_URL, policy({
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    if (!outcome.ok) throw new Error(`expected the download to succeed, got ${outcome.reason}`);
    expect(outcome.bytes).toEqual(PNG_BYTES);
    expect(outcome.bytes.byteLength).toBe(PNG_BYTES.byteLength);
    expect(outcome.mediaType).toBe("image/png");
    expect(outcome.finalUrl).toBe(PUBLIC_URL);
    expect(outcome.redirects).toBe(0);
    expect(double.calls.map((call) => call.url)).toEqual([PUBLIC_URL]);
  });
});

describe("downloadSafeMedia local engine policy", () => {
  const ENGINE_ORIGIN = "https://127.0.0.1:8188";
  const ENGINE_URL = `${ENGINE_ORIGIN}/view?filename=render.png`;
  const LAN_ORIGIN = "https://10.0.0.5:8188";
  const LAN_URL = `${LAN_ORIGIN}/view?filename=render.png`;

  it("reaches a configured local engine only when the policy allows loopback", async () => {
    const allowed = fetchDouble(() => new Response(PNG_BYTES, {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    const accepted = await downloadSafeMedia(ENGINE_URL, policy({
      authorizedOrigins: [ENGINE_ORIGIN],
      allowLoopback: true,
      fetchImpl: allowed.impl,
      resolve: resolver({}),
    }));
    if (!accepted.ok) throw new Error(`expected the local engine download to succeed, got ${accepted.reason}`);
    expect(accepted.bytes).toEqual(PNG_BYTES);

    const blocked = fetchDouble(() => {
      throw new Error("the local engine must not be contacted under a provider media policy");
    });
    const refused = await downloadSafeMedia(ENGINE_URL, policy({
      authorizedOrigins: "provider-output",
      fetchImpl: blocked.impl,
      resolve: resolver({}),
    }));
    expectRefusal(refused, "blocked-address");
    expect(blocked.calls).toEqual([]);
  });

  it("reaches a user-declared LAN engine only when the policy allows private addresses", async () => {
    const allowed = fetchDouble(() => new Response(PNG_BYTES, {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    const accepted = await downloadSafeMedia(LAN_URL, policy({
      authorizedOrigins: [LAN_ORIGIN],
      allowPrivate: true,
      fetchImpl: allowed.impl,
      resolve: resolver({}),
    }));
    if (!accepted.ok) throw new Error(`expected the LAN engine download to succeed, got ${accepted.reason}`);
    expect(accepted.bytes).toEqual(PNG_BYTES);

    const blocked = fetchDouble(() => {
      throw new Error("the LAN engine must not be contacted with only loopback allowed");
    });
    const refused = await downloadSafeMedia(LAN_URL, policy({
      authorizedOrigins: [LAN_ORIGIN],
      allowLoopback: true,
      fetchImpl: blocked.impl,
      resolve: resolver({}),
    }));
    expectRefusal(refused, "blocked-address");
    expect(blocked.calls).toEqual([]);
  });

  it.each([
    "https://169.254.169.254/latest/meta-data/",
    "https://[fe80::1]/x.png",
    "https://100.64.0.1/x.png",
    "https://224.0.0.1/x.png",
    "https://198.18.0.1/x.png",
  ])("keeps %s blocked even with both local-engine flags granted", async (url) => {
    const double = fetchDouble(() => {
      throw new Error(`the blocked destination ${url} must never be contacted`);
    });

    const outcome = await downloadSafeMedia(url, policy({
      allowLoopback: true,
      allowPrivate: true,
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    expectRefusal(outcome, "blocked-address");
    expect(double.calls).toEqual([]);
  });

  it("refuses a plaintext engine URL even when its origin and loopback are authorized", async () => {
    const double = fetchDouble(() => {
      throw new Error("a plaintext destination must never be contacted");
    });

    const outcome = await downloadSafeMedia("http://127.0.0.1:8188/view?filename=render.png", policy({
      authorizedOrigins: ["http://127.0.0.1:8188"],
      allowLoopback: true,
      fetchImpl: double.impl,
      resolve: resolver({}),
    }));

    expectRefusal(outcome, "blocked-protocol");
    expect(double.calls).toEqual([]);
  });
});
