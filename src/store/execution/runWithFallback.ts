/** Conservative primary/fallback execution policy (CRB-04). */

import type {
  CloudFailureReason,
  FallbackPolicy,
  SelectedModel,
  WorkflowNodeData,
} from "@/types";

export type AttemptExecution = "not-executed" | "submitted" | "unknown";

/** Error carrying evidence about whether the provider could have executed. */
export class CloudAttemptError extends Error {
  constructor(
    message: string,
    public readonly execution: AttemptExecution,
    public readonly reason: CloudFailureReason,
    /** Only these pre-submit conditions may enter fallback evaluation. */
    public readonly fallbackEligible = false,
  ) {
    super(message);
    this.name = "CloudAttemptError";
  }
}

export interface RunAttemptContext {
  attempt: "primary" | "fallback";
  switchReason?: string;
}

export interface RunWithFallbackOptions {
  nodeId: string;
  primary: SelectedModel;
  fallback?: SelectedModel;
  fallbackParameters?: Record<string, unknown>;
  fallbackPolicy?: FallbackPolicy;
  fallbackEstimatedCost?: number | null;
  /** Returns an actionable reason when the fallback cannot perform this request. */
  validateFallback?: () => string | null;
  updateNodeData: (id: string, data: Partial<WorkflowNodeData>) => void;
  /** @deprecated Outputs are intentionally preserved across every failed attempt. */
  clearOutput?: Partial<WorkflowNodeData>;
  runOnce: (
    model: SelectedModel,
    parametersOverride?: Record<string, unknown>,
    context?: RunAttemptContext,
  ) => Promise<void>;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

function isSameModel(a: SelectedModel, b: SelectedModel): boolean {
  return a.provider === b.provider && a.modelId === b.modelId;
}

function fallbackBlockReason(options: RunWithFallbackOptions): string | null {
  if (!options.fallback) return "No fallback entry is configured.";
  if (isSameModel(options.primary, options.fallback)) {
    return "The fallback entry is the same as the primary entry.";
  }
  if (!options.fallbackPolicy?.enabled) {
    return "Automatic fallback is not authorized for this node.";
  }
  const capabilityGap = options.validateFallback?.() ?? null;
  if (capabilityGap) return `The fallback cannot perform this request: ${capabilityGap}`;
  const estimate = options.fallbackEstimatedCost;
  if (estimate === null || estimate === undefined || !Number.isFinite(estimate)) {
    return "Fallback cost is unknown, so the budget cannot be controlled.";
  }
  const budget = options.fallbackPolicy.maxCostUsd;
  if (budget === null || !Number.isFinite(budget) || budget < 0) {
    return "No valid fallback budget has been authorized.";
  }
  if (estimate > budget) {
    return `Estimated fallback cost $${estimate.toFixed(4)} exceeds the authorized $${budget.toFixed(4)} budget.`;
  }
  return null;
}

export async function runWithFallback(options: RunWithFallbackOptions): Promise<void> {
  const { nodeId, primary, fallback, fallbackParameters, updateNodeData, runOnce } = options;

  updateNodeData(nodeId, {
    __usedFallback: undefined,
    __fallbackModelUsed: undefined,
    __primaryError: undefined,
  });

  let primaryError: unknown;
  try {
    await runOnce(primary, undefined, { attempt: "primary" });
    return;
  } catch (error) {
    if (isAbortError(error)) throw error;
    primaryError = error;
  }

  // Unknown/submitted outcomes, content/input errors, and unclassified errors
  // never launch another paid request. Only an explicitly eligible,
  // definitely-not-executed attempt may proceed to the remaining gates.
  if (
    !(primaryError instanceof CloudAttemptError) ||
    primaryError.execution !== "not-executed" ||
    !primaryError.fallbackEligible
  ) {
    throw primaryError;
  }

  const blocked = fallbackBlockReason(options);
  if (blocked || !fallback) {
    if (options.fallbackPolicy?.enabled && fallback) {
      updateNodeData(nodeId, {
        status: "error",
        error: `Primary was not submitted. Automatic fallback paused: ${blocked}`,
      });
    }
    throw primaryError;
  }

  const primaryMessage = errorMessage(primaryError);
  const switchReason = `${primaryError.reason}: ${primaryMessage}`;
  updateNodeData(nodeId, {
    status: "loading",
    error: null,
    __primaryError: primaryMessage,
  });

  try {
    await runOnce(fallback, fallbackParameters, {
      attempt: "fallback",
      switchReason,
    });
    updateNodeData(nodeId, {
      status: "complete",
      error: null,
      __usedFallback: true,
      __fallbackModelUsed: fallback.displayName,
      __primaryError: primaryMessage,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof CloudAttemptError && error.execution === "unknown") throw error;
    const combined = `Primary was not submitted: ${primaryMessage}. Fallback failed: ${errorMessage(error)}`;
    updateNodeData(nodeId, { status: "error", error: combined });
    throw new Error(combined);
  }
}
