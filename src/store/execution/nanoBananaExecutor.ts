/**
 * NanoBanana Executor
 *
 * Unified executor for nanoBanana (image generation) nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type {
  CloudFailureReason,
  CloudQuerySupport,
  CloudRequestExecution,
  CloudRequestRecord,
  NanoBananaNodeData,
  SelectedModel,
} from "@/types";
import { pollGenerateTask } from "./pollTaskCompletion";
import { CloudAttemptError, runWithFallback, type RunAttemptContext } from "./runWithFallback";
import { calculateGenerationCost, estimateSelectedModelCost } from "@/utils/costCalculator";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import { rememberSessionMedia } from "./sessionMedia";
import { newCharacterId } from "@/lib/characterProject";
import { checkReferenceGaps, imageCapabilities, resolveGenerationModel } from "@/lib/providers/imageCapabilities";
import type { ProviderCallRecord, ReferenceInput, ReferencePurpose } from "@/lib/providers/imageCapabilities";

import type { NodeExecutionContext } from "./types";
/**
 * Carousel entries kept per node. The cap below only trims entries no
 * contract state points at; selected, reviewed, and branch-linked versions
 * are always retained (CRB-02 append-only).
 */
const MAX_NODE_IMAGE_HISTORY = 50;
const MAX_REQUEST_HISTORY = 50;

export interface NanoBananaOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
}

export async function executeNanoBanana(
  ctx: NodeExecutionContext,
  options: NanoBananaOptions = {}
): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    getEdges,
    getNodes,
    signal,
    providerSettings,
    addIncurredCost,
    addToGlobalHistory,
    generationsPath,
    trackSaveGeneration,
    appendOutputGalleryImage,
  } = ctx;

  const { useStoredFallback = false } = options;

  const { images: connectedImages, imageRefs: connectedImageRefs, text: connectedText, dynamicInputs } = getConnectedInputs(node.id);

  // Get fresh node data from store
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as NanoBananaNodeData;
  const primaryModel: SelectedModel = nodeData.selectedModel ?? {
    provider: "gemini",
    modelId: nodeData.model,
    displayName: nodeData.model,
  };
  let requestHistory = [...(nodeData.requestHistory ?? [])];

  const persistRequest = (record: CloudRequestRecord): void => {
    record = { ...record, updatedAt: Date.now() };
    requestHistory = [record, ...requestHistory.filter((item) => item.id !== record.id)]
      .filter((item, index) => index < MAX_REQUEST_HISTORY || item.status === "unknown" || item.status === "wait-cancelled");
    updateNodeData(node.id, { requestHistory });
  };

  const makeRequest = (
    actualEntry: SelectedModel,
    attempt: "primary" | "fallback",
    switchReason?: string,
  ): CloudRequestRecord => {
    const now = Date.now();
    return {
      id: newCharacterId("request"),
      createdAt: now,
      updatedAt: now,
      status: "not-submitted",
      attempt,
      originalEntry: primaryModel,
      actualEntry,
      ...(switchReason ? { switchReason } : {}),
      estimatedCostUsd: estimateSelectedModelCost(actualEntry, nodeData.resolution),
      actualCostUsd: null,
      querySupport: "unsupported",
    };
  };

  // Determine images and text (with optional fallback to stored values).
  // `imageRoles` parallels `images`: a role is present only when the edge
  // carrying that image explicitly declares one. Stored-fallback images and
  // role-less edges stay legacy (undefined) — never inferred from position.
  let images: string[];
  let imageRoles: (ReferencePurpose | undefined)[];
  let promptText: string | null;

  if (useStoredFallback) {
    if (connectedImages.length > 0) {
      images = connectedImages;
      const refs = connectedImageRefs;
      imageRoles = refs?.length === connectedImages.length
        ? refs.map((ref: { role?: ReferencePurpose }) => ref.role)
        : connectedImages.map(() => undefined);
    } else {
      images = nodeData.inputImages;
      imageRoles = nodeData.inputImages.map(() => undefined);
    }
    promptText = connectedText ?? nodeData.inputPrompt;
  } else {
    images = connectedImages;
    const refs = connectedImageRefs;
    imageRoles = refs?.length === connectedImages.length
      ? refs.map((ref: { role?: ReferencePurpose }) => ref.role)
      : connectedImages.map(() => undefined);
    // For dynamic inputs, check if we have at least a prompt
    const promptFromDynamic = Array.isArray(dynamicInputs.prompt)
      ? dynamicInputs.prompt[0]
      : dynamicInputs.prompt;
    promptText = connectedText || promptFromDynamic || null;
  }

  // Defensive: ensure promptText is actually a string at runtime
  // (Guards against corrupted node data or race conditions in parallel execution)
  if (promptText !== null && typeof promptText !== 'string') {
    const raw: unknown = promptText;
    console.warn('[nanoBanana] promptText was not a string, coercing:', typeof raw, Array.isArray(raw) ? `<redacted array length=${raw.length}>` : '<redacted>');
    promptText = Array.isArray(raw) ? (raw as string[])[0] ?? null : null;
  }

  if (!promptText) {
    const request = makeRequest(primaryModel, "primary");
    persistRequest({ ...request, failureReason: "input", error: "Missing text input" });
    updateNodeData(node.id, {
      status: "error",
      error: "Missing text input",
    });
    throw new Error("Missing text input");
  }

  // Capture promptText as a definitely-non-null string for use inside the closure.
  const finalPrompt: string = promptText;
  const recordDefiniteFailure = (message: string): void => {
    try {
      ctx.recordCharacterRun?.({
        nodeId: node.id,
        runId: newCharacterId("run"),
        status: "failed",
        candidates: [],
        error: message,
      });
    } catch (bookkeepingError) {
      console.error("[nanoBanana] character-run bookkeeping failed:", bookkeepingError);
    }
  };

  updateNodeData(node.id, {
    inputImages: images,
    inputPrompt: finalPrompt,
    status: "loading",
    error: null,
  });

  // Inner runOnce: performs the actual fetch/process/history work for a given model.
  // Extracted so runWithFallback can invoke it twice (primary, then fallback) if needed.
  const runOnce = async (
    modelToUse: SelectedModel,
    parametersOverride?: Record<string, unknown>,
    attemptContext: RunAttemptContext = { attempt: "primary" },
  ): Promise<void> => {
    const provider = modelToUse.provider;
    const headers = buildGenerateHeaders(provider, providerSettings);

    // Sanitize dynamicInputs: remove prompt since it's already sent as the top-level
    // `prompt` field in requestPayload. Keeping both can cause providers like Replicate
    // to prefer dynamicInputs.prompt over the authoritative top-level value.
    const sanitizedDynamicInputs = { ...dynamicInputs };
    delete sanitizedDynamicInputs.prompt;

    // CRB-03: references carry ONLY explicitly declared edge roles.
    // Role-less inputs stay purposeless (legacy) — position never invents a
    // role. The legacy `images` field is kept so older adapters and
    // non-contract providers keep working.
    const references: ReferenceInput[] = images.map((image, index) => {
      const role = imageRoles[index];
      return role ? { image, purpose: role } : { image };
    });

    // CRB-03: the serving source comes from persisted node state, never from
    // comparing values with the mutable global default. The primary uses the
    // node's saved modelSource (absent = node-legacy); a fallback run is
    // always explicit node config (node-override). The server echoes this
    // source in its call record; the executor never labels the call itself.
    const primaryResolution = resolveGenerationModel({
      nodeSelected: nodeData.selectedModel,
      legacyModel: nodeData.model,
      persistedSource: nodeData.modelSource,
    });
    const isFallbackServing =
      modelToUse.provider !== primaryResolution.model.provider ||
      modelToUse.modelId !== primaryResolution.model.modelId;
    const servingSource = isFallbackServing ? "node-override" : primaryResolution.resolvedFrom;

    const requestPayload = {
      images,
      references,
      prompt: finalPrompt,
      aspectRatio: (parametersOverride?.aspectRatio as string) ?? nodeData.aspectRatio,
      resolution: (parametersOverride?.resolution as string) ?? nodeData.resolution,
      model: nodeData.model,
      useGoogleSearch: (parametersOverride?.useGoogleSearch as boolean) ?? nodeData.useGoogleSearch,
      useImageSearch: (parametersOverride?.useImageSearch as boolean) ?? nodeData.useImageSearch,
      selectedModel: modelToUse,
      modelSource: servingSource,
      parameters: parametersOverride ?? nodeData.parameters,
      dynamicInputs: sanitizedDynamicInputs,
    };

    // Final guard: assert that prompt is a string before sending to API
    if (typeof requestPayload.prompt !== 'string') {
      const errorMsg = `Internal error: prompt is ${typeof requestPayload.prompt}, expected string`;
      console.error('[nanoBanana]', errorMsg);
      updateNodeData(node.id, { status: 'error', error: errorMsg });
      throw new Error(errorMsg);
    }

    let requestRecord = makeRequest(
      modelToUse,
      attemptContext.attempt,
      attemptContext.switchReason,
    );
    persistRequest(requestRecord);
    requestRecord = { ...requestRecord, status: "submitting" };
    persistRequest(requestRecord);

    try {
      let result: Awaited<ReturnType<Response["json"]>>;
      const recoverable = requestHistory.find((item) =>
        item.id !== requestRecord.id &&
        (item.status === "unknown" || item.status === "wait-cancelled") &&
        item.querySupport === "supported" &&
        item.upstreamRequestId &&
        item.actualEntry.provider === modelToUse.provider &&
        item.actualEntry.modelId === modelToUse.modelId
      );

      if (recoverable?.upstreamRequestId) {
        // A provider with status lookup is queried before any new submission.
        requestHistory = requestHistory.filter((item) => item.id !== requestRecord.id);
        requestRecord = { ...recoverable, status: "submitting", error: undefined, failureReason: undefined };
        persistRequest(requestRecord);
        result = await pollGenerateTask({
          taskId: recoverable.upstreamRequestId,
          provider: modelToUse.provider,
          modelId: modelToUse.modelId,
          modelName: modelToUse.displayName,
          mediaType: "image",
          headers,
          signal,
        });
      } else {
        const response = await fetch("/api/generate", {
          method: "POST",
          headers,
          body: JSON.stringify(requestPayload),
          ...(signal ? { signal } : {}),
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage = `HTTP ${response.status}`;
          let serverCall: ProviderCallRecord | undefined;
          let execution: CloudRequestExecution = "unknown";
          let querySupport: CloudQuerySupport = "unsupported";
          let upstreamRequestId: string | undefined;
          try {
            const errorJson = JSON.parse(errorText);
            errorMessage = errorJson.error || errorMessage;
            serverCall = errorJson.call;
            if (
              errorJson.execution === "not-executed" ||
              errorJson.execution === "submitted" ||
              errorJson.execution === "unknown"
            ) {
              execution = errorJson.execution;
            }
            if (errorJson.querySupport === "supported" || errorJson.querySupport === "unsupported") {
              querySupport = errorJson.querySupport;
            }
            if (typeof errorJson.upstreamRequestId === "string" && errorJson.upstreamRequestId) {
              upstreamRequestId = errorJson.upstreamRequestId;
            }
          } catch {
            if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
          }

          const failureReason: CloudFailureReason = response.status === 422
            ? "capability-unavailable"
            : response.status === 429
              ? "quota-unavailable"
              : response.status === 401 || response.status === 403
                ? "authentication"
                : response.status === 400
                  ? "input"
                  : response.status === 404 || response.status === 503
                    ? "provider-unavailable"
                    : serverCall
                      ? "provider-failed"
                      : "unknown";
          const eligible = execution === "not-executed" && (
            failureReason === "capability-unavailable" ||
            failureReason === "provider-unavailable" ||
            failureReason === "quota-unavailable"
          );
          requestRecord = {
            ...requestRecord,
            status: execution === "not-executed"
              ? "not-submitted"
              : execution === "submitted"
                ? "failed"
                : "unknown",
            querySupport,
            ...(upstreamRequestId ? { upstreamRequestId } : {}),
            failureReason,
            error: errorMessage,
          };
          persistRequest(requestRecord);

          updateNodeData(node.id, {
            status: execution === "unknown" ? "unknown" : "error",
            error: execution === "unknown"
              ? `${errorMessage} The provider may have executed; no automatic retry was sent.`
              : errorMessage,
            ...(serverCall ? { lastCall: serverCall } : {}),
          });
          if (execution !== "unknown") recordDefiniteFailure(errorMessage);
          throw new CloudAttemptError(
            errorMessage,
            execution,
            failureReason,
            eligible,
          );
        }

        result = await response.json();
        requestRecord = {
          ...requestRecord,
          querySupport: result.querySupport ?? requestRecord.querySupport,
          ...(result.upstreamRequestId ? { upstreamRequestId: result.upstreamRequestId } : {}),
        };
        persistRequest(requestRecord);
      }

      // Handle polling response (long-running Kie tasks)
      if (result.polling) {
        requestRecord = {
          ...requestRecord,
          upstreamRequestId: result.upstreamRequestId ?? result.taskId,
          querySupport: result.querySupport ?? "supported",
        };
        persistRequest(requestRecord);
        result = await pollGenerateTask({
          taskId: result.taskId,
          provider: result.pollProvider,
          modelId: result.pollModelId,
          modelName: result.pollModelName,
          mediaType: result.pollMediaType,
          headers,
          signal,
        });

        if (!result.success) {
          const status = result.statusUnknown ? "unknown" : "failed";
          requestRecord = {
            ...requestRecord,
            status,
            failureReason: result.statusUnknown ? "network" : "provider-failed",
            error: result.error || "Generation failed",
          };
          persistRequest(requestRecord);
          updateNodeData(node.id, {
            status: result.statusUnknown ? "unknown" : "error",
            error: result.error || "Generation failed",
          });
          if (!result.statusUnknown) recordDefiniteFailure(result.error || "Generation failed");
          throw new CloudAttemptError(
            result.error || "Generation failed",
            result.statusUnknown ? "unknown" : "submitted",
            result.statusUnknown ? "network" : "provider-failed",
          );
        }
      }

      // Reopened unknown/cancelled requests query their existing upstream id
      // directly, so their poll result does not pass through `result.polling`
      // above. Preserve an inconclusive lookup as unknown; a definitive
      // provider rejection is failed. Neither outcome submits a replacement.
      if (recoverable?.upstreamRequestId && !result.success) {
        const status = result.statusUnknown ? "unknown" : "failed";
        requestRecord = {
          ...requestRecord,
          status,
          failureReason: result.statusUnknown ? "network" : "provider-failed",
          error: result.error || "Generation failed",
        };
        persistRequest(requestRecord);
        updateNodeData(node.id, {
          status: result.statusUnknown ? "unknown" : "error",
          error: result.error || "Generation failed",
        });
        if (!result.statusUnknown) recordDefiniteFailure(result.error || "Generation failed");
        throw new CloudAttemptError(
          result.error || "Generation failed",
          result.statusUnknown ? "unknown" : "submitted",
          result.statusUnknown ? "network" : "provider-failed",
        );
      }

      if (result.success && result.image) {
        const timestamp = Date.now();
        const imageId = newCharacterId("cand");

        // Save to global history
        addToGlobalHistory({
          image: result.image,
          timestamp,
          prompt: finalPrompt,
          aspectRatio: nodeData.aspectRatio,
          model: nodeData.model,
        });

        // Append-only candidate history (CRB-02): a successful rerun must not
        // silently replace the human-selected result. The new image is always
        // recorded; outputImage keeps the explicit selection and only adopts
        // the fresh result when nothing was selected yet. The candidate id is
        // stable; the generations-folder file id is tracked separately so
        // content deduplication reuses bytes without merging candidates.
        const newHistoryItem = {
          id: imageId,
          assetId: imageId,
          timestamp,
          prompt: finalPrompt,
          aspectRatio: nodeData.aspectRatio,
          model: nodeData.model,
        };
        // Session bytes first: the candidate is selectable before/independently
        // of the generations-folder save.
        rememberSessionMedia(imageId, result.image);
        const priorSelection = nodeData.outputImage;
        const priorSelectedId = nodeData.selectedHistoryId ?? null;
        const priorIndex = nodeData.selectedHistoryIndex ?? 0;
        const protectedIds = new Set([
          ...(ctx.getProtectedCandidateIds?.(node.id) ?? []),
          ...(priorSelectedId ? [priorSelectedId] : []),
        ]);
        const updatedHistory = [newHistoryItem, ...(nodeData.imageHistory || [])].filter(
          (item, index) => index < MAX_NODE_IMAGE_HISTORY || protectedIds.has(item.id),
        );
        const selectedIndex =
          priorSelection != null
            ? Math.max(
                updatedHistory.findIndex((item) => priorSelectedId != null && item.id === priorSelectedId),
                0,
              )
            : 0;
        // Legacy states may carry a selection without its history id; keep the
        // previous index then, clamped into the retained history.
        const nextIndex =
          priorSelection != null && priorSelectedId == null
            ? Math.min(priorIndex + 1, updatedHistory.length - 1)
            : selectedIndex;
        updateNodeData(node.id, {
          ...(priorSelection != null
            ? {
                outputImage: priorSelection,
                selectedHistoryId: priorSelectedId,
                selectedHistoryIndex: nextIndex,
              }
            : { outputImage: result.image, selectedHistoryId: imageId, selectedHistoryIndex: 0 }),
          status: "complete",
          error: null,
          imageHistory: updatedHistory,
          // The server attaches its transport record on success. When a
          // non-contract provider omits it, the previous record is kept.
          ...(result.call ? { lastCall: result.call } : {}),
        });
        requestRecord = { ...requestRecord, status: "completed" };
        persistRequest(requestRecord);

        // Report the run to the character-project contract when the context
        // carries it; node-local history above stays the fallback otherwise.
        try {
          ctx.recordCharacterRun?.({
            nodeId: node.id,
            runId: newCharacterId("run"),
            status: "success",
            candidates: [{ candidateId: imageId, assetId: imageId, referenceIds: [] }],
            ...(priorSelectedId ? { inputCandidateId: priorSelectedId } : {}),
          });
        } catch (error) {
          console.error("[nanoBanana] character-run bookkeeping failed:", error);
        }

        // Push new image to connected downstream outputGallery nodes (atomic append)
        const edges = getEdges();
        const nodes = getNodes();
        edges
          .filter((e) => e.source === node.id)
          .forEach((e) => {
            const target = nodes.find((n) => n.id === e.target);
            if (target?.type === "outputGallery") {
              appendOutputGalleryImage(target.id, result.image);
            }
          });

        // Track cost
        if ((modelToUse.provider === "fal" || modelToUse.provider === "openai") && modelToUse.pricing) {
          addIncurredCost(modelToUse.pricing.amount);
        } else if (modelToUse.provider === "gemini") {
          const generationCost = calculateGenerationCost(nodeData.model, nodeData.resolution);
          addIncurredCost(generationCost);
        }

        // Auto-save to generations folder if configured
        if (generationsPath) {
          const savePromise = fetch("/api/save-generation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              directoryPath: generationsPath,
              image: result.image,
              prompt: finalPrompt,
              imageId,
            }),
          })
            .then((res) => res.json())
            .then((saveResult) => {
              if (saveResult.success && saveResult.imageId && saveResult.imageId !== imageId) {
                const currentNode = getNodes().find((n) => n.id === node.id);
                if (currentNode) {
                  const currentData = currentNode.data as NanoBananaNodeData;
                  const histCopy = [...(currentData.imageHistory || [])];
                  const entryIndex = histCopy.findIndex((h) => h.id === imageId);
                  if (entryIndex !== -1) {
                    histCopy[entryIndex] = { ...histCopy[entryIndex], assetId: saveResult.imageId };
                    updateNodeData(node.id, { imageHistory: histCopy });
                    rememberSessionMedia(saveResult.imageId, result.image);
                    try {
                      ctx.setCharacterCandidateAsset?.(node.id, imageId, saveResult.imageId);
                    } catch (assetError) {
                      console.error("[nanoBanana] candidate-asset bookkeeping failed:", assetError);
                    }
                  }
                }
              }
            })
            .catch((err) => {
              console.error("Failed to save generation:", err);
            });

          trackSaveGeneration(imageId, savePromise);
        }
      } else {
        const execution = result.execution ?? "unknown";
        const failureReason: CloudFailureReason = execution === "submitted"
          ? "provider-failed"
          : execution === "unknown"
            ? "unknown"
            : "input";
        updateNodeData(node.id, {
          status: execution === "unknown" ? "unknown" : "error",
          error: execution === "unknown"
            ? `${result.error || "Generation failed"} The provider may have executed; no automatic retry was sent.`
            : result.error || "Generation failed",
        });
        requestRecord = {
          ...requestRecord,
          status: execution === "not-executed"
            ? "not-submitted"
            : execution === "submitted"
              ? "failed"
              : "unknown",
          querySupport: result.querySupport ?? requestRecord.querySupport,
          ...(result.upstreamRequestId ? { upstreamRequestId: result.upstreamRequestId } : {}),
          failureReason,
          error: result.error || "Generation failed",
        };
        persistRequest(requestRecord);
        if (execution !== "unknown") recordDefiniteFailure(result.error || "Generation failed");
        throw new CloudAttemptError(
          result.error || "Generation failed",
          execution,
          failureReason,
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        requestRecord = {
          ...requestRecord,
          status: "wait-cancelled",
          failureReason: "cancelled",
          error: "Local waiting was cancelled; the provider request may still be running.",
        };
        persistRequest(requestRecord);
        updateNodeData(node.id, {
          status: "wait-cancelled",
          error: requestRecord.error,
        });
        throw error;
      }

      if (error instanceof CloudAttemptError) throw error;

      // Convert network errors to user-friendly messages
      let errorMessage = "Generation failed";
      if (error instanceof TypeError && error.message.includes("NetworkError")) {
        errorMessage = "Network error. Check your connection and try again.";
      } else if (error instanceof TypeError) {
        errorMessage = `Network error: ${error.message}`;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      requestRecord = {
        ...requestRecord,
        status: "unknown",
        failureReason: "network",
        error: errorMessage,
      };
      persistRequest(requestRecord);
      updateNodeData(node.id, {
        status: "unknown",
        error: `${errorMessage} The provider may have executed; no automatic retry was sent.`,
      });
      throw new CloudAttemptError(errorMessage, "unknown", "network");
    }
  };

  // CRB-02: no clearOutput — a failed primary must not wipe the selected
  // result while the fallback is attempted, and a doubly-failed run must
  // leave outputImage, history, and carousel selection untouched (P06).
  await runWithFallback({
    nodeId: node.id,
    primary: primaryModel,
    fallback: nodeData.fallbackModel,
    fallbackParameters: nodeData.fallbackParameters,
    fallbackPolicy: nodeData.fallbackPolicy,
    fallbackEstimatedCost: nodeData.fallbackModel
      ? estimateSelectedModelCost(nodeData.fallbackModel, nodeData.resolution)
      : null,
    validateFallback: nodeData.fallbackModel
      ? () => checkReferenceGaps(
          imageCapabilities(nodeData.fallbackModel!.provider, nodeData.fallbackModel!.modelId),
          { references: images.map((image, index) => ({
            image,
            ...(imageRoles[index] ? { purpose: imageRoles[index] } : {}),
          })), prompt: finalPrompt },
          nodeData.fallbackModel,
        )[0]?.message ?? null
      : undefined,
    updateNodeData,
    runOnce,
  });
}
