import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { PartReferenceWorkspace } from "../PartReferenceWorkspace";
import { useWorkflowStore } from "@/store/workflowStore";
import { executeNanoBanana } from "@/store/execution/nanoBananaExecutor";
import {
  approveCandidate,
  createCharacterProject,
  definePart,
  selectCandidate,
} from "@/lib/characterProject";
import { partReferencePrompt } from "@/lib/partReference";
import { clearSessionMedia } from "@/store/execution/sessionMedia";
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn(),
    endSession: vi.fn(),
    getCurrentSession: vi.fn(),
  },
}));
const image = "data:image/png;base64,aGVsbG8=";
beforeEach(() => {
  clearSessionMedia();
  useWorkflowStore.setState({
    nodes: [],
    edges: [],
    characterProject: null,
    isRunning: false,
    generationsPath: null,
    saveDirectoryPath: null,
  });
});
describe("single part production", () => {
  it("loads the preset without submitting and confirms/corrects independent part requirements", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<PartReferenceWorkspace />);
    fireEvent.click(screen.getByText(/单部件参考工作区/));
    fireEvent.click(screen.getByText("加载默认单部件预设"));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("目标说明"), {
      target: { value: "左腰带扣" },
    });
    fireEvent.click(screen.getByText("确认／更正目标"));
    const part = useWorkflowStore.getState().characterProject!.parts[0];
    expect(part.name).toBe("左腰带扣");
    expect(part.requirements[0]).toContain("保持原设计");
    expect(part.correctionHistory).toHaveLength(1);
    await act(async () => {});
  });
  it("inherits only current part requirements and common locks", () => {
    let p = definePart(createCharacterProject("p"), {
      id: "belt",
      name: "腰带",
      requirements: ["保留双扣"],
      correctionHistory: [],
    });
    p = definePart(p, {
      id: "shoe",
      name: "鞋",
      requirements: ["厚底"],
      correctionHistory: [],
    });
    p.projectLocks = [{ id: "lock", description: "保持配色" }];
    const prompt = partReferencePrompt(p, "belt", "背面", "减小扣环");
    expect(prompt).toContain("保持配色");
    expect(prompt).toContain("保留双扣");
    expect(prompt).toContain("减小扣环");
    expect(prompt).not.toContain("厚底");
  });
  it("appends view-specific unreviewed branches and preserves selections through failures", async () => {
    const state = useWorkflowStore.getState();
    const original = state.addNode(
      "imageInput",
      { x: 0, y: 0 },
      { image, filename: "original.png" },
    );
    const run = async (view: string, parent?: string, fail = false) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({
            ok: !fail,
            status: fail ? 400 : 200,
            text: async () =>
              JSON.stringify({
                error: "bad request",
                execution: "not-executed",
              }),
            json: async () =>
              fail ? { error: "bad request" } : { success: true, image },
          }),
      );
      const id = state.addNode(
        "nanoBanana",
        { x: 0, y: 0 },
        {
          inputPrompt: "test",
          partTask: {
            partId: "belt",
            view,
            inputCandidateId: parent,
            inferenceNotes: "推测",
          },
        },
      );
      state.onConnect(
        {
          source: original,
          target: id,
          sourceHandle: "image",
          targetHandle: "image",
        },
        { referenceRole: "auxiliary" },
      );
      const ctx = useWorkflowStore
        .getState()
        ._buildExecutionContext(
          useWorkflowStore.getState().nodes.find((n) => n.id === id)!,
        );
      try {
        await executeNanoBanana(ctx, { useStoredFallback: true });
      } catch {
        if (!fail) throw new Error("unexpected failure");
      }
    };
    await run("正面");
    let p = useWorkflowStore.getState().characterProject!;
    expect(p.candidates).toHaveLength(1);
    expect(p.selection).toEqual({});
    const front = p.candidates[0];
    p = approveCandidate(p, front.id);
    useWorkflowStore.setState({
      characterProject: selectCandidate(p, "belt", "正面", front.id),
    });
    await run("背面");
    p = useWorkflowStore.getState().characterProject!;
    const back = p.candidates[1];
    await run("背面", back.id);
    await run("背面", back.id);
    p = useWorkflowStore.getState().characterProject!;
    expect(p.candidates.slice(2).map((c) => c.parentCandidateId)).toEqual([
      back.id,
      back.id,
    ]);
    expect(p.candidates[2].inferenceNotes).toBe("推测");
    const before = p.candidates;
    await run("背面", back.id, true);
    p = useWorkflowStore.getState().characterProject!;
    expect(p.candidates).toEqual(before);
    expect(p.selection["belt@正面"]).toBe(front.id);
    expect(p.runs.at(-1)?.status).toBe("failed");
    expect(p.candidates[0].review).toBe("approved");
  });
});
