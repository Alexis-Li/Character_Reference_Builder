/**
 * CRB-02 store integration: the character-project contract drives real runs.
 * Covers rerun-append/select-pin/explicit-reselect/downstream, double-failure
 * retention, >50-run truncation safety, and save/load round-trip at the
 * highest observable store boundary. No generations folder is configured, so
 * selectability must come from the session cache, never disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import { executeNanoBanana } from "../execution/nanoBananaExecutor";
import { readSessionMedia } from "../execution/sessionMedia";
import type { WorkflowNode, WorkflowEdge } from "@/types";

// Mock the Toast hook
vi.mock("@/components/Toast", () => ({
  useToast: {
    getState: () => ({
      show: vi.fn(),
    }),
  },
}));

// Mock the logger
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));

const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockLocalStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
  }),
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const FRONT = "data:image/png;base64,aW50ZWdyYXRpb24tZnJvbnQ";
const REVISED = "data:image/png;base64,aW50ZWdyYXRpb24tcmV2aXNlZA";
const ORIG_A = "data:image/png;base64,b3JpZ2luLWE";
const ORIG_B = "data:image/png;base64,b3JpZ2luLWI";

function node(id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], position: { x: 0, y: 0 }, data: data as WorkflowNode["data"] };
}

function nanoData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...extra,
  };
}

function edge(source: string, target: string, handle: string): WorkflowEdge {
  return { id: `${source}-${target}-${handle}`, source, target, sourceHandle: handle, targetHandle: handle };
}

function seedTwoParts(): void {
  useWorkflowStore.setState({
    nodes: [
      node("img-a", "imageInput", { image: ORIG_A }),
      node("img-b", "imageInput", { image: ORIG_B }),
      node("prompt-1", "prompt", { prompt: "Generate only the belt; preserve two fasteners." }),
      node("gen", "nanoBanana", nanoData()),
      node("gen2", "nanoBanana", nanoData()),
      node("consumer", "nanoBanana", nanoData()),
    ],
    edges: [
      edge("img-a", "gen", "image"),
      edge("prompt-1", "gen", "text"),
      edge("gen", "consumer", "image"),
      edge("img-b", "gen2", "image"),
      edge("prompt-1", "gen2", "text"),
    ],
  });
}

function genNode(id = "gen"): WorkflowNode {
  return useWorkflowStore.getState().nodes.find((n) => n.id === id)!;
}

function genData(id = "gen"): Record<string, unknown> {
  return genNode(id).data as unknown as Record<string, unknown>;
}

async function run(id = "gen"): Promise<void> {
  const store = useWorkflowStore.getState();
  await executeNanoBanana(store._buildExecutionContext(genNode(id)));
}

const ok = (image: string) => ({ ok: true, json: async () => ({ success: true, image }) });

let now = 0;
const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));

beforeEach(() => {
  useWorkflowStore.getState().clearWorkflow();
  vi.clearAllMocks();
  now = 1_000_000;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => {
    throw new Error("Unexpected mock request");
  });
});

afterEach(() => {
  useWorkflowStore.getState().clearWorkflow();
});

describe("character project store integration", () => {
  it("rerun appends, selection pins, and explicit reselect moves downstream without disk", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT));
    await run();
    const firstId = (genData().imageHistory as Array<{ id: string }>)[0].id;
    expect(genData().outputImage).toBe(FRONT);
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({ "gen@default": firstId });

    mockFetch.mockResolvedValueOnce(ok(REVISED));
    await run();
    const history = genData().imageHistory as Array<{ id: string }>;
    expect(history).toHaveLength(2);
    const secondId = history[0].id;
    // Rerun kept the pinned selection.
    expect(genData().outputImage).toBe(FRONT);
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({ "gen@default": firstId });

    // The fresh candidate is loadable with no generations folder configured.
    expect(useWorkflowStore.getState().generationsPath).toBeNull();
    expect(readSessionMedia(secondId)).toBe(REVISED);

    // User picks the new candidate: node and contract move together.
    useWorkflowStore.getState().updateNodeData("gen", {
      outputImage: REVISED,
      selectedHistoryIndex: 0,
      selectedHistoryId: secondId,
      status: "idle",
      error: null,
    });
    useWorkflowStore.getState().selectNodeCandidate("gen", secondId);
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({ "gen@default": secondId });
    const downstream = useWorkflowStore.getState().getConnectedInputs("consumer");
    expect(downstream.images[0]).toBe(REVISED);
  });

  it("failed primary and fallback keep the selection and record the failures", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT));
    await run();
    useWorkflowStore.setState({
      nodes: useWorkflowStore.getState().nodes.map((n) =>
        n.id === "gen"
          ? {
              ...n,
              data: {
                ...n.data,
                fallbackModel: { provider: "openai", modelId: "probe-image", displayName: "Probe fallback" },
              },
            }
          : n,
      ),
    });
    mockFetch.mockRejectedValue(new Error("upstream unavailable"));
    await expect(run()).rejects.toThrow();
    expect(genData().outputImage).toBe(FRONT);
    const project = useWorkflowStore.getState().characterProject!;
    expect(project.candidates).toHaveLength(1);
    expect(project.runs.filter((r) => r.status === "failed").length).toBeGreaterThanOrEqual(1);
    expect(project.selection).toEqual({ "gen@default": project.candidates[0].id });
  });

  it("keeps the oldest selection across 55 runs and round-trips save/load", async () => {
    seedTwoParts();
    let seq = 0;
    mockFetch.mockImplementation(async () => ok(`data:image/png;base64,cnVuLS${seq++}`));
    await run();
    const oldestId = (genData().imageHistory as Array<{ id: string }>)[0].id;
    const oldestImage = genData().outputImage;
    for (let i = 0; i < 54; i++) {
      await run();
    }
    const history = genData().imageHistory as Array<{ id: string }>;
    expect(history.map((h) => h.id)).toContain(oldestId);
    expect(history).toHaveLength(51);
    expect(genData().outputImage).toBe(oldestImage);
    expect(genData().selectedHistoryId).toBe(oldestId);
    expect(genData().selectedHistoryIndex).toBe(history.findIndex((h) => h.id === oldestId));

    const store = useWorkflowStore.getState();
    const payload = {
      version: 1 as const,
      name: "crb-02-roundtrip",
      nodes: store.nodes.map(({ selected, ...rest }) => rest),
      edges: store.edges,
      edgeStyle: store.edgeStyle,
      characterProject: store.characterProject ?? undefined,
    };
    store.clearWorkflow();
    expect(useWorkflowStore.getState().characterProject).toBeNull();
    await useWorkflowStore.getState().loadWorkflow(payload);
    const reopened = useWorkflowStore.getState();
    expect(reopened.characterProject?.selection).toEqual({ "gen@default": oldestId });
    expect(reopened.characterProject?.candidates.map((c) => c.id)).toContain(oldestId);
    expect((reopened.nodes.find((n) => n.id === "gen")!.data as unknown as Record<string, unknown>).outputImage).toBe(
      oldestImage,
    );
    expect(
      (reopened.nodes.find((n) => n.id === "gen")!.data as unknown as Record<string, unknown>).selectedHistoryId,
    ).toBe(oldestId);
    expect(readSessionMedia(oldestId)).toBeNull();
  });

  it("reference updates isolate parts and lock updates stay atomic from store entries", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT)).mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    await run("gen2");
    const store = useWorkflowStore.getState();
    const genCand = store.characterProject!.candidates.find((c) => c.partId === "gen")!;
    const gen2Cand = store.characterProject!.candidates.find((c) => c.partId === "gen2")!;
    expect(genCand.referenceIds).toEqual(["ref:img-a"]);
    expect(gen2Cand.referenceIds).toEqual(["ref:img-b"]);
    store.selectNodeCandidate("gen", genCand.id);
    store.selectNodeCandidate("gen2", gen2Cand.id);

    const affectedRef = store.markCharacterUpstreamStale(["ref:img-a"], "img-a replaced");
    expect(affectedRef).toEqual([genCand.id]);
    const afterRef = useWorkflowStore.getState().characterProject!;
    expect(afterRef.candidates.find((c) => c.id === genCand.id)?.review).toBe("stale");
    expect(afterRef.runs).toHaveLength(2);

    // Re-review the stale candidate, then change a project-wide lock: both
    // parts inherit it, so both selections go stale atomically with no runs.
    useWorkflowStore.getState().selectNodeCandidate("gen", genCand.id);
    const affectedLock = useWorkflowStore.getState().updateCharacterLocks(
      [{ id: "lock-layers", description: "skirt keeps three layers" }],
      "first lock",
    );
    expect(affectedLock.sort()).toEqual([genCand.id, gen2Cand.id].sort());
    expect(useWorkflowStore.getState().characterProject!.runs).toHaveLength(2);
  });

  it("legacy files without a project stay explicitly empty", async () => {
    seedTwoParts();
    await useWorkflowStore.getState().loadWorkflow({
      version: 1,
      name: "legacy",
      nodes: useWorkflowStore.getState().nodes,
      edges: useWorkflowStore.getState().edges,
      edgeStyle: "angular",
    });
    expect(useWorkflowStore.getState().characterProject).toBeNull();
  });
});

void nowSpy;
