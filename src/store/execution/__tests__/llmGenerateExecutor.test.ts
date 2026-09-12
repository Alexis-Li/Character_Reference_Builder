import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeLlmGenerate } from "../llmGenerateExecutor";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode } from "@/types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const defaultProviderSettings = {
  providers: {
    gemini: { apiKey: "gkey" },
    replicate: { apiKey: "" },
    fal: { apiKey: "" },
    kie: { apiKey: "" },
    wavespeed: { apiKey: "" },
    openai: { apiKey: "okey" },
    anthropic: { apiKey: "" },
  },
} as any;

function makeNode(data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "llm-1",
    type: "llmGenerate",
    position: { x: 0, y: 0 },
    data: {
      outputText: null,
      inputImages: [],
      inputPrompt: null,
      status: null,
      error: null,
      provider: "google",
      model: "gemini-2.5-flash",
      temperature: 0.7,
      maxTokens: 1024,
      ...data,
    },
  } as WorkflowNode;
}

function makeCtx(
  node: WorkflowNode,
  overrides: Partial<NodeExecutionContext> = {}
): NodeExecutionContext {
  return {
    node,
    getConnectedInputs: vi.fn().mockReturnValue({
      images: [],
      videos: [],
      audio: [],
      text: "test llm prompt",
      dynamicInputs: {},
      easeCurve: null,
    }),
    updateNodeData: vi.fn(),
    getFreshNode: vi.fn().mockReturnValue(node),
    getEdges: vi.fn().mockReturnValue([]),
    getNodes: vi.fn().mockReturnValue([node]),
    providerSettings: defaultProviderSettings,
    addIncurredCost: vi.fn(),
    addToGlobalHistory: vi.fn(),
    generationsPath: null,
    saveDirectoryPath: null,
    trackSaveGeneration: vi.fn(),
    appendOutputGalleryImage: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
});

describe("executeLlmGenerate", () => {
  it("should throw when no text input", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });

    await expect(executeLlmGenerate(ctx)).rejects.toThrow("Missing text input");

    expect(ctx.updateNodeData).toHaveBeenCalledWith("llm-1", expect.objectContaining({
      status: "error",
      error: expect.stringContaining("Missing text input"),
    }));
  });

  it("should set loading status before API call", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "generated text" }),
    });

    const ctx = makeCtx(node);
    await executeLlmGenerate(ctx);

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const loadingCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "loading"
    );
    expect(loadingCall).toBeDefined();
  });

  it("should call /api/llm with correct payload", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "result text" }),
    });

    const ctx = makeCtx(node);
    await executeLlmGenerate(ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/llm",
      expect.objectContaining({
        method: "POST",
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toBe("test llm prompt");
    expect(body.provider).toBe("google");
    expect(body.model).toBe("gemini-2.5-flash");
    expect(body.temperature).toBe(0.7);
    expect(body.maxTokens).toBe(1024);
  });

  it("should include images in request when connected", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,img1"],
        videos: [],
        audio: [],
        text: "describe this",
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "description" }),
    });

    await executeLlmGenerate(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.images).toEqual(["data:image/png;base64,img1"]);
  });

  it("should not include images field when none connected", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "result" }),
    });

    const ctx = makeCtx(node);
    await executeLlmGenerate(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.images).toBeUndefined();
  });

  it("should update node with result text on success", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "generated output" }),
    });

    const ctx = makeCtx(node);
    await executeLlmGenerate(ctx);

    expect(ctx.updateNodeData).toHaveBeenCalledWith("llm-1", {
      outputText: "generated output",
      status: "complete",
      error: null,
    });
  });

  it("should throw on HTTP error", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('{"error": "LLM down"}'),
    });

    const ctx = makeCtx(node);
    await expect(executeLlmGenerate(ctx)).rejects.toThrow("LLM down");
  });

  it("should throw on API failure", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: false, error: "Token limit exceeded" }),
    });

    const ctx = makeCtx(node);
    await expect(executeLlmGenerate(ctx)).rejects.toThrow("Token limit exceeded");
  });

  it("should use stored fallback in regenerate mode", async () => {
    const node = makeNode({
      inputImages: ["stored.png"],
      inputPrompt: "stored llm prompt",
    });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, text: "result" }),
    });

    await executeLlmGenerate(ctx, { useStoredFallback: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toBe("stored llm prompt");
    expect(body.images).toEqual(["stored.png"]);
  });

  it("keeps generic automatic fallback disabled by default", async () => {
    // Primary is google/gemini-2.5-flash, fallback is stored as anthropic (no mapping needed)
    const node = makeNode({
      fallbackModel: {
        provider: "anthropic",
        modelId: "claude-sonnet-4.5",
        displayName: "Claude Sonnet 4.5",
      },
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: false, error: "Primary LLM boom" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, text: "fallback output" }),
      });

    const ctx = makeCtx(node);
    await expect(executeLlmGenerate(ctx)).rejects.toThrow("Primary LLM boom");

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // First call should use google/gemini-2.5-flash
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(firstBody.provider).toBe("google");
    expect(firstBody.model).toBe("gemini-2.5-flash");

  });

  it("does not map or submit a configured Gemini fallback without authorization", async () => {
    const node = makeNode({
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      fallbackModel: {
        provider: "gemini",
        modelId: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
      },
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: false, error: "Claude down" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, text: "gemini result" }),
      });

    const ctx = makeCtx(node);
    await expect(executeLlmGenerate(ctx)).rejects.toThrow("Claude down");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
