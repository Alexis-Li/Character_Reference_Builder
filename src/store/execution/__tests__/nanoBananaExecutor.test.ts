import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeNanoBanana } from "../nanoBananaExecutor";
import { useWorkflowStore } from "@/store/workflowStore";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode } from "@/types";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock calculateGenerationCost
vi.mock("@/utils/costCalculator", () => ({
  calculateGenerationCost: vi.fn().mockReturnValue(0.05),
}));

function makeNode(data: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: "gen-1",
    type: "nanoBanana",
    position: { x: 0, y: 0 },
    data: {
      outputImage: null,
      inputImages: [],
      inputPrompt: null,
      status: null,
      error: null,
      aspectRatio: "1:1",
      resolution: "1024x1024",
      model: "nano-banana",
      useGoogleSearch: false,
      useImageSearch: false,
      selectedModel: { provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana" },
      parameters: {},
      imageHistory: [],
      selectedHistoryIndex: 0,
      ...data,
    },
  } as WorkflowNode;
}

const defaultProviderSettings = {
  providers: {
    gemini: { apiKey: "" },
    replicate: { apiKey: "" },
    fal: { apiKey: "" },
    kie: { apiKey: "" },
    wavespeed: { apiKey: "" },
    openai: { apiKey: "" },
  },
} as any;

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
      text: "test prompt",
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
    get: vi.fn().mockReturnValue({
      edges: [],
      nodes: [node],
      addToGlobalHistory: vi.fn(),
      addIncurredCost: vi.fn(),
      generationsPath: null,
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeNanoBanana", () => {
  it("should throw when no text input is provided", async () => {
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

    await expect(executeNanoBanana(ctx)).rejects.toThrow("Missing text input");

    expect(ctx.updateNodeData).toHaveBeenCalledWith("gen-1", {
      status: "error",
      error: "Missing text input",
    });
  });

  it("should set loading status before API call", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    // Check that loading was set
    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const loadingCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "loading"
    );
    expect(loadingCall).toBeDefined();
  });

  it("should call /api/generate with correct payload", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/generate",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"prompt":"test prompt"'),
      })
    );
  });

  it("should update node with result on success", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const completeCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "complete"
    );
    expect(completeCall).toBeDefined();
    expect((completeCall![1] as Record<string, unknown>).outputImage).toBe("data:image/png;base64,result");
  });

  it("should add to global history on success", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    expect(ctx.addToGlobalHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "data:image/png;base64,result",
        prompt: "test prompt",
      })
    );
  });

  it("should track cost for gemini provider", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    expect(ctx.addIncurredCost).toHaveBeenCalledWith(0.05);
  });

  it("should track cost for fal provider", async () => {
    const node = makeNode({
      selectedModel: { provider: "fal", modelId: "fal-model", displayName: "Fal", pricing: { amount: 0.10 } },
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    const ctx = makeCtx(node, {
      getFreshNode: vi.fn().mockReturnValue(node),
    });
    await executeNanoBanana(ctx);

    expect(ctx.addIncurredCost).toHaveBeenCalledWith(0.10);
  });

  it("should throw on HTTP error", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve('{"error": "Server exploded"}'),
    });

    const ctx = makeCtx(node);
    await expect(executeNanoBanana(ctx)).rejects.toThrow("Server exploded");

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const errorCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "error"
    );
    expect(errorCall).toBeDefined();
  });

  it("should throw on API failure (success=false)", async () => {
    const node = makeNode();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: false, error: "Bad prompt" }),
    });

    const ctx = makeCtx(node);
    await expect(executeNanoBanana(ctx)).rejects.toThrow("Bad prompt");
  });

  it("should use text from dynamicInputs.prompt when no direct text", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: null,
        dynamicInputs: { prompt: "dynamic prompt" },
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    await executeNanoBanana(ctx);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/generate",
      expect.objectContaining({
        body: expect.stringContaining('"prompt":"dynamic prompt"'),
      })
    );
  });

  it("should pass images in request payload", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,img1"],
        videos: [],
        audio: [],
        text: "with image",
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    await executeNanoBanana(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.images).toEqual(["data:image/png;base64,img1"]);
  });

  it("should fall back to stored inputs in regenerate mode", async () => {
    const node = makeNode({
      inputImages: ["stored-img.png"],
      inputPrompt: "stored prompt",
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
    // Enable regenerate mode: fallback to stored inputs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    await executeNanoBanana(ctx, { useStoredFallback: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.images).toEqual(["stored-img.png"]);
    expect(body.prompt).toBe("stored prompt");
  });

  it("should push to downstream outputGallery nodes", async () => {
    const node = makeNode();
    const galleryNode = {
      id: "gal-1",
      type: "outputGallery",
      data: { images: ["old.png"] },
    } as WorkflowNode;

    const ctx = makeCtx(node, {
      getEdges: vi.fn().mockReturnValue([
        { id: "e1", source: "gen-1", target: "gal-1" },
      ]),
      getNodes: vi.fn().mockReturnValue([node, galleryNode]),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    await executeNanoBanana(ctx);

    expect(ctx.appendOutputGalleryImage).toHaveBeenCalledWith("gal-1", "data:image/png;base64,result");
  });

  it("falls back on primary failure and stamps metadata", async () => {
    const node = makeNode({
      fallbackModel: {
        provider: "replicate",
        modelId: "flux-dev",
        displayName: "Flux Dev",
      },
    });

    // Primary fails, fallback succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: false, error: "Primary boom" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, image: "data:image/png;base64,fallback" }),
      });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second fetch should carry the fallback model
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondBody.selectedModel.modelId).toBe("flux-dev");

    // Metadata stamp should be present in the final updateNodeData call
    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const stampCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).__usedFallback === true
    );
    expect(stampCall).toBeDefined();
    expect((stampCall![1] as Record<string, unknown>).__fallbackModelUsed).toBe("Flux Dev");
    expect((stampCall![1] as Record<string, unknown>).__primaryError).toBe("Primary boom");
  });

  it("sends declared edge roles verbatim and persists the server record", async () => {
    const node = makeNode({ modelSource: "project-default" });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,one", "data:image/png;base64,two"],
        imageRefs: [
          { image: "data:image/png;base64,one", role: "retained-view", edgeId: "e1", sourceNodeId: "original" },
          { image: "data:image/png;base64,two", role: "target", edgeId: "e2", sourceNodeId: "gen" },
        ],
        videos: [],
        audio: [],
        text: "keep the front view",
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    const serverCall = {
      at: 1234, provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana",
      resolvedFrom: "project-default", declared: true, referenceCount: 2,
      purposes: ["retained-view", "target"], purposeSource: "declared",
      hasMask: false, auth: "api-key", stage: "succeeded",
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result", call: serverCall }),
    });

    await executeNanoBanana(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toBe("keep the front view");
    // Roles follow the declared edges, not array position.
    expect(body.references).toEqual([
      { image: "data:image/png;base64,one", purpose: "retained-view" },
      { image: "data:image/png;base64,two", purpose: "target" },
    ]);
    expect(body.images).toEqual(["data:image/png;base64,one", "data:image/png;base64,two"]);
    expect(body.modelSource).toBe("project-default");

    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const completeCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "complete"
    );
    // The server record is persisted verbatim — never relabeled client-side.
    expect((completeCall![1] as Record<string, unknown>).lastCall).toEqual(serverCall);
  });

  it("leaves role-less inputs purposeless instead of inventing roles", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,one", "data:image/png;base64,two"],
        videos: [],
        audio: [],
        text: "legacy prompt",
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, image: "data:image/png;base64,result" }),
    });

    await executeNanoBanana(ctx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.references).toEqual([
      { image: "data:image/png;base64,one" },
      { image: "data:image/png;base64,two" },
    ]);
    expect(body.modelSource).toBe("node-legacy");

    // A non-contract provider omits the record: the previous value is kept
    // (here absent), not fabricated.
    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const completeCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "complete"
    );
    expect("lastCall" in ((completeCall![1] as Record<string, unknown>))).toBe(false);
  });

  it("leaves lastCall untouched when pre-submit rejects without a record", async () => {
    const node = makeNode();
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: ["data:image/png;base64,one"],
        videos: [],
        audio: [],
        text: "prompt",
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: () => Promise.resolve(JSON.stringify({ success: false, error: "Capability gaps must be resolved before submission" })),
    });

    await expect(executeNanoBanana(ctx)).rejects.toThrow();
    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const errorCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "error"
    );
    // Absence of a server record means no submission: nothing is written.
    expect("lastCall" in ((errorCall![1] as Record<string, unknown>))).toBe(false);
  });

  it("persists submitted-failure records returned by the server", async () => {
    const node = makeNode({ modelSource: "node-override" });
    const ctx = makeCtx(node, {
      getConnectedInputs: vi.fn().mockReturnValue({
        images: [],
        videos: [],
        audio: [],
        text: "prompt",
        dynamicInputs: {},
        easeCurve: null,
      }),
    });
    const serverCall = {
      at: 1234, provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana",
      resolvedFrom: "node-override", declared: true, referenceCount: 0,
      purposes: null, purposeSource: "none",
      hasMask: false, auth: "api-key", stage: "failed",
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(JSON.stringify({ success: false, error: "No response from AI model", call: serverCall })),
    });

    await expect(executeNanoBanana(ctx)).rejects.toThrow();
    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const errorCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "error"
    );
    expect((errorCall![1] as Record<string, unknown>).lastCall).toEqual(serverCall);
  });

  it("sends node-override for fallback serving and persists its record", async () => {
    const node = makeNode({
      modelSource: "project-default",
      fallbackModel: { provider: "openai", modelId: "gpt-image-1", displayName: "GPT Image 1" },
    });
    const primaryCall = {
      at: 1, provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana",
      resolvedFrom: "project-default", declared: true, referenceCount: 0,
      purposes: null, purposeSource: "none",
      hasMask: false, auth: "api-key", stage: "failed",
    };
    const fallbackCall = {
      at: 2, provider: "openai", modelId: "gpt-image-1", displayName: "GPT Image 1",
      resolvedFrom: "node-override", declared: true, referenceCount: 0,
      purposes: null, purposeSource: "none",
      hasMask: false, auth: "api-key", stage: "succeeded",
    };
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({ success: false, error: "Primary boom", call: primaryCall })),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, image: "data:image/png;base64,fallback", call: fallbackCall }),
      });

    const ctx = makeCtx(node);
    await executeNanoBanana(ctx);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).modelSource).toBe("project-default");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).modelSource).toBe("node-override");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).selectedModel.modelId).toBe("gpt-image-1");
    const calls = (ctx.updateNodeData as ReturnType<typeof vi.fn>).mock.calls;
    const completeCall = calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).status === "complete"
    );
    expect((completeCall![1] as Record<string, unknown>).lastCall).toEqual(fallbackCall);
  });

  it("P01 topology: refine carries declared original/candidate roles, not positions", async () => {
    const ORIGINAL = "data:image/png;base64,b3JpZ2luYWw";
    const FRONT = "data:image/png;base64,ZnJvbnQ";
    const REVISED = "data:image/png;base64,cmV2aXNlZA";
    const asNode = (id: string, type: string, data: Record<string, unknown>) =>
      ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowNode;
    const nanoData = (extra: Record<string, unknown> = {}) => ({
      inputImages: [],
      inputPrompt: null,
      outputImage: null,
      status: null,
      error: null,
      aspectRatio: "1:1",
      resolution: "1024x1024",
      model: "nano-banana",
      selectedModel: { provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana" },
      modelSource: "project-default",
      useGoogleSearch: false,
      useImageSearch: false,
      parameters: {},
      imageHistory: [],
      selectedHistoryIndex: 0,
      ...extra,
    });
    useWorkflowStore.setState({
      nodes: [
        asNode("original", "imageInput", { image: ORIGINAL }),
        asNode("prompt", "prompt", { prompt: "Generate the shoulder plate." }),
        asNode("gen", "nanoBanana", nanoData({ outputImage: FRONT })),
        asNode("correction", "prompt", { prompt: "Restore the two fasteners." }),
        asNode("refine", "nanoBanana", nanoData()),
      ],
      edges: [
        // The declared business roles travel on the edges into refine: the
        // original is the retained design basis, the candidate is the target.
        // Edge order here deliberately puts the retained view FIRST, so a
        // positional guess (first = target) would mislabel both inputs.
        { id: "e-or", source: "original", target: "refine", sourceHandle: "image", targetHandle: "image", data: { referenceRole: "retained-view" } },
        { id: "e-gr", source: "gen", target: "refine", sourceHandle: "image", targetHandle: "image", data: { referenceRole: "target" } },
        { id: "e-cr", source: "correction", target: "refine", sourceHandle: "text", targetHandle: "text", data: {} },
      ],
    });
    // Emulated /api/generate: builds the server record the way the route
    // adapters do (actual transport facts, declared roles verbatim).
    mockFetch.mockImplementation(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const refs = body.references as Array<{ image: string; purpose?: string }>;
      const declared = refs.length > 0 && refs.every((r) => typeof r.purpose === "string");
      return {
        ok: true,
        json: async () => ({
          success: true,
          image: REVISED,
          call: {
            at: 7,
            provider: body.selectedModel.provider,
            modelId: body.selectedModel.modelId,
            displayName: body.selectedModel.displayName,
            resolvedFrom: body.modelSource ?? "node-legacy",
            declared: true,
            referenceCount: refs.length,
            purposes: declared ? refs.map((r) => r.purpose) : null,
            purposeSource: refs.length === 0 ? "none" : declared ? "declared" : "legacy",
            hasMask: false,
            auth: "api-key",
            stage: "succeeded",
          },
        }),
      };
    });
    const store = useWorkflowStore.getState();
    const refineCtx = {
      node: store.nodes.find((n) => n.id === "refine")!,
      getConnectedInputs: store.getConnectedInputs,
      updateNodeData: store.updateNodeData,
      getFreshNode: (key: string) => useWorkflowStore.getState().nodes.find((n) => n.id === key),
      getNodes: () => useWorkflowStore.getState().nodes,
      getEdges: () => useWorkflowStore.getState().edges,
      providerSettings: store.providerSettings,
      addIncurredCost: vi.fn(),
      addToGlobalHistory: vi.fn(),
      generationsPath: null,
      saveDirectoryPath: null,
      trackSaveGeneration: vi.fn(),
      appendOutputGalleryImage: vi.fn(),
    } as unknown as NodeExecutionContext;

    await executeNanoBanana(refineCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Declared roles survive in edge order — NOT positional mapping.
    expect(body.references).toEqual([
      { image: ORIGINAL, purpose: "retained-view" },
      { image: FRONT, purpose: "target" },
    ]);
    expect(body.modelSource).toBe("project-default");
    const lastCall = (useWorkflowStore.getState().nodes.find((n) => n.id === "refine")!.data as { lastCall: Record<string, unknown> }).lastCall;
    expect(lastCall.purposes).toEqual(["retained-view", "target"]);
    expect(lastCall.purposeSource).toBe("declared");
    expect(lastCall.resolvedFrom).toBe("project-default");
    useWorkflowStore.getState().clearWorkflow();
  });
});
