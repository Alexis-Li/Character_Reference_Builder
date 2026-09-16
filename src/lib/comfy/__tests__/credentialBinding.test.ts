/**
 * Credential binding for ComfyUI engines (CRB-09 / Issue #10).
 *
 * The vulnerable shape this pins down: one request could name the destination
 * (`X-Comfy-Base-Url`) *and* the credential, an environment key rode to
 * whatever destination the request named, the partner-node key fell back to the
 * engine key, and a redirect was followed with the key attached.
 *
 * Every case drives the exported seams — `connectionFromRequest`,
 * `orgKeyFromRequest`, `createEngine` and the engines' real request path — so
 * what is asserted is the behavior a request produces, not a private helper.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { COMFY_HEADERS } from "../settings";
import { connectionFromRequest, orgKeyFromRequest } from "../server/connection";
import { createEngine } from "../server";
import { LegacyComfyEngine } from "../server/legacyEngine";
import { SdkComfyEngine } from "../server/sdkEngine";

const CLOUD = "https://cloud.comfy.org";
const ATTACKER = "https://attacker.example";
const EMITTER_KEY = "comfyui-emitter-not-a-real-key";
const ORG_KEY = "comfyui-org-not-a-real-key";

/** A request as a route would see it, with only the headers under test. */
function comfyRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${CLOUD}/api/comfy/status`, { headers });
}

/** A finished job whose single output is one PNG file. */
const finishedJob = {
  status: "completed",
  terminal: true,
  error: null,
  raw: { outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } },
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("connectionFromRequest — engine key", () => {
  it("withholds a server environment key from a destination the request named", () => {
    vi.stubEnv("COMFY_API_KEY", EMITTER_KEY);

    const connection = connectionFromRequest(
      comfyRequest({ [COMFY_HEADERS.baseUrl]: ATTACKER, [COMFY_HEADERS.mode]: "remote" })
    );

    expect(connection.apiKey).toBeNull();
    // Nothing about this destination is authorized for the key — neither its
    // origin (not a registered recipient) nor the request (it carried no key of
    // its own) — so the credential is withheld rather than sent.
    expect(connection.credentialWithheld).toBe("recipient-not-authorized");
    expect(connection.providerConnection?.credentialSource).toBe("server-environment");
    expect(connection.providerConnection?.recipientOrigin).toBe(ATTACKER);
  });

  it("still sends the environment key to the registered recipient", () => {
    vi.stubEnv("COMFY_API_KEY", EMITTER_KEY);

    const connection = connectionFromRequest(
      comfyRequest({ [COMFY_HEADERS.baseUrl]: CLOUD, [COMFY_HEADERS.mode]: "cloud" })
    );

    expect(connection.apiKey).toBe(EMITTER_KEY);
    expect(connection.credentialWithheld).toBeNull();
  });

  it("sends a request-supplied key to the destination that request named", () => {
    vi.stubEnv("COMFY_API_KEY", EMITTER_KEY);

    const connection = connectionFromRequest(
      comfyRequest({
        [COMFY_HEADERS.baseUrl]: "https://engine.example",
        [COMFY_HEADERS.mode]: "remote",
        [COMFY_HEADERS.apiKey]: "browser-key",
      })
    );

    expect(connection.apiKey).toBe("browser-key");
    expect(connection.credentialWithheld).toBeNull();
    expect(connection.providerConnection?.credentialSource).toBe("browser-supplied");
    expect(connection.providerConnection?.userAuthorizedDestination).toBe(true);
  });

  it("treats a request-named private destination as reachable only in local mode", () => {
    const headers = { [COMFY_HEADERS.baseUrl]: "http://10.0.0.5:8188" };

    expect(
      connectionFromRequest(comfyRequest({ ...headers, [COMFY_HEADERS.mode]: "remote" }))
        .providerConnection?.allowNonPublicDestination
    ).toBe(false);
    expect(
      connectionFromRequest(comfyRequest({ ...headers, [COMFY_HEADERS.mode]: "local" }))
        .providerConnection?.allowNonPublicDestination
    ).toBe(true);
  });
});

describe("orgKeyFromRequest — partner-node channel", () => {
  it("never falls back to the engine key", () => {
    const request = comfyRequest({
      [COMFY_HEADERS.baseUrl]: CLOUD,
      [COMFY_HEADERS.mode]: "cloud",
      [COMFY_HEADERS.apiKey]: "engine-key",
    });

    expect(orgKeyFromRequest(request, connectionFromRequest(request))).toBeNull();
  });

  it("never sends an environment partner key to a destination a request named", () => {
    vi.stubEnv("COMFY_ORG_API_KEY", ORG_KEY);

    const request = comfyRequest({
      [COMFY_HEADERS.baseUrl]: ATTACKER,
      [COMFY_HEADERS.mode]: "remote",
      [COMFY_HEADERS.apiKey]: "engine-key",
    });

    expect(orgKeyFromRequest(request, connectionFromRequest(request))).toBeNull();
  });

  it("sends an environment partner key only to the registered recipient", () => {
    vi.stubEnv("COMFY_ORG_API_KEY", ORG_KEY);

    const request = comfyRequest({ [COMFY_HEADERS.baseUrl]: CLOUD, [COMFY_HEADERS.mode]: "cloud" });

    expect(orgKeyFromRequest(request, connectionFromRequest(request))).toBe(ORG_KEY);
  });

  it("rides a request-supplied partner key with the destination that request named", () => {
    const request = comfyRequest({
      [COMFY_HEADERS.baseUrl]: "https://engine.example",
      [COMFY_HEADERS.mode]: "remote",
      [COMFY_HEADERS.apiKey]: "engine-key",
      [COMFY_HEADERS.orgKey]: ORG_KEY,
    });

    expect(orgKeyFromRequest(request, connectionFromRequest(request))).toBe(ORG_KEY);
  });

  it("attaches a request-supplied partner key to the environment's registered engine", () => {
    vi.stubEnv("COMFY_MODE", "cloud");
    vi.stubEnv("COMFY_CLOUD_API_KEY", EMITTER_KEY);

    const request = comfyRequest({ [COMFY_HEADERS.orgKey]: ORG_KEY });

    expect(orgKeyFromRequest(request, connectionFromRequest(request))).toBe(ORG_KEY);
  });
});

describe("createEngine — SDK transport gate", () => {
  it("drives the registered recipient with the SDK", () => {
    const connection = connectionFromRequest(
      comfyRequest({
        [COMFY_HEADERS.baseUrl]: CLOUD,
        [COMFY_HEADERS.apiV2]: "1",
        [COMFY_HEADERS.apiKey]: "browser-key",
      })
    );

    expect(createEngine(connection)).toBeInstanceOf(SdkComfyEngine);
  });

  it("keeps a plaintext engine on the legacy surface even when it claims API v2", () => {
    const connection = connectionFromRequest(
      comfyRequest({
        [COMFY_HEADERS.baseUrl]: "http://127.0.0.1:8188",
        [COMFY_HEADERS.mode]: "local",
        [COMFY_HEADERS.apiV2]: "1",
      })
    );

    expect(createEngine(connection)).toBeInstanceOf(LegacyComfyEngine);
  });

  it("keeps an unauthorized destination on the legacy surface, where redirects are policed", () => {
    vi.stubEnv("COMFY_API_KEY", EMITTER_KEY);

    const connection = connectionFromRequest(
      comfyRequest({
        [COMFY_HEADERS.baseUrl]: "https://engine.example",
        [COMFY_HEADERS.mode]: "remote",
        [COMFY_HEADERS.apiV2]: "1",
      })
    );

    expect(createEngine(connection)).toBeInstanceOf(LegacyComfyEngine);
  });

  it("keeps a request-authorized HTTPS destination on the legacy surface, because the SDK owns its redirects", () => {
    // The SDK's own transport cannot be policy-controlled, so it is reserved
    // for the one destination the product registered. A destination a request
    // authorized with its own key still gets service — over the legacy engine,
    // where every hop is address-checked and redirects are refused.
    const connection = connectionFromRequest(
      comfyRequest({
        [COMFY_HEADERS.baseUrl]: "https://engine.example",
        [COMFY_HEADERS.mode]: "remote",
        [COMFY_HEADERS.apiV2]: "1",
        [COMFY_HEADERS.apiKey]: "browser-key",
      })
    );

    expect(connection.credentialWithheld ?? null).toBeNull();
    expect(createEngine(connection)).toBeInstanceOf(LegacyComfyEngine);
  });

  it("allows the SDK only for the registered Comfy Cloud recipient", () => {
    vi.stubEnv("COMFY_API_KEY", EMITTER_KEY);

    const cloud = connectionFromRequest(
      comfyRequest({
        [COMFY_HEADERS.baseUrl]: "https://cloud.comfy.org",
        [COMFY_HEADERS.mode]: "cloud",
        [COMFY_HEADERS.apiV2]: "1",
      })
    );
    expect(createEngine(cloud)).toBeInstanceOf(SdkComfyEngine);
  });
});

describe("LegacyComfyEngine — credentialed engine calls", () => {
  function cloudEngine(): LegacyComfyEngine {
    return new LegacyComfyEngine(
      connectionFromRequest(
        comfyRequest({
          [COMFY_HEADERS.baseUrl]: CLOUD,
          [COMFY_HEADERS.mode]: "cloud",
          [COMFY_HEADERS.apiKey]: "browser-key",
        })
      )
    );
  }

  it("carries the key to the bound engine and stops at a redirect to another host", async () => {
    const calls: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), key: new Headers(init?.headers).get("X-API-Key") });
        return new Response(null, { status: 302, headers: { location: `${ATTACKER}/steal` } });
      })
    );

    await expect(cloudEngine().objectInfo()).rejects.toThrow(/redirect to another host/);

    // One request, to the engine, carrying the key: the redirect target was
    // never contacted, so nothing forwarded the credential to it.
    expect(calls).toEqual([{ url: `${CLOUD}/api/object_info`, key: "browser-key" }]);
  });

  it("follows a same-origin redirect with the key", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: `${CLOUD}/api/object_info?v=2` },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      })
    );

    await expect(cloudEngine().objectInfo()).resolves.toEqual({});
    expect(call).toBe(2);
  });

  it("refuses a request-named private engine that carries no key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const engine = new LegacyComfyEngine(
      connectionFromRequest(
        comfyRequest({
          [COMFY_HEADERS.baseUrl]: "https://10.0.0.5:8188",
          [COMFY_HEADERS.mode]: "remote",
        })
      )
    );

    await expect(engine.objectInfo()).rejects.toThrow(/blocked-address/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reaches a private engine in local mode, where that is the configuration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
    );

    const engine = new LegacyComfyEngine(
      connectionFromRequest(
        comfyRequest({
          [COMFY_HEADERS.baseUrl]: "http://10.0.0.5:8188",
          [COMFY_HEADERS.mode]: "local",
        })
      )
    );

    await expect(engine.objectInfo()).resolves.toEqual({});
  });

  it("reaches a LAN engine a request authorized with its own key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
    );

    const engine = new LegacyComfyEngine(
      connectionFromRequest(
        comfyRequest({
          [COMFY_HEADERS.baseUrl]: "http://192.168.1.20:8188",
          [COMFY_HEADERS.mode]: "remote",
          [COMFY_HEADERS.apiKey]: "lan-key",
        })
      )
    );

    await expect(engine.objectInfo()).resolves.toEqual({});
  });
});

describe("LegacyComfyEngine — output download", () => {
  it("follows a signed-storage redirect without the key", async () => {
    const calls: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, key: new Headers(init?.headers).get("X-API-Key") });
        if (url.startsWith(CLOUD)) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://storage.example/signed/out.png" },
          });
        }
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      })
    );

    const engine = new LegacyComfyEngine(
      connectionFromRequest(
        comfyRequest({
          [COMFY_HEADERS.baseUrl]: CLOUD,
          [COMFY_HEADERS.mode]: "cloud",
          [COMFY_HEADERS.apiKey]: "browser-key",
        })
      )
    );

    const assets = await engine.collect({ ...finishedJob });

    expect(assets).toHaveLength(1);
    expect(assets[0]?.filename).toBe("out.png");
    // The key reaches the engine's own endpoint and nothing else: the signed
    // storage hop is followed without it.
    expect(calls).toEqual([
      { url: `${CLOUD}/api/view?filename=out.png&subfolder=&type=output`, key: "browser-key" },
      { url: "https://storage.example/signed/out.png", key: null },
    ]);
  });

  it("fails a local engine's download when it redirects to another host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://collector.example/out.png" },
          })
      )
    );

    const engine = new LegacyComfyEngine(
      connectionFromRequest(
        comfyRequest({ [COMFY_HEADERS.baseUrl]: "http://127.0.0.1:8188", [COMFY_HEADERS.mode]: "local" })
      )
    );

    await expect(engine.collect({ ...finishedJob })).rejects.toThrow(/redirect to another host/);
  });
});
