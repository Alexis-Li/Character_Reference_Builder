import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore, type WorkflowFile } from "../workflowStore";
import type { CloudRequestRecord, NanoBananaNodeData, SelectedModel, WorkflowNode } from "@/types";

const entry: SelectedModel = {
  provider: "gemini",
  modelId: "nano-banana",
  displayName: "Nano Banana",
};

function record(status: CloudRequestRecord["status"], index: number): CloudRequestRecord {
  return {
    id: `request-${index}`,
    createdAt: index,
    updatedAt: index,
    status,
    attempt: "primary",
    originalEntry: entry,
    actualEntry: entry,
    estimatedCostUsd: index === 4 ? null : 0.039,
    actualCostUsd: null,
    querySupport: "unsupported",
    ...(status === "unknown" ? { failureReason: "network" as const } : {}),
  };
}

describe("cloud request persistence", () => {
  afterEach(() => useWorkflowStore.getState().clearWorkflow());

  it("keeps every CRB-04 lifecycle state and selected asset on reopen without resubmitting", async () => {
    const statuses: CloudRequestRecord["status"][] = [
      "not-submitted",
      "submitting",
      "completed",
      "failed",
      "unknown",
      "wait-cancelled",
    ];
    const selectedImage = "data:image/png;base64,selected";
    const node = {
      id: "gen-1",
      type: "nanoBanana",
      position: { x: 0, y: 0 },
      data: {
        inputImages: [], inputPrompt: "prompt", outputImage: selectedImage,
        aspectRatio: "1:1", resolution: "1K", model: "nano-banana",
        selectedModel: entry, modelSource: "project-default",
        useGoogleSearch: false, useImageSearch: false,
        status: "unknown", error: "Response lost",
        imageHistory: [], selectedHistoryIndex: 0, selectedHistoryId: "cand-selected",
        fallbackPolicy: { enabled: false, maxCostUsd: null },
        requestHistory: statuses.map(record),
      } satisfies NanoBananaNodeData,
    } as WorkflowNode;
    const workflow: WorkflowFile = {
      version: 1,
      name: "request-reopen",
      nodes: [node],
      edges: [],
      edgeStyle: "curved",
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await useWorkflowStore.getState().loadWorkflow(JSON.parse(JSON.stringify(workflow)));

    const reopened = useWorkflowStore.getState().nodes[0].data as NanoBananaNodeData;
    expect(reopened.requestHistory?.map((item) => item.status)).toEqual(statuses);
    expect(reopened.outputImage).toBe(selectedImage);
    expect(reopened.requestHistory?.[4].estimatedCostUsd).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/generate", expect.anything());
    fetchSpy.mockRestore();
  });
});
