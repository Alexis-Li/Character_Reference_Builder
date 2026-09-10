/** Requirement probes against the pinned upstream snapshot. All cloud calls are mocked. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import { executeNanoBanana } from "@/store/execution/nanoBananaExecutor";
import { generateWithOpenAI } from "@/app/api/generate/providers/openai";
import type { NodeExecutionContext } from "@/store/execution/types";
import type { WorkflowNode, WorkflowEdge } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/utils/logger", () => ({ logger: {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  startSession: vi.fn(), endSession: vi.fn(), getCurrentSession: () => null,
} }));

const image = (value: string) => `data:image/png;base64,${btoa(value)}`;
const original = image("synthetic-original");
const front = image("synthetic-front");
const revised = image("synthetic-revised");
const fetchMock = vi.fn();
const model = { provider: "gemini", modelId: "nano-banana", displayName: "Probe primary" };
const alternate = { provider: "openai", modelId: "probe-image", displayName: "Probe fallback" };
const node = (id: string, type: string, data: object): WorkflowNode => ({
  id, type, position: { x: 0, y: 0 }, data,
}) as WorkflowNode;
const edge = (source: string, target: string, handle: string): WorkflowEdge => ({
  id: `${source}-${target}`, source, target, sourceHandle: handle, targetHandle: handle,
});
function generator(id = "gen", extra = {}) {
  return node(id, "nanoBanana", {
    inputImages: [], inputPrompt: null, outputImage: null, status: null, error: null,
    aspectRatio: "1:1", resolution: "1024x1024", model: "nano-banana",
    selectedModel: model, parameters: {}, imageHistory: [], selectedHistoryIndex: 0,
    ...extra,
  });
}
function setup(extra = {}) {
  useWorkflowStore.setState({ nodes: [node("original", "imageInput", { image: original }),
    node("prompt", "prompt", { prompt: "Generate only the character's left shoulder plate; preserve two fasteners." }),
    generator("gen", extra)], edges: [edge("original", "gen", "image"), edge("prompt", "gen", "text")] });
}
function context(id = "gen"): NodeExecutionContext {
  const store = useWorkflowStore.getState();
  return {
    node: store.nodes.find(n => n.id === id)!,
    getConnectedInputs: store.getConnectedInputs,
    updateNodeData: store.updateNodeData,
    getFreshNode: (key) => useWorkflowStore.getState().nodes.find(n => n.id === key),
    getNodes: () => useWorkflowStore.getState().nodes,
    getEdges: () => useWorkflowStore.getState().edges,
    providerSettings: store.providerSettings,
    addIncurredCost: vi.fn(), addToGlobalHistory: store.addToGlobalHistory,
    generationsPath: null, saveDirectoryPath: null, trackSaveGeneration: vi.fn(),
    appendOutputGalleryImage: vi.fn(), get: useWorkflowStore.getState,
  } as NodeExecutionContext;
}
const output = (id = "gen") => useWorkflowStore.getState().nodes.find(n => n.id === id)!.data.outputImage;
const success = (value: string) => ({ ok: true, json: async () => ({ success: true, image: value }) });

beforeEach(() => {
  useWorkflowStore.getState().clearWorkflow();
  vi.clearAllMocks();
  fetchMock.mockReset();
  // Unexpected requests fail closed; no external endpoint is ever contacted.
  fetchMock.mockImplementation(async () => { throw new Error("Unexpected mock request"); });
  vi.stubGlobal("fetch", fetchMock);
});

describe("CRB minimum-loop engineering probes (not model-quality acceptance)", () => {
  it("P01: original + target -> candidate -> refinement retains original and candidate inputs", async () => {
    setup();
    fetchMock.mockResolvedValueOnce(success(front)).mockResolvedValueOnce(success(revised));
    await executeNanoBanana(context());
    const state = useWorkflowStore.getState();
    useWorkflowStore.setState({ nodes: [...state.nodes, generator("refine"),
      node("correction", "prompt", { prompt: "Restore the two fasteners; preserve the original outline." })],
    edges: [...state.edges, edge("original", "refine", "image"), edge("gen", "refine", "image"), edge("correction", "refine", "text")] });
    await executeNanoBanana(context("refine"));
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.images).toEqual([original, front]);
    expect(output()).toBe(front);
    expect(output("refine")).toBe(revised);
  });

  it("P02: failed rerun without fallback retains existing output and makes one attempt", async () => {
    setup({ outputImage: front });
    fetchMock.mockRejectedValueOnce(new TypeError("NetworkError: response lost"));
    await expect(executeNanoBanana(context())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output()).toBe(front);
  });

  it("P03: workflow JSON export/reload retains separate branch images without submitting generation", async () => {
    setup({ outputImage: front });
    useWorkflowStore.setState({ nodes: [...useWorkflowStore.getState().nodes, generator("refine", { outputImage: revised })] });
    let exported: Blob | undefined;
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL(blob: Blob) { exported = blob; return "blob:probe"; }
      static revokeObjectURL() {}
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    useWorkflowStore.getState().saveWorkflow("crb-probe");
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject; reader.readAsText(exported!);
    });
    useWorkflowStore.getState().clearWorkflow();
    await useWorkflowStore.getState().loadWorkflow(JSON.parse(text));
    expect(output()).toBe(front);
    expect(output("refine")).toBe(revised);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("P04 REQUIREMENT: OpenAI adapter must send both original and retained-view reference", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: btoa("result") }] }) });
    await generateWithOpenAI("probe", "dummy-not-a-key", {
      model: { id: "probe-image", name: "Probe model" }, prompt: "Preserve retained front while revising back",
      images: [original, front], parameters: {},
    } as any);
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const images = [...body.entries()].filter(([key]) => key === "image" || key === "image[]");
    expect(images).toHaveLength(2);
  });

  it("P05 REQUIREMENT: unknown request outcome must not automatically invoke fallback", async () => {
    setup({ outputImage: front, fallbackModel: alternate });
    fetchMock.mockRejectedValueOnce(new TypeError("NetworkError: response lost"))
      .mockResolvedValueOnce(success(revised));
    try { await executeNanoBanana(context()); } catch { /* Expected pause/failure is acceptable. */ }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("P06 REQUIREMENT: failed primary and fallback must retain previously selected output", async () => {
    setup({ outputImage: front, fallbackModel: alternate });
    fetchMock.mockRejectedValue(new Error("upstream unavailable"));
    await expect(executeNanoBanana(context())).rejects.toThrow();
    expect(output()).toBe(front);
  });

  it("P07 REQUIREMENT: successful rerun must not silently replace the previously chosen result", async () => {
    setup({ outputImage: front });
    fetchMock.mockResolvedValueOnce(success(revised));
    await executeNanoBanana(context());
    expect(output()).toBe(front);
  });
});
