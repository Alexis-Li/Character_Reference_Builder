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
  addReference,
  adoptCandidate,
  candidateReferenceSource,
  createCharacterProject,
  definePart,
  newCharacterId,
  recordSuccessfulRun,
  renameCandidate,
  selectCandidate,
  setCandidateAsset,
  updateProjectLocks,
  updateReference,
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
      characterProject: CharacterProject;
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

describe("third review: clear keeps node and domain joined", () => {
  it("clear drops the pinned version; next success reselects jointly", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT));
    await run("gen");
    const firstId = (genData().imageHistory as Array<{ id: string }>)[0].id;
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({ "gen@default": firstId });

    useWorkflowStore.getState().clearNodeSelection("gen");
    expect(genData().outputImage).toBeNull();
    expect(genData().selectedHistoryId).toBeNull();
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({});
    expect(useWorkflowStore.getState().getConnectedInputs("consumer").images).toHaveLength(0);

    mockFetch.mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    const secondId = (genData().imageHistory as Array<{ id: string }>)[0].id;
    expect(genData().outputImage).toBe(REVISED);
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({ "gen@default": secondId });
    expect(useWorkflowStore.getState().getConnectedInputs("consumer").images[0]).toBe(REVISED);
  });

  it("clear followed by failed rerun stays explicitly empty on both sides", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT));
    await run("gen");
    useWorkflowStore.getState().clearNodeSelection("gen");
    mockFetch.mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(run("gen")).rejects.toThrow();
    expect(genData().outputImage).toBeNull();
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({});
    expect(useWorkflowStore.getState().characterProject?.candidates).toHaveLength(1);
    expect(useWorkflowStore.getState().getConnectedInputs("consumer").images).toHaveLength(0);
  });

  it("direct output null writes also clear the domain selection", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT));
    await run("gen");
    useWorkflowStore.getState().updateNodeData("gen", { outputImage: null });
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({});
    expect(genData().selectedHistoryId).toBeNull();
  });
});

describe("third review: provenance survives reference edits", () => {
  it("per-candidate snapshots keep old and new bases distinct", async () => {
    let project = createCharacterProject("char-1", 0);
    project = definePart(project, { id: "belt", name: "Belt", requirements: [], correctionHistory: [] });
    project = addReference(project, { id: "ref", kind: "original", source: "sha:old" });
    project = recordSuccessfulRun(project, {
      runId: "run-1",
      partId: "belt",
      view: "front",
      outputs: [{ candidateId: "c1", referenceIds: ["ref"] }],
    });
    project = updateReference(project, "ref", { source: "sha:new" }).project;
    project = recordSuccessfulRun(project, {
      runId: "run-2",
      partId: "belt",
      view: "front",
      outputs: [{ candidateId: "c2", referenceIds: ["ref"] }],
    });
    expect(candidateReferenceSource(project, "c1", "ref")).toBe("sha:old");
    expect(candidateReferenceSource(project, "c2", "ref")).toBe("sha:new");
  });

  it("image content versions give each run its own traceable basis", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT));
    await run("gen");
    const first = useWorkflowStore.getState().characterProject!.candidates.find((c) => c.partId === "gen")!;
    const basisBefore = candidateReferenceSource(useWorkflowStore.getState().characterProject!, first.id, "ref:img-a");
    expect(basisBefore).toMatch(/^node:img-a#/);

    useWorkflowStore.getState().updateNodeData("img-a", { image: ORIG_A2 });
    mockFetch.mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    const after = useWorkflowStore.getState().characterProject!;
    const candidates = after.candidates.filter((c) => c.partId === "gen");
    expect(candidates).toHaveLength(2);
    const oldBasis = candidateReferenceSource(after, candidates[0].id, "ref:img-a");
    const newBasis = candidateReferenceSource(after, candidates[1].id, "ref:img-a");
    expect(oldBasis).toBe(basisBefore);
    expect(newBasis).not.toBe(oldBasis);
    expect(newBasis).toMatch(/^node:img-a#/);
  });
});

describe("third review: operable media never silently lost", () => {
  it("unreviewed candidates survive transient pressure", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT)).mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    await run("gen");
    const history = genData().imageHistory as Array<{ id: string }>;
    const firstId = history[1].id;
    const secondId = history[0].id;
    useWorkflowStore.getState().selectNodeCandidate("gen", firstId);
    for (let i = 0; i < 60; i++) {
      rememberSessionMedia(`transient-${i}`, `data:image/png;base64,dHJhbnNpZW50-${i}`);
    }
    expect(readSessionMedia(firstId)).toBe(FRONT);
    expect(readSessionMedia(secondId)).toBe(REVISED);
  });

  it("save fails loudly when a candidate has no recoverable bytes", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT));
    await run("gen");
    clearSessionMedia();
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/workflow-images?")) {
        return { ok: true, json: async () => ({ success: false, notFound: true }) };
      }
      if (url === "/api/workflow-images") {
        return { ok: true, json: async () => ({ success: true }) };
      }
      if (url === "/api/workflow") {
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`Unexpected mock request: ${url}`);
    });
    useWorkflowStore.setState({
      workflowId: "wf-missing",
      workflowName: "crb-02-missing",
      saveDirectoryPath: "/tmp/crb-02-missing",
      useExternalImageStorage: true,
    });
    const saved = await useWorkflowStore.getState().saveToFile();
    expect(saved).toBe(false);
  });
});

describe("fourth review: failed writes never look saved", () => {
  it("media POST business failure blocks the workflow write", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT)).mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    await run("gen");
    let workflowCalls = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/workflow-images") {
        return { ok: true, json: async () => ({ success: false, error: "disk full" }) };
      }
      if (typeof url === "string" && url.startsWith("/api/workflow-images?")) {
        return { ok: true, json: async () => ({ success: false, notFound: true }) };
      }
      if (url === "/api/workflow") {
        workflowCalls += 1;
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`Unexpected mock request: ${url}`);
    });
    useWorkflowStore.setState({
      workflowId: "wf-fail-biz",
      workflowName: "crb-02-fail-biz",
      saveDirectoryPath: "/tmp/crb-02-fail-biz",
      useExternalImageStorage: true,
    });
    const saved = await useWorkflowStore.getState().saveToFile();
    expect(saved).toBe(false);
    expect(workflowCalls).toBe(0);
  });

  it("media POST throw blocks the workflow write", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT)).mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    await run("gen");
    let workflowCalls = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/workflow-images") {
        throw new Error("network down");
      }
      if (typeof url === "string" && url.startsWith("/api/workflow-images?")) {
        return { ok: true, json: async () => ({ success: false, notFound: true }) };
      }
      if (url === "/api/workflow") {
        workflowCalls += 1;
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`Unexpected mock request: ${url}`);
    });
    useWorkflowStore.setState({
      workflowId: "wf-fail-net",
      workflowName: "crb-02-fail-net",
      saveDirectoryPath: "/tmp/crb-02-fail-net",
      useExternalImageStorage: true,
    });
    const saved = await useWorkflowStore.getState().saveToFile();
    expect(saved).toBe(false);
    expect(workflowCalls).toBe(0);
  });

  it("character projects force independent assets even when legacy embedding is disabled", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT)).mockResolvedValueOnce(ok(REVISED));
    await run("gen");
    await run("gen");
    const history = genData().imageHistory as Array<{ id: string }>;
    const firstId = history[1].id;
    const secondId = history[0].id;
    useWorkflowStore.getState().selectNodeCandidate("gen", firstId);

    let savedPayload: Record<string, unknown> | null = null;
    let mediaPosts = 0;
    const files = new Map<string, string>();
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/workflow-images") {
        mediaPosts += 1;
        const body = JSON.parse(init?.body as string) as { imageId: string; imageData: string };
        files.set(body.imageId, body.imageData);
        return { ok: true, json: async () => ({ success: true, imageId: body.imageId }) };
      }
      if (typeof url === "string" && url.startsWith("/api/workflow-images?")) {
        const imageId = new URLSearchParams(url.split("?")[1]).get("imageId")!;
        const image = files.get(imageId);
        return { ok: true, json: async () => image ? { success: true, image } : { success: false, notFound: true } };
      }
      if (url === "/api/workflow") {
        savedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`Unexpected mock request: ${url}`);
    });
    useWorkflowStore.setState({
      workflowId: "wf-embed",
      workflowName: "crb-02-embed",
      saveDirectoryPath: "/tmp/crb-02-embed",
      useExternalImageStorage: false,
    });
    const saved = await useWorkflowStore.getState().saveToFile();
    expect(saved).toBe(true);
    expect(mediaPosts).toBeGreaterThanOrEqual(2);
    expect(files.get(firstId)).toBe(FRONT);
    expect(files.get(secondId)).toBe(REVISED);
    expect(useWorkflowStore.getState().useExternalImageStorage).toBe(true);
    const payload = (savedPayload as unknown as { workflow: { nodes: WorkflowNode[]; edges: WorkflowEdge[]; characterProject: CharacterProject } }).workflow;
    const savedGen = payload.nodes.find((n) => n.id === "gen")!;
    const savedHistory = (savedGen.data as unknown as { imageHistory: Array<{ id: string; image?: string }> }).imageHistory;
    expect(savedHistory).toHaveLength(2);
    expect(savedHistory.find((h) => h.id === firstId)?.image).toBeUndefined();
    expect(savedHistory.find((h) => h.id === secondId)?.image).toBeUndefined();

    useWorkflowStore.getState().clearWorkflow();
    expect(readSessionMedia(firstId)).toBeNull();
    await useWorkflowStore.getState().loadWorkflow(
      { version: 1, name: "crb-02-embed", nodes: payload.nodes, edges: payload.edges, edgeStyle: "angular", characterProject: payload.characterProject },
      "/tmp/crb-02-embed",
    );
    expect(useWorkflowStore.getState().characterProject?.selection).toEqual({ "gen@default": firstId });
    const secondBytes = files.get(secondId)!;
    useWorkflowStore.getState().updateNodeData("gen", {
      outputImage: secondBytes,
      selectedHistoryId: secondId,
      selectedHistoryIndex: 0,
      status: "idle",
      error: null,
    });
    useWorkflowStore.getState().selectNodeCandidate("gen", secondId);
    expect(useWorkflowStore.getState().getConnectedInputs("consumer").images[0]).toBe(REVISED);
  });

  it("in-flight approval keeps the project dirty until the next save", async () => {
    seedTwoParts();
    mockFetch.mockResolvedValueOnce(ok(FRONT));
    await run("gen");
    const candidateId = (genData().imageHistory as Array<{ id: string }>)[0].id;
    useWorkflowStore.setState({
      workflowId: "wf-race",
      workflowName: "crb-02-race",
      saveDirectoryPath: "/tmp/crb-02-race",
      useExternalImageStorage: true,
    });

    const gate = Promise.withResolvers<unknown>();
    const workflowBodies: string[] = [];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/workflow-images") {
        const body = JSON.parse(init?.body as string) as { imageId: string };
        return { ok: true, json: async () => ({ success: true, imageId: body.imageId }) };
      }
      if (typeof url === "string" && url.startsWith("/api/workflow-images?")) {
        return { ok: true, json: async () => ({ success: true, image: FRONT }) };
      }
      if (url === "/api/workflow") {
        workflowBodies.push(init?.body as string);
        if (workflowBodies.length === 1) {
          await gate.promise;
        }
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`Unexpected mock request: ${url}`);
    });

    const firstSave = useWorkflowStore.getState().saveToFile();
    await Promise.resolve();
    await Promise.resolve();
    useWorkflowStore.getState().approveNodeCandidate("gen", candidateId);
    gate.resolve(null);
    const firstResult = await firstSave;
    expect(firstResult).toBe(true);
    expect(useWorkflowStore.getState().hasUnsavedChanges).toBe(true);

    const secondSave = await useWorkflowStore.getState().saveToFile();
    expect(secondSave).toBe(true);
    expect(workflowBodies).toHaveLength(2);
    const secondPayload = JSON.parse(workflowBodies[1]) as { workflow: { characterProject: CharacterProject } };
    expect(secondPayload.workflow.characterProject.candidates.find((c) => c.id === candidateId)?.review).toBe("approved");
  });
});
