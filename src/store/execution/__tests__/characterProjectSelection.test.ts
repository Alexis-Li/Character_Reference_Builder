/**
 * CRB-02 executor regression: runs append candidates, the selected result is
 * stable. Covers the P06/P07 gaps plus success, failure, and reselection at
 * the highest observable boundary of the image generation path.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { executeNanoBanana } from "../nanoBananaExecutor";
import type { NodeExecutionContext } from "../types";
import type { WorkflowNode } from "@/types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/utils/costCalculator", () => ({
  calculateGenerationCost: vi.fn().mockReturnValue(0),
}));

const FRONT = "data:image/png;base64,c2VsZWN0ZWQtZnJvbnQ";
const REVISED = "data:image/png;base64,cmV2aXNlZC1mcm9udA";

function makeHarness(data: Record<string, unknown> = {}) {
  let state: Record<string, unknown> = {
    inputImages: [],
    inputPrompt: null,
    outputImage: null,
    status: null,
    error: null,
    aspectRatio: "1:1",
    resolution: "1024x1024",
    model: "nano-banana",
    selectedModel: { provider: "gemini", modelId: "nano-banana", displayName: "Probe primary" },
    parameters: {},
    imageHistory: [],
    selectedHistoryIndex: 0,
    ...data,
  };
  const node = { id: "gen", type: "nanoBanana", position: { x: 0, y: 0 }, data: state } as WorkflowNode;
  const updateNodeData = vi.fn((id: string, patch: Record<string, unknown>) => {
    state = { ...state, ...patch };
    node.data = state as WorkflowNode["data"];
  });
  const ctx = {
    node,
    getConnectedInputs: vi.fn().mockReturnValue({
      images: [],
      videos: [],
      audio: [],
      text: "Generate only the belt; preserve three fasteners.",
      dynamicInputs: {},
      easeCurve: null,
    }),
    updateNodeData,
    getFreshNode: vi.fn().mockReturnValue(node),
    getEdges: vi.fn().mockReturnValue([]),
    getNodes: vi.fn().mockReturnValue([node]),
    providerSettings: { providers: {} },
    addIncurredCost: vi.fn(),
    addToGlobalHistory: vi.fn(),
    generationsPath: null,
    saveDirectoryPath: null,
    trackSaveGeneration: vi.fn(),
    appendOutputGalleryImage: vi.fn(),
    get: vi.fn(),
  } as unknown as NodeExecutionContext;
  return { ctx, get: () => state };
}
const ok = (image: string) => ({ ok: true, json: async () => ({ success: true, image }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => {
    throw new Error("Unexpected mock request");
  });
});

describe("CRB-02 selection-preserving image runs", () => {
  it("P07: successful rerun appends a candidate without replacing the selection", async () => {
    const { ctx, get } = makeHarness({ outputImage: FRONT });
    mockFetch.mockResolvedValueOnce(ok(REVISED));
    await executeNanoBanana(ctx);
    expect(get().outputImage).toBe(FRONT);
    expect(get().status).toBe("complete");
    expect((get().imageHistory as unknown[])).toHaveLength(1);
  });

  it("P06: failed primary and fallback keep the previously selected output", async () => {
    const { ctx, get } = makeHarness({
      outputImage: FRONT,
      fallbackModel: { provider: "openai", modelId: "probe-image", displayName: "Probe fallback" },
    });
    mockFetch.mockRejectedValue(new Error("upstream unavailable"));
    await expect(executeNanoBanana(ctx)).rejects.toThrow();
    expect(get().outputImage).toBe(FRONT);
    expect(get().imageHistory).toEqual([]);
  });

  it("first success fills the empty selection once", async () => {
    const { ctx, get } = makeHarness();
    mockFetch.mockResolvedValueOnce(ok(FRONT));
    await executeNanoBanana(ctx);
    expect(get().outputImage).toBe(FRONT);
    expect(get().selectedHistoryIndex).toBe(0);
    expect((get().imageHistory as unknown[])).toHaveLength(1);
  });

  it("failed rerun without fallback keeps output and history", async () => {
    const history = [{ id: "h1", timestamp: 1, prompt: "p", aspectRatio: "1:1", model: "nano-banana" }];
    const { ctx, get } = makeHarness({ outputImage: FRONT, imageHistory: history, selectedHistoryIndex: 0 });
    mockFetch.mockRejectedValueOnce(new TypeError("NetworkError: response lost"));
    await expect(executeNanoBanana(ctx)).rejects.toThrow();
    expect(get().outputImage).toBe(FRONT);
    expect(get().imageHistory).toEqual(history);
    expect(get().selectedHistoryIndex).toBe(0);
  });

  it("reselection via carousel survives the next successful run", async () => {
    const history = [
      { id: "h-new", timestamp: 2, prompt: "p", aspectRatio: "1:1", model: "nano-banana" },
      { id: "h-old", timestamp: 1, prompt: "p", aspectRatio: "1:1", model: "nano-banana" },
    ];
    const RESELECTED = "data:image/png;base64,cmVzZWxlY3RlZA";
    const { ctx, get } = makeHarness({
      outputImage: RESELECTED,
      imageHistory: history,
      selectedHistoryIndex: 1,
    });
    mockFetch.mockResolvedValueOnce(ok(REVISED));
    await executeNanoBanana(ctx);
    // The user's explicit choice still stands; the run only appended.
    expect(get().outputImage).toBe(RESELECTED);
    expect((get().imageHistory as unknown[])).toHaveLength(3);
    expect(get().selectedHistoryIndex).toBe(2);
  });
});
