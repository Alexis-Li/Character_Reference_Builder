/**
 * CRB-03 (Issue #4) adapter contract tests.
 *
 * All cloud calls are mocked. These tests prove the SIMULATED contract only:
 * that both approved entries receive every reference input in fixed order,
 * that capability gaps reject before submission, and that credentials never
 * leak into logs or error text. They are NOT evidence of real provider
 * behavior or output quality — real-call evidence belongs to CRB-07.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { generateWithOpenAI } from "../providers/openai";
import { generateWithOpenAIOAuth, OAUTH_EXPERIMENTAL_ENDPOINT } from "../providers/openaiOAuth";
import { generateWithGemini } from "../providers/gemini";
import {
  checkReferenceGaps,
  imageCapabilities,
  normalizeReferences,
  estimateImageBytes,
  resolveGenerationModel,
  summarizePurposes,
  effectiveReferences,
  type ReferenceInput,
  type ProviderCallRecord,
} from "@/lib/providers/imageCapabilities";
import { POST } from "../route";
import { localApiRequest } from "@/test/localApiRequest";
import type { GenerationInput } from "@/lib/providers/types";

const { mockGenerateContent } = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  return { mockGenerateContent };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
    constructor(_config: unknown) {}
  },
}));

const image = (value: string) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`;
const original = image("synthetic-original");
const front = image("synthetic-retained-front");
const back = image("synthetic-auxiliary-back");
const fetchMock = vi.fn();

function input(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    model: { id: "gpt-image-1", name: "GPT Image", provider: "openai", capabilities: [], description: null },
    prompt: "Revise the back plate while preserving the retained front view",
    images: [],
    parameters: {},
    ...overrides,
  };
}

function canonicalReferences(): ReferenceInput[] {
  return [
    { image: original, purpose: "target" },
    { image: front, purpose: "retained-view" },
    { image: back, purpose: "auxiliary" },
  ];
}

function postRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  envKey?: string
): NextRequest {
  if (envKey) process.env[envKey] = "test-key-not-real";
  // The privileged request guard runs for real: the double supplies body and
  // headers only, the envelope supplies an authenticated local session.
  return localApiRequest(
    {
      json: vi.fn().mockResolvedValue(body),
      headers: new Headers(headers),
    } as unknown as NextRequest,
    { method: "POST", contentType: "application/json", headers }
  ) as unknown as NextRequest;
}

/** The guarded route handler expects Next's context; this route has no dynamic segments. */
const ROUTE_CONTEXT = { params: Promise.resolve({}) };
function callPost(request: NextRequest): Promise<Response> {
  return POST(request, ROUTE_CONTEXT);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => { throw new Error("Unexpected mock request"); });
  vi.stubGlobal("fetch", fetchMock);
  mockGenerateContent.mockReset();
  mockGenerateContent.mockResolvedValue({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "cmVzdWx0" } }] } }],
  });
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.CRB_ENABLE_OAUTH_EXPERIMENTAL_TRANSPORT;
});

describe("reference input contract", () => {
  it("keeps purpose and order through normalizeReferences", () => {
    const references: ReferenceInput[] = canonicalReferences();
    expect(normalizeReferences(references)).toEqual(references);
    expect(normalizeReferences(undefined)).toEqual([]);
  });

  it("rejects malformed reference entries with actionable errors", () => {
    expect(() => normalizeReferences([{ nope: true }])).toThrow("references[0].image");
    expect(() => normalizeReferences([{ image: original, purpose: "vibe" }])).toThrow("purpose must be one of");
    expect(() => normalizeReferences("not-an-array")).toThrow("array");
  });

  it("estimates data-URL wire sizes and returns null for remote URLs", () => {
    const url = image("abc");
    expect(estimateImageBytes(url)).toBe(url.length);
    expect(estimateImageBytes("https://example.com/a.png")).toBeNull();
    expect(estimateImageBytes("")).toBeNull();
  });

  it("never invents purposes from position: legacy stays legacy", () => {
    expect(summarizePurposes([])).toEqual({ purposes: null, purposeSource: "none" });
    expect(summarizePurposes(canonicalReferences())).toEqual({
      purposes: ["target", "retained-view", "auxiliary"],
      purposeSource: "declared",
    });
    expect(summarizePurposes([{ image: original }, { image: front }])).toEqual({
      purposes: null,
      purposeSource: "legacy",
    });
    expect(summarizePurposes([{ image: original, purpose: "target" }, { image: front }])).toEqual({
      purposes: null,
      purposeSource: "mixed",
    });
  });

  it("prefers structured references and losslessly maps legacy images", () => {
    const structured = canonicalReferences();
    expect(effectiveReferences(structured, [original])).toEqual(structured);
    expect(effectiveReferences([], [original, front])).toEqual([
      { image: original },
      { image: front },
    ]);
    expect(effectiveReferences([], [])).toEqual([]);
  });
});

describe("second compatible entry: OpenAI adapter forwards every reference (P04)", () => {
  it("sends two different-purpose references in fixed order", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    const result = await generateWithOpenAI("t2", "dummy-not-a-key", input({
      images: [original, front],
      references: [
        { image: original, purpose: "target" },
        { image: front, purpose: "retained-view" },
      ],
    }));
    expect(result.success).toBe(true);
    // The record comes from the transport that actually sent the request.
    expect(result.call).toMatchObject({
      provider: "openai",
      modelId: "gpt-image-1",
      auth: "api-key",
      stage: "succeeded",
      referenceCount: 2,
      purposes: ["target", "retained-view"],
      purposeSource: "declared",
      hasMask: false,
      resolvedFrom: "node-legacy",
    });
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const entries = [...body.getAll("image")];
    expect(entries).toHaveLength(2);
    const names = entries.map((e) => (e as File).name);
    expect(names).toEqual(["1-target.png", "2-retained-view.png"]);
    expect(body.get("prompt")).toBe("Revise the back plate while preserving the retained front view");
  });

  it("sends three references with distinct purposes in fixed order", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    await generateWithOpenAI("t3", "dummy-not-a-key", input({
      images: [original, front, back],
      references: canonicalReferences(),
    }));
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const names = [...body.getAll("image")].map((e) => (e as File).name);
    expect(names).toEqual(["1-target.png", "2-retained-view.png", "3-auxiliary.png"]);
  });

  it("forwards legacy flat images without purpose suffixes", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    const result = await generateWithOpenAI("t4", "dummy-not-a-key", input({ images: [original, front] }));
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const names = [...body.getAll("image")].map((e) => (e as File).name);
    expect(names).toEqual(["1.png", "2.png"]);
    // No declared roles in, no invented roles out.
    expect(result.call).toMatchObject({
      referenceCount: 2,
      purposes: null,
      purposeSource: "legacy",
      stage: "succeeded",
    });
  });
});

describe("first approved entry: Gemini adapter forwards every reference", () => {
  it("builds one inline part per reference in fixed order with prompt first", async () => {
    const prompt = "Revise back, keep front; keep the waistband width";
    const response = await generateWithGemini(
      "g1", "dummy-not-a-key", prompt, [], "nano-banana-pro",
      undefined, undefined, false, false,
      canonicalReferences(),
    );
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.call).toMatchObject({
      provider: "gemini",
      modelId: "nano-banana-pro",
      auth: "api-key",
      stage: "succeeded",
      referenceCount: 3,
      purposes: ["target", "retained-view", "auxiliary"],
      purposeSource: "declared",
      hasMask: false,
      resolvedFrom: "node-legacy",
    });
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const call = mockGenerateContent.mock.calls[0][0];
    const parts = call.contents[0].parts;
    expect(parts[0]).toEqual({ text: prompt });
    expect(parts).toHaveLength(4);
    const payloads = parts.slice(1).map((p: { inlineData: { data: string } }) => p.inlineData.data);
    expect(payloads).toEqual(
      canonicalReferences().map((r) => r.image.split("base64,")[1])
    );
  });

  it("ignores a directly passed mask instead of sending it as another image", async () => {
    const response = await generateWithGemini(
      "g2", "dummy-not-a-key", "Fill occluded region", [], "nano-banana-pro",
      undefined, undefined, false, false,
      [{ image: original, purpose: "target" }],
      image("mask-bytes"),
    );
    const data = await response.json();
    // The ignored mask is truthfully absent from the record.
    expect(data.call).toMatchObject({ hasMask: false, referenceCount: 1 });
    const parts = mockGenerateContent.mock.calls[0][0].contents[0].parts;
    // Prompt + exactly one reference; the mask is not appended as an image part.
    expect(parts).toHaveLength(2);
  });

  it("normalizes the same canonical request to the same output semantics as OpenAI", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    const canonical = input({ images: [], references: canonicalReferences(), modelSource: "project-default" });
    const openaiResult = await generateWithOpenAI("parity-oai", "dummy-not-a-key", canonical);
    expect(openaiResult.success).toBe(true);
    expect(openaiResult.outputs?.[0].data).toBe("data:image/png;base64,cmVzdWx0");
    expect(openaiResult.call).toMatchObject({
      auth: "api-key",
      resolvedFrom: "project-default",
      purposeSource: "declared",
      stage: "succeeded",
    });

    const geminiResponse = await generateWithGemini(
      "parity-gem", "dummy-not-a-key", canonical.prompt, [], "nano-banana-pro",
      undefined, undefined, false, false, canonicalReferences(), undefined, "project-default",
    );
    const geminiData = await geminiResponse.json();
    expect(geminiData.success).toBe(true);
    expect(geminiData.image).toBe("data:image/png;base64,cmVzdWx0");
    expect(geminiData.call).toMatchObject({
      auth: "api-key",
      resolvedFrom: "project-default",
      purposeSource: "declared",
      stage: "succeeded",
    });

    // Both adapters saw every reference in the same fixed order.
    const openaiBody = fetchMock.mock.calls[0][1].body as FormData;
    expect([...openaiBody.getAll("image")].map((e) => (e as File).name)).toEqual([
      "1-target.png",
      "2-retained-view.png",
      "3-auxiliary.png",
    ]);
    const geminiParts = mockGenerateContent.mock.calls[0][0].contents[0].parts;
    expect(geminiParts).toHaveLength(4);
  });
});

describe("pre-submit capability gaps", () => {
  const gemini = imageCapabilities("gemini", "nano-banana-pro")!;
  const openai = imageCapabilities("openai", "gpt-image-1")!;
  const bigImage = `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`;

  it("declares entry-level capabilities and fails closed for unknown models", () => {
    expect(gemini.multiReference).toBe(true);
    expect(gemini.maxReferenceImages).toBe(3);
    expect(openai.multiReference).toBe(true);
    expect(openai.maxReferenceImages).toBe(4);
    expect(openai.mask).toBe(true);
    expect(gemini.mask).toBe(false);
    expect(imageCapabilities("gemini", "no-such-model")).toBeNull();
    expect(imageCapabilities("openai", "no-such-model")).toBeNull();
    expect(imageCapabilities("gemini")).toBeNull();
  });

  it("returns no gaps for a compatible three-reference request", () => {
    expect(checkReferenceGaps(gemini, {
      references: canonicalReferences(),
      prompt: "revise",
    }, { provider: "gemini", modelId: "nano-banana-pro" })).toEqual([]);
  });

  it("flags reference count overflow without truncation", () => {
    const refs = Array.from({ length: 5 }, () => ({ image: original, purpose: "auxiliary" as const }));
    const gaps = checkReferenceGaps(gemini, { references: refs }, { provider: "gemini", modelId: "nano-banana-pro" });
    expect(gaps.map((g) => g.kind)).toEqual(["reference-count"]);
    expect(gaps[0].message).toContain("never truncated");
  });

  it("flags per-image size overflow with actionable message", () => {
    const gaps = checkReferenceGaps(gemini, { references: [{ image: bigImage, purpose: "target" }] }, { provider: "gemini", modelId: "nano-banana-pro" });
    expect(gaps.map((g) => g.kind)).toEqual(["image-size"]);
    expect(gaps[0].message).toContain("Compress");
  });

  it("flags remote URLs whose size cannot be verified locally", () => {
    const gaps = checkReferenceGaps(
      gemini,
      { references: [{ image: "https://example.com/a.png", purpose: "target" }] },
      { provider: "gemini", modelId: "nano-banana-pro" }
    );
    expect(gaps.map((g) => g.kind)).toEqual(["image-size"]);
    expect(gaps[0].message).toContain("cannot be verified");
  });

  it("flags combined request size overflow when several images add up", () => {
    const medium = `data:image/png;base64,${"A".repeat(9 * 1024 * 1024)}`;
    const gaps = checkReferenceGaps(gemini, { references: [{ image: medium }, { image: medium }, { image: medium }] }, { provider: "gemini", modelId: "nano-banana-pro" });
    expect(gaps.map((g) => g.kind)).toContain("request-size");
  });

  it("flags mask on a mask-less entry and accepts it on OpenAI", () => {
    const geminiGaps = checkReferenceGaps(gemini, { references: [{ image: original }], mask: image("m") }, { provider: "gemini", modelId: "nano-banana-pro" });
    expect(geminiGaps.map((g) => g.kind)).toEqual(["mask-unsupported"]);
    expect(checkReferenceGaps(openai, { references: [{ image: original }], mask: image("m") }, { provider: "openai", modelId: "gpt-image-1" })).toEqual([]);
  });

  it("fails closed when an undeclared entry receives structured references", () => {
    const gaps = checkReferenceGaps(null, { references: [{ image: original }], prompt: "p" }, { provider: "replicate" });
    expect(gaps.map((g) => g.kind)).toEqual(["capability-undeclared"]);
    expect(gaps[0].message).toContain("no declared reference capability");
  });

  it("route rejects an over-limit request with 422 and gap messages before any call", async () => {
    const refs = Array.from({ length: 4 }, (_, i) => ({ image: image(`ref-${i}`), purpose: "auxiliary" as const }));
    const response = await callPost(postRequest({
      prompt: "test",
      selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "NB Pro" },
      references: refs,
    }, {}, "GEMINI_API_KEY"));
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.gaps).toHaveLength(1);
    expect(data.gaps[0].kind).toBe("reference-count");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("route checks legacy flat images against the same entry limits", async () => {
    const refs = Array.from({ length: 5 }, (_, i) => image(`legacy-${i}`));
    const response = await callPost(postRequest({
      prompt: "legacy over-count",
      images: refs,
      selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "NB Pro" },
    }, {}, "GEMINI_API_KEY"));
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gaps.map((g: { kind: string }) => g.kind)).toEqual(["reference-count"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("route rejects legacy oversize images before submission", async () => {
    const response = await callPost(postRequest({
      prompt: "legacy oversize",
      images: [bigImage],
      selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "NB Pro" },
    }, {}, "GEMINI_API_KEY"));
    expect(response.status).toBe(422);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("route rejects remote-URL references whose size cannot be verified", async () => {
    const response = await callPost(postRequest({
      prompt: "remote url",
      references: [{ image: "https://example.com/a.png", purpose: "target" }],
      selectedModel: { provider: "openai", modelId: "gpt-image-1", displayName: "GPT" },
    }, {}, "OPENAI_API_KEY"));
    expect(response.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("route rejects unknown contract models without inheriting provider defaults", async () => {
    const response = await callPost(postRequest({
      prompt: "unknown model",
      selectedModel: { provider: "gemini", modelId: "no-such-model", displayName: "Unknown" },
    }, {}, "GEMINI_API_KEY"));
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gaps.map((g: { kind: string }) => g.kind)).toEqual(["capability-undeclared"]);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("route rejects a Gemini mask before any provider call", async () => {
    const response = await callPost(postRequest({
      prompt: "mask on gemini",
      references: [{ image: original, purpose: "target" }],
      mask: image("m"),
      selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "NB Pro" },
    }, {}, "GEMINI_API_KEY"));
    expect(response.status).toBe(422);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("pre-submit rejections carry explicit not-executed evidence without a call record", async () => {
    const overLimit = await callPost(postRequest({
      prompt: "test",
      selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "NB Pro" },
      references: Array.from({ length: 4 }, (_, i) => ({ image: image(`ref-${i}`), purpose: "auxiliary" as const })),
    }, {}, "GEMINI_API_KEY"));
    expect(overLimit.status).toBe(422);
    const overData = await overLimit.json();
    expect("call" in overData).toBe(false);
    expect(overData).toMatchObject({ execution: "not-executed", querySupport: "unsupported" });

    const noKey = await callPost(postRequest({
      prompt: "test",
      selectedModel: { provider: "openai", modelId: "gpt-image-1", displayName: "GPT" },
      references: canonicalReferences(),
    }));
    expect(noKey.status).toBe(401);
    const noKeyData = await noKey.json();
    expect("call" in noKeyData).toBe(false);
    expect(noKeyData).toMatchObject({ execution: "not-executed", querySupport: "unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("route forwards references and mask to the OpenAI entry in fixed order", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    const response = await callPost(postRequest({
      prompt: "swap the back plate",
      selectedModel: { provider: "openai", modelId: "gpt-image-1", displayName: "GPT Image" },
      references: canonicalReferences(),
      mask: image("mask-bytes"),
      modelSource: "node-override",
    }, {}, "OPENAI_API_KEY"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.call).toMatchObject({
      auth: "api-key",
      stage: "succeeded",
      resolvedFrom: "node-override",
      referenceCount: 3,
      purposes: ["target", "retained-view", "auxiliary"],
      purposeSource: "declared",
      hasMask: true,
    });
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const names = [...body.getAll("image")].map((e) => (e as File).name);
    expect(names).toEqual(["1-target.png", "2-retained-view.png", "3-auxiliary.png"]);
    // The mask rides in its own multipart field, never in image[].
    expect((body.get("mask") as File).name).toBe("mask.png");
    expect(body.get("prompt")).toBe("swap the back plate");
  });
});

describe("model resolution layers", () => {
  it("distinguishes project default, node override, and legacy config", () => {
    const projectDefault = { provider: "gemini" as const, modelId: "nano-banana-pro", displayName: "NB Pro" };
    expect(resolveGenerationModel({ nodeSelected: projectDefault, projectDefault }).resolvedFrom).toBe("project-default");
    const override = { provider: "openai" as const, modelId: "gpt-image-1", displayName: "GPT" };
    expect(resolveGenerationModel({ nodeSelected: override, projectDefault }).resolvedFrom).toBe("node-override");
    expect(resolveGenerationModel({ legacyModel: "nano-banana" }).resolvedFrom).toBe("node-legacy");
    expect(resolveGenerationModel({}).resolvedFrom).toBe("node-legacy");
  });

  it("trusts the persisted source instead of comparing with the mutable default", () => {
    const savedSnapshot = { provider: "gemini" as const, modelId: "nano-banana-pro", displayName: "NB Pro" };
    const changedDefault = { provider: "gemini" as const, modelId: "nano-banana-2", displayName: "NB 2" };
    // The global default changed after the node was created: the node keeps
    // its snapshot and its project-default label (not mislabeled override).
    const inherited = resolveGenerationModel({
      nodeSelected: savedSnapshot,
      projectDefault: changedDefault,
      persistedSource: "project-default",
    });
    expect(inherited.resolvedFrom).toBe("project-default");
    expect(inherited.model).toEqual(savedSnapshot);
    // An explicit pick stays an override even when its value equals the default.
    const explicitSameValue = resolveGenerationModel({
      nodeSelected: { ...changedDefault },
      projectDefault: changedDefault,
      persistedSource: "node-override",
    });
    expect(explicitSameValue.resolvedFrom).toBe("node-override");
    // Without a persisted source the legacy value comparison still applies.
    expect(resolveGenerationModel({
      nodeSelected: { ...changedDefault },
      projectDefault: changedDefault,
    }).resolvedFrom).toBe("project-default");
    expect(resolveGenerationModel({
      nodeSelected: { ...changedDefault },
    }).resolvedFrom).toBe("node-legacy");
  });
});

describe("credential and auth-channel separation", () => {
  it("drives the API-key and OAuth-experimental transports on separate paths", async () => {
    // CRB-09: the experimental transport fails closed until it is explicitly
    // enabled, so a direct caller cannot reach the network around the gate.
    const disabled = await generateWithOpenAIOAuth("oauth-off", "oauth-token-not-real", input({
      references: canonicalReferences(),
      mask: image("mask-bytes"),
    }));
    expect(disabled.success).toBe(false);
    expect(disabled.call?.auth).toBe("oauth-experimental");
    expect(disabled.call?.stage).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.CRB_ENABLE_OAUTH_EXPERIMENTAL_TRANSPORT = "1";

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    const apiResult = await generateWithOpenAI("api-path", "sk-not-a-real-key", input({
      references: canonicalReferences(),
      mask: image("mask-bytes"),
    }));
    expect(apiResult.success).toBe(true);
    const apiCall = fetchMock.mock.calls[0];
    expect(apiCall[0]).toBe("https://api.openai.com/v1/images/edits");
    expect(apiCall[1].headers).toMatchObject({ Authorization: "Bearer sk-not-a-real-key" });

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    const oauthResult = await generateWithOpenAIOAuth("oauth-path", "oauth-token-not-real", input({
      references: canonicalReferences(),
      mask: image("mask-bytes"),
    }));
    expect(oauthResult.success).toBe(true);
    const oauthCall = fetchMock.mock.calls[1];
    expect(oauthCall[0]).toBe(OAUTH_EXPERIMENTAL_ENDPOINT);
    expect(oauthCall[0]).not.toBe("https://api.openai.com/v1/images/edits");
    expect(oauthCall[1].headers).toMatchObject({
      Authorization: "Bearer oauth-token-not-real",
      "X-Experimental-Transport": "codex-oauth",
    });

    // Same business input, same fixed order, same normalized output shape.
    for (const call of [apiCall, oauthCall]) {
      const names = [...(call[1].body as FormData).getAll("image")].map((e) => (e as File).name);
      expect(names).toEqual(["1-target.png", "2-retained-view.png", "3-auxiliary.png"]);
      expect(((call[1].body as FormData).get("mask") as File).name).toBe("mask.png");
    }
    expect(apiResult.outputs?.[0].data).toBe(oauthResult.outputs?.[0].data);

    // Records generated by the two actual transports carry their own
    // channel and can never impersonate each other.
    expect(apiResult.call?.auth).toBe("api-key");
    expect(oauthResult.call?.auth).toBe("oauth-experimental");
    expect(apiResult.call?.auth).not.toBe(oauthResult.call?.auth);
    expect(apiResult.call).toMatchObject({ stage: "succeeded", purposeSource: "declared", hasMask: true });
    expect(oauthResult.call).toMatchObject({ stage: "succeeded", purposeSource: "declared", hasMask: true });
    const apiRecord = apiResult.call as ProviderCallRecord;
    const oauthRecord = oauthResult.call as ProviderCallRecord;
    expect(apiRecord satisfies ProviderCallRecord).toBeDefined();
    expect(oauthRecord satisfies ProviderCallRecord).toBeDefined();
  });

  it("route selects the OAuth adapter only for a CLI caller with the experimental transport enabled", async () => {
    const body = {
      prompt: "oauth route",
      selectedModel: { provider: "openai", modelId: "gpt-image-1", displayName: "GPT" },
      references: canonicalReferences(),
    };

    // A browser session holding the experimental token header is refused before
    // any provider call: the transport is CLI-only and off by default.
    const refused = await callPost(postRequest(body, { "X-OpenAI-OAuth-Token": "oauth-token-not-real" }));
    expect(refused.status).toBe(403);
    const refusedData = await refused.json();
    expect(refusedData.success).toBe(false);
    expect(refusedData.error).toContain("disabled");
    expect(fetchMock).not.toHaveBeenCalled();

    // A CLI caller with the transport enabled reaches the experimental endpoint.
    process.env.CRB_ENABLE_OAUTH_EXPERIMENTAL_TRANSPORT = "1";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    const cliRequest = localApiRequest(
      { json: vi.fn().mockResolvedValue(body) } as unknown as NextRequest,
      {
        method: "POST",
        contentType: "application/json",
        cli: true,
        headers: { "X-OpenAI-OAuth-Token": "oauth-token-not-real" },
      }
    ) as unknown as NextRequest;
    const oauthResponse = await callPost(cliRequest);
    expect(oauthResponse.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(OAUTH_EXPERIMENTAL_ENDPOINT);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer oauth-token-not-real",
      "X-Experimental-Transport": "codex-oauth",
    });
    const oauthData = await oauthResponse.json();
    expect(oauthData.call?.auth).toBe("oauth-experimental");
    expect(oauthData.call?.stage).toBe("succeeded");

    fetchMock.mockClear();
    const apiResponse = await callPost(postRequest(body, { "X-OpenAI-API-Key": "sk-not-a-real-key" }));
    expect(apiResponse.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/edits");
    const apiData = await apiResponse.json();
    expect(apiData.call?.auth).toBe("api-key");
    expect(apiData.call?.stage).toBe("succeeded");
  });

  it("logged request evidence never contains the API key", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    const secret = "sk-super-secret-key-material";
    await generateWithOpenAI("sec", secret, input({ images: [original, front] }));
    const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain(secret);
    // Authorization rides only in the request header.
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${secret}`);
    logSpy.mockRestore();
  });
});

describe("privileged request guard", () => {
  it("refuses a request from a hostile origin before any provider work", async () => {
    const response = await callPost(postRequest({
      prompt: "hostile origin",
      selectedModel: { provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana" },
    }, { origin: "https://attacker.example" }, "GEMINI_API_KEY"));

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.reason).toBe("unexpected-origin");
    // No credential was read and no adapter ran.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});
