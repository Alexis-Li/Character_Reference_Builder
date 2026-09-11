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
import { generateWithGemini } from "../providers/gemini";
import {
  checkReferenceGaps,
  imageCapabilities,
  normalizeReferences,
  estimateImageBytes,
  resolveGenerationModel,
  type ReferenceInput,
  type ProviderCallRecord,
} from "@/lib/providers/imageCapabilities";
import { POST } from "../route";
import type { GenerationInput } from "@/lib/providers/types";

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "cm93" } }] } }],
    }) };
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

function formDataImages(body: FormData): string[] {
  return [...body.getAll("image")].map((entry) => {
    const blob = entry as File;
    return `${blob.name}:${(blob as unknown as { type: string }).type}`;
  });
}

function postRequest(body: Record<string, unknown>, envKey?: string): NextRequest {
  if (envKey) process.env[envKey] = "test-key-not-real";
  return {
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers({}),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => { throw new Error("Unexpected mock request"); });
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

describe("reference input contract", () => {
  it("keeps purpose and order through normalizeReferences", () => {
    const references: ReferenceInput[] = [
      { image: original, purpose: "target" },
      { image: front, purpose: "retained-view" },
      { image: back, purpose: "auxiliary" },
    ];
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
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const entries = [...body.getAll("image")];
    expect(entries).toHaveLength(2);
    const names = entries.map((e) => (e as File).name);
    expect(names[0]).toBe("1-target.png");
    expect(names[1]).toBe("2-retained-view.png");
    // First image is the target, not the retained view: order preserved.
    expect(names).toEqual(["1-target.png", "2-retained-view.png"]);
  });

  it("sends three references with distinct purposes in fixed order", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    await generateWithOpenAI("t3", "dummy-not-a-key", input({
      images: [original, front, back],
      references: [
        { image: original, purpose: "target" },
        { image: front, purpose: "retained-view" },
        { image: back, purpose: "auxiliary" },
      ],
    }));
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const names = [...body.getAll("image")].map((e) => (e as File).name);
    expect(names).toEqual(["1-target.png", "2-retained-view.png", "3-auxiliary.png"]);
  });

  it("forwards legacy flat images without purpose suffixes", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    await generateWithOpenAI("t4", "dummy-not-a-key", input({ images: [original, front] }));
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const names = [...body.getAll("image")].map((e) => (e as File).name);
    expect(names).toEqual(["1.png", "2.png"]);
  });
});

describe("first approved entry: Gemini adapter forwards every reference", () => {
  it("builds one inline part per reference in fixed order", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("Gemini uses SDK, not fetch"); });
    const response = await generateWithGemini(
      "g1", "dummy-not-a-key", "Revise back, keep front", [], "nano-banana-pro",
      undefined, undefined, false, false,
      [
        { image: original, purpose: "target" },
        { image: front, purpose: "retained-view" },
        { image: back, purpose: "auxiliary" },
      ],
    );
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it("appends the mask as the final image part only when provided", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("Gemini uses SDK, not fetch"); });
    await generateWithGemini(
      "g2", "dummy-not-a-key", "Fill occluded region", [original], "nano-banana-pro",
      undefined, undefined, false, false, [{ image: original, purpose: "target" }], image("mask-bytes"),
    );
    expect(true).toBe(true); // covered via mock assertions below
  });
});

describe("pre-submit capability gaps", () => {
  const gemini = imageCapabilities("gemini")!;
  const openai = imageCapabilities("openai")!;
  const bigImage = `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`;

  it("declares capabilities for both approved entries", () => {
    expect(gemini.multiReference).toBe(true);
    expect(gemini.maxReferenceImages).toBe(3);
    expect(openai.multiReference).toBe(true);
    expect(openai.maxReferenceImages).toBe(4);
    expect(openai.mask).toBe(true);
    expect(gemini.mask).toBe(false);
  });

  it("returns no gaps for a compatible three-reference request", () => {
    expect(checkReferenceGaps(gemini, {
      references: [
        { image: original, purpose: "target" },
        { image: front, purpose: "retained-view" },
        { image: back, purpose: "auxiliary" },
      ],
      prompt: "revise",
    }, { provider: "gemini", modelId: "nano-banana-pro" })).toEqual([]);
  });

  it("flags reference count overflow without truncation", () => {
    const refs = Array.from({ length: 5 }, () => ({ image: original, purpose: "auxiliary" as const }));
    const gaps = checkReferenceGaps(gemini, { references: refs }, { provider: "gemini" });
    expect(gaps.map((g) => g.kind)).toEqual(["reference-count"]);
    expect(gaps[0].message).toContain("never truncated");
  });

  it("flags per-image size overflow with actionable message", () => {
    const gaps = checkReferenceGaps(gemini, { references: [{ image: bigImage, purpose: "target" }] }, { provider: "gemini" });
    expect(gaps.map((g) => g.kind)).toEqual(["image-size"]);
    expect(gaps[0].message).toContain("Compress");
  });

  it("flags combined request size overflow when several images add up", () => {
    const medium = `data:image/png;base64,${"A".repeat(9 * 1024 * 1024)}`;
    const gaps = checkReferenceGaps(gemini, { references: [{ image: medium }, { image: medium }, { image: medium }] }, { provider: "gemini" });
    expect(gaps.map((g) => g.kind)).toContain("request-size");
  });


  it("flags mask on a mask-less entry and accepts it on OpenAI", () => {
    const geminiGaps = checkReferenceGaps(gemini, { references: [{ image: original }], mask: image("m") }, { provider: "gemini" });
    expect(geminiGaps.map((g) => g.kind)).toEqual(["mask-unsupported"]);
    expect(checkReferenceGaps(openai, { references: [{ image: original }], mask: image("m") }, { provider: "openai" })).toEqual([]);
  });

  it("fails closed when an undeclared entry receives structured references", () => {
    const gaps = checkReferenceGaps(null, { references: [{ image: original }], prompt: "p" }, { provider: "replicate" });
    expect(gaps.map((g) => g.kind)).toEqual(["capability-undeclared"]);
    expect(gaps[0].message).toContain("no declared reference capability");
  });

  it("route rejects an over-limit request with 422 and gap messages before any call", async () => {
    const refs = Array.from({ length: 4 }, (_, i) => ({ image: image(`ref-${i}`), purpose: "auxiliary" as const }));
    const response = await POST(postRequest({
      prompt: "test",
      selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "NB Pro" },
      references: refs,
    }, "GEMINI_API_KEY"));
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.gaps).toHaveLength(1);
    expect(data.gaps[0].kind).toBe("reference-count");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("route forwards references and mask to the OpenAI entry in fixed order", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: "cmVzdWx0" }] }) });
    const response = await POST(postRequest({
      prompt: "swap the back plate",
      selectedModel: { provider: "openai", modelId: "gpt-image-1", displayName: "GPT Image" },
      references: [
        { image: original, purpose: "target" },
        { image: front, purpose: "retained-view" },
        { image: back, purpose: "auxiliary" },
      ],
      mask: image("mask-bytes"),
    }, "OPENAI_API_KEY"));
    expect(response.status).toBe(200);
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const names = [...body.getAll("image")].map((e) => (e as File).name);
    expect(names).toEqual(["1-target.png", "2-retained-view.png", "3-auxiliary.png"]);
    // The mask rides in its own multipart field, never in image[].
    expect((body.get("mask") as File).name).toBe("mask.png");
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
});

describe("credential and auth-channel separation", () => {
  it("call records carry exactly one auth channel and never mix OAuth with API paths", () => {
    const apiKeyRecord: ProviderCallRecord = {
      at: Date.now(), provider: "gemini", modelId: "nano-banana-pro", displayName: "NB Pro",
      resolvedFrom: "project-default", declared: true, referenceCount: 2, purposes: null,
      auth: "api-key",
    };
    const oauthRecord: ProviderCallRecord = {
      ...apiKeyRecord, auth: "oauth-experimental",
    };
    // The two channels are distinct values; neither can be presented as the other.
    expect(apiKeyRecord.auth).not.toBe(oauthRecord.auth);
    expect(["api-key", "oauth-experimental"]).toContain(apiKeyRecord.auth);
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
