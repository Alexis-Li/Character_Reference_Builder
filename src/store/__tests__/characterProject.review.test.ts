/**
 * CRB-02 review regression: the five remaining blockers from the second
 * acceptance pass, tested through real store write paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useWorkflowStore } from "../workflowStore";
import { executeNanoBanana } from "../execution/nanoBananaExecutor";
import {
  clearSessionMedia,
  readSessionMedia,
  rememberSessionMedia,
} from "../execution/sessionMedia";
import {
  adoptCandidate,
  createCharacterProject,
  definePart,
  newCharacterId,
  recordSuccessfulRun,
  renameCandidate,
  selectCandidate,
  setCandidateAsset,
  updateProjectLocks,
  type CharacterProject,
} from "@/lib/characterProject";
import type { WorkflowNode, WorkflowEdge } from "@/types";

vi.mock("@/components/Toast", () => ({
  useToast: {
    getState: () => ({
      show: vi.fn(),
    }),
  },
}));

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
const ORIG_A2 = "data:image/png;base64,b3JpZ2luLWEtdjI";

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

beforeEach(() => {
  useWorkflowStore.getState().clearWorkflow();
  clearSessionMedia();
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => {
    throw new Error("Unexpected mock request");
  });
});

afterEach(() => {
  useWorkflowStore.getState().clearWorkflow();
  clearSessionMedia();
});

describe("review blocker 1: real upstream writes mark related stale", () => {
  it("replacing the image bytes through updateNodeData stales only that source", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT)).mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    await run("gen2");
    const store = useWorkflowStore.getState();
    const genCand = store.characterProject!.candidates.find((c) => c.partId === "gen")!;
    const gen2Cand = store.characterProject!.candidates.find((c) => c.partId === "gen2")!;
    store.selectNodeCandidate("gen", genCand.id);
    store.selectNodeCandidate("gen2", gen2Cand.id);

    useWorkflowStore.getState().updateNodeData("img-a", { image: ORIG_A2 });

    const after = useWorkflowStore.getState().characterProject!;
    expect(after.candidates.find((c) => c.id === genCand.id)?.review).toBe("stale");
    expect(after.candidates.find((c) => c.id === gen2Cand.id)?.review).toBe("selected");
    expect(after.runs).toHaveLength(2);
  });

  it("rewiring into a generation node stales that part and leaves others alone", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT)).mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    await run("gen2");
    const store = useWorkflowStore.getState();
    const genCand = store.characterProject!.candidates.find((c) => c.partId === "gen")!;
    const gen2Cand = store.characterProject!.candidates.find((c) => c.partId === "gen2")!;
    store.selectNodeCandidate("gen", genCand.id);
    store.selectNodeCandidate("gen2", gen2Cand.id);

    useWorkflowStore.getState().onConnect({ source: "img-b", target: "gen2", sourceHandle: "default", targetHandle: "image" });

    const afterConnect = useWorkflowStore.getState().characterProject!;
    expect(afterConnect.candidates.find((c) => c.id === gen2Cand.id)?.review).toBe("stale");
    expect(afterConnect.candidates.find((c) => c.id === genCand.id)?.review).toBe("selected");

    const edgeId = useWorkflowStore.getState().edges.find((e) => e.source === "img-a" && e.target === "gen")!.id;
    useWorkflowStore.getState().removeEdge(edgeId);
    const afterRemove = useWorkflowStore.getState().characterProject!;
    expect(afterRemove.candidates.find((c) => c.id === genCand.id)?.review).toBe("stale");
  });
});

describe("review blocker 3: candidate identity never merges", () => {
  it("renaming onto an existing id keeps both candidates and both runs", () => {
    let project = createCharacterProject("char-1", 0);
    project = definePart(project, { id: "belt", name: "Belt", requirements: [], correctionHistory: [] });
    project = recordSuccessfulRun(project, {
      runId: "run-1",
      partId: "belt",
      view: "front",
      outputs: [{ candidateId: "c1", referenceIds: [] }],
    });
    project = recordSuccessfulRun(project, {
      runId: "run-2",
      partId: "belt",
      view: "front",
      outputs: [{ candidateId: "c2", referenceIds: [] }],
    });
    const renamed = renameCandidate(project, "c2", "c1");
    expect(renamed.candidates.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(renamed.runs.find((r) => r.id === "run-1")?.candidateIds).toEqual(["c1"]);
    expect(renamed.runs.find((r) => r.id === "run-2")?.candidateIds).toEqual(["c2"]);
  });

  it("successful renames rewrite branch parents instead of dangling", () => {
    let project = createCharacterProject("char-1", 0);
    project = definePart(project, { id: "belt", name: "Belt", requirements: [], correctionHistory: [] });
    project = recordSuccessfulRun(project, {
      runId: "run-1",
      partId: "belt",
      view: "front",
      outputs: [{ candidateId: "c1", referenceIds: [] }],
    });
    project = recordSuccessfulRun(project, {
      runId: "run-2",
      partId: "belt",
      view: "front",
      inputCandidateId: "c1",
      outputs: [{ candidateId: "c2", referenceIds: [] }],
    });
    const renamed = renameCandidate(project, "c1", "c1-new");
    expect(renamed.candidates.find((c) => c.id === "c2")?.parentCandidateId).toBe("c1-new");
    expect(renamed.runs.find((r) => r.id === "run-2")?.inputCandidateId).toBe("c1-new");
  });

  it("deduplicated bytes share the asset without merging candidates or runs", () => {
    let project = createCharacterProject("char-1", 0);
    project = definePart(project, { id: "belt", name: "Belt", requirements: [], correctionHistory: [] });
    project = recordSuccessfulRun(project, {
      runId: "run-1",
      partId: "belt",
      view: "front",
      outputs: [{ candidateId: "c1", assetId: "c1", referenceIds: [] }],
    });
    project = recordSuccessfulRun(project, {
      runId: "run-2",
      partId: "belt",
      view: "front",
      outputs: [{ candidateId: "c2", assetId: "c2", referenceIds: [] }],
    });
    project = setCandidateAsset(project, "c2", "c1");
    expect(project.candidates).toHaveLength(2);
    expect(project.runs.find((r) => r.id === "run-1")?.candidateIds).toEqual(["c1"]);
    expect(project.runs.find((r) => r.id === "run-2")?.candidateIds).toEqual(["c2"]);
    expect(project.candidates.find((c) => c.id === "c2")?.assetId).toBe("c1");
  });

  it("generated ids never collide within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCharacterId("cand")));
    expect(ids.size).toBe(50);
  });

  it("identical bytes from two runs stay separate through the executor asset path", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT)).mockResolvedValueOnce(ok(FRONT));
    await run("gen");
    await run("gen");
    const project = useWorkflowStore.getState().characterProject!;
    expect(project.candidates.filter((c) => c.partId === "gen")).toHaveLength(2);
    expect(project.runs.filter((r) => r.partId === "gen")).toHaveLength(2);
    const [first, second] = project.candidates.filter((c) => c.partId === "gen");
    expect(first.id).not.toBe(second.id);
    useWorkflowStore.getState().selectNodeCandidate("gen", first.id);
    useWorkflowStore.getState().selectNodeCandidate("gen", second.id);
    const reselected = useWorkflowStore.getState().characterProject!;
    expect(reselected.candidates.filter((c) => c.partId === "gen")).toHaveLength(2);
  });
});

describe("review blocker 4: legacy first rerun keeps the visible selection", () => {
  it("seeds the old output and never auto-selects the fresh rerun", async () => {
    seedTwoParts();
    const legacyId = "legacy-old";
    useWorkflowStore.setState({
      nodes: useWorkflowStore.getState().nodes.map((n) =>
        n.id === "gen"
          ? {
              ...n,
              data: {
                ...n.data,
                outputImage: FRONT,
                selectedHistoryId: legacyId,
                selectedHistoryIndex: 0,
                imageHistory: [
                  { id: legacyId, assetId: legacyId, timestamp: 1, prompt: "old", aspectRatio: "1:1", model: "nano-banana" },
                ],
              },
            }
          : n,
      ),
    });
    rememberSessionMedia(legacyId, FRONT);
    await useWorkflowStore.getState().loadWorkflow({
      version: 1,
      name: "legacy",
      nodes: useWorkflowStore.getState().nodes.map(({ selected, ...rest }) => rest),
      edges: useWorkflowStore.getState().edges,
      edgeStyle: "angular",
    });
    const seeded = useWorkflowStore.getState().characterProject!;
    expect(seeded.selection).toEqual({ "gen@default": legacyId });

    mockFetch.mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    expect(genData().outputImage).toBe(FRONT);
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({ "gen@default": legacyId });
    const candidates = useWorkflowStore.getState().characterProject!.candidates.filter((c) => c.partId === "gen");
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.id === legacyId)?.review).toBe("selected");
  });
});

describe("review blocker 5: lock source changes go stale", () => {
  it("changing only sourceReferenceId marks candidates stale", () => {
    let project = createCharacterProject("char-1", 0);
    project = definePart(project, { id: "belt", name: "Belt", requirements: [], correctionHistory: [] });
    project = updateProjectLocks(project, [
      { id: "lock-layers", description: "skirt keeps three layers", sourceReferenceId: "ref-a" },
    ]).project;
    project = recordSuccessfulRun(project, {
      runId: "run-1",
      partId: "belt",
      view: "front",
      outputs: [{ candidateId: "c1", referenceIds: [] }],
    });
    project = selectCandidate(project, "belt", "front", "c1");
    const { project: next, affected } = updateProjectLocks(project, [
      { id: "lock-layers", description: "skirt keeps three layers", sourceReferenceId: "ref-b" },
    ]);
    expect(affected).toEqual(["c1"]);
    expect(next.candidates[0].review).toBe("stale");
  });
});

describe("review blocker 2: unselected media survives a real save and reopen", () => {
  it("saves both session assets and reopens with either selectable", async () => {
    seedTwoParts();
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/generate") {
        const body = JSON.parse(init?.body as string) as { prompt?: string };
        void body;
        const next = (mockFetch as unknown as { queue?: string[] }).queue?.shift();
        return ok(next ?? FRONT);
      }
      throw new Error(`Unexpected mock request: ${url}`);
    });
    (mockFetch as unknown as { queue?: string[] }).queue = [FRONT, REVISED];
    await run("gen");
    await run("gen");
    const history = genData().imageHistory as Array<{ id: string }>;
    const firstId = history[1].id;
    const secondId = history[0].id;
    useWorkflowStore.getState().selectNodeCandidate("gen", firstId);
    expect(readSessionMedia(firstId)).toBe(FRONT);
    expect(readSessionMedia(secondId)).toBe(REVISED);

    const files = new Map<string, string>();
    let savedPayload: Record<string, unknown> | null = null;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/workflow-images") {
        const body = JSON.parse(init?.body as string) as { imageId: string; imageData: string };
        files.set(body.imageId, body.imageData);
        return { ok: true, json: async () => ({ success: true, imageId: body.imageId }) };
      }
      if (typeof url === "string" && url.startsWith("/api/workflow-images?")) {
        const params = new URLSearchParams(url.split("?")[1]);
        const imageId = params.get("imageId")!;
        const image = files.get(imageId);
        if (!image) return { ok: true, json: async () => ({ success: false, error: "not found", notFound: true }) };
        return { ok: true, json: async () => ({ success: true, imageId, image }) };
      }
      if (url === "/api/workflow") {
        savedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`Unexpected mock request: ${url}`);
    });
    useWorkflowStore.setState({
      workflowId: "wf-1",
      workflowName: "crb-02-save",
      saveDirectoryPath: "/tmp/crb-02-save",
      useExternalImageStorage: true,
    });
    const saved = await useWorkflowStore.getState().saveToFile();
    expect(saved).toBe(true);
    expect(files.get(firstId)).toBe(FRONT);
    expect(files.get(secondId)).toBe(REVISED);
    expect(savedPayload).not.toBeNull();

    useWorkflowStore.getState().clearWorkflow();
    expect(readSessionMedia(firstId)).toBeNull();
    const payload = (savedPayload as unknown as { workflow: WorkflowNode[] & Record<string, unknown> }).workflow as unknown as {
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      characterProject: ReturnType<typeof createCharacterProject>;
    };
    await useWorkflowStore.getState().loadWorkflow(
      {
        version: 1,
        name: "crb-02-save",
        nodes: payload.nodes,
        edges: payload.edges,
        edgeStyle: "angular",
        characterProject: payload.characterProject,
      },
      "/tmp/crb-02-save",
    );
    const reopened = useWorkflowStore.getState();
    expect(reopened.characterProject?.selection).toEqual({ "gen@default": firstId });
    expect(genData().outputImage).toBe(FRONT);
    expect(files.get(secondId)).toBe(REVISED);

    const secondBytes = files.get(secondId)!;
    useWorkflowStore.getState().updateNodeData("gen", {
      outputImage: secondBytes,
      selectedHistoryIndex: 0,
      selectedHistoryId: secondId,
      status: "idle",
      error: null,
    });
    useWorkflowStore.getState().selectNodeCandidate("gen", secondId);
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({ "gen@default": secondId });
    expect(useWorkflowStore.getState().getConnectedInputs("consumer").images[0]).toBe(REVISED);
  });

  it("session eviction keeps still-referenced candidates", async () => {
    seedTwoParts();
    mockFetch.mockImplementation(async () => ok(FRONT));
    await run("gen");
    const selectedId = (genData().imageHistory as Array<{ id: string }>)[0].id;
    useWorkflowStore.getState().selectNodeCandidate("gen", selectedId);
    for (let i = 0; i < 60; i++) {
      rememberSessionMedia(`transient-${i}`, `data:image/png;base64,dHJhbnNpZW50-${i}`);
    }
    expect(readSessionMedia(selectedId)).toBe(FRONT);
  });
});

describe("review domain extras", () => {
  it("adopted legacy candidates carry a stable asset", () => {
    const project = adoptCandidate(createCharacterProject("char-1", 0), {
      candidateId: "legacy-1",
      partId: "belt",
      view: "front",
    });
    expect(project.candidates[0].assetId).toBe("legacy-1");
  });
});
