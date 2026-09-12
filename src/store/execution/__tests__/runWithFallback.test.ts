import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAttemptError, runWithFallback } from "../runWithFallback";
import type { SelectedModel, WorkflowNodeData } from "@/types";

const primary: SelectedModel = {
  provider: "gemini",
  modelId: "nano-banana",
  displayName: "Nano Banana",
};
const fallback: SelectedModel = {
  provider: "openai",
  modelId: "gpt-image-1",
  displayName: "GPT Image 1",
};
const authorized = { enabled: true, maxCostUsd: 0.2 };
const eligible = () => new CloudAttemptError(
  "Primary lacks this capability",
  "not-executed",
  "capability-unavailable",
  true,
);

describe("runWithFallback — conservative policy", () => {
  let updateNodeData: ReturnType<typeof vi.fn<(id: string, data: Partial<WorkflowNodeData>) => void>>;

  beforeEach(() => {
    updateNodeData = vi.fn();
  });

  it("keeps automatic fallback off by default even when a model and API key may exist", async () => {
    const runOnce = vi.fn().mockRejectedValueOnce(eligible());
    await expect(runWithFallback({
      nodeId: "n1", primary, fallback, updateNodeData, runOnce,
    })).rejects.toThrow("Primary lacks this capability");
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it.each([
    new CloudAttemptError("response lost", "unknown", "network"),
    new CloudAttemptError("content rejected", "submitted", "content-rejected"),
    new CloudAttemptError("bad input", "not-executed", "input"),
    new Error("unclassified"),
  ])("never falls back for unknown, submitted, input, content, or unclassified errors", async (error) => {
    const runOnce = vi.fn().mockRejectedValueOnce(error);
    await expect(runWithFallback({
      nodeId: "n1",
      primary,
      fallback,
      fallbackPolicy: authorized,
      fallbackEstimatedCost: 0.1,
      updateNodeData,
      runOnce,
    })).rejects.toThrow();
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("runs one compatible, authorized fallback within budget", async () => {
    const runOnce = vi.fn()
      .mockRejectedValueOnce(eligible())
      .mockResolvedValueOnce(undefined);

    await runWithFallback({
      nodeId: "n1",
      primary,
      fallback,
      fallbackPolicy: authorized,
      fallbackEstimatedCost: 0.1,
      validateFallback: () => null,
      fallbackParameters: { quality: "high" },
      updateNodeData,
      runOnce,
    });

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(runOnce).toHaveBeenNthCalledWith(2, fallback, { quality: "high" }, {
      attempt: "fallback",
      switchReason: "capability-unavailable: Primary lacks this capability",
    });
    expect(updateNodeData).toHaveBeenCalledWith("n1", expect.objectContaining({
      __usedFallback: true,
      __fallbackModelUsed: "GPT Image 1",
    }));
  });

  it.each([
    { name: "unknown cost", estimate: null, budget: 0.2, gap: null },
    { name: "missing budget", estimate: 0.1, budget: null, gap: null },
    { name: "budget exceeded", estimate: 0.3, budget: 0.2, gap: null },
    { name: "capability mismatch", estimate: 0.1, budget: 0.2, gap: "mask unsupported" },
  ])("pauses fallback when $name", async ({ estimate, budget, gap }) => {
    const runOnce = vi.fn().mockRejectedValueOnce(eligible());
    await expect(runWithFallback({
      nodeId: "n1",
      primary,
      fallback,
      fallbackPolicy: { enabled: true, maxCostUsd: budget },
      fallbackEstimatedCost: estimate,
      validateFallback: () => gap,
      updateNodeData,
      runOnce,
    })).rejects.toThrow("Primary lacks this capability");
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(updateNodeData).toHaveBeenCalledWith("n1", expect.objectContaining({
      error: expect.stringContaining("Automatic fallback paused"),
    }));
  });

  it("does not treat local cancellation as provider cancellation or start fallback", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    const runOnce = vi.fn().mockRejectedValueOnce(abort);
    await expect(runWithFallback({
      nodeId: "n1",
      primary,
      fallback,
      fallbackPolicy: authorized,
      fallbackEstimatedCost: 0.1,
      updateNodeData,
      runOnce,
    })).rejects.toBe(abort);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});
