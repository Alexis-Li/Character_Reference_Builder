/**
 * WaveSpeed Provider for Generate API Route
 *
 * Handles image/video generation using WaveSpeed API.
 * Uses async task submission + polling.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import {
  PROVIDER_RECIPIENTS,
  bindCredentialToDestination,
  credentialAllowedFor,
  type CredentialSource,
} from "@/lib/security/providerConnection";
import { downloadSafeMedia } from "@/lib/security/safeMedia.server";
import { redactSecretsDeep, redactSecretsInText } from "@/lib/security/secretRedaction";

const WAVESPEED_API_BASE = "https://api.wavespeed.ai/api/v3";

/**
 * Origins a WaveSpeed result may be downloaded from: the registered recipient
 * origins for the image role. Every hop is additionally checked for protocol,
 * resolved address, media type and size by the download seam.
 */
const WAVESPEED_MEDIA_ORIGINS: readonly string[] = [
  ...(PROVIDER_RECIPIENTS.wavespeed?.image ?? []),
];

/** Media types a WaveSpeed result may declare. */
const RESULT_MEDIA_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "application/octet-stream",
];

/** Path extensions accepted when a CDN answers with an opaque binary. */
const RESULT_MEDIA_EXTENSIONS: readonly string[] = [
  "png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", "mov", "glb", "gltf",
];

/** Downloaded result media was already capped at 500MB in this transport. */
const MAX_MEDIA_SIZE = 500 * 1024 * 1024;

type WaveSpeedStatus = "created" | "pending" | "processing" | "completed" | "failed";

/**
 * WaveSpeed submit response
 * Format: { code: 200, message: "success", data: { id, model, status, urls, created_at } }
 */
interface WaveSpeedSubmitResponse {
  code?: number;
  message?: string;
  data?: {
    id: string;
    model?: string;
    status?: WaveSpeedStatus;
    urls?: {
      get?: string;
    };
    created_at?: string;
  };
  // Fallback fields for other response formats
  id?: string;
  status?: WaveSpeedStatus;
  error?: string;
}

/**
 * WaveSpeed prediction/poll response (inner data object)
 */
interface WaveSpeedPredictionData {
  id: string;
  status: WaveSpeedStatus;
  outputs?: string[];
  output?: {
    images?: string[];
    videos?: string[];
  };
  timings?: {
    inference?: number;
  };
  created_at?: string;
  error?: string;
}

/**
 * WaveSpeed prediction/poll response wrapper
 * Format: { code: 200, message: "success", data: { id, status, outputs, ... } }
 */
interface WaveSpeedPredictionResponse {
  code?: number;
  message?: string;
  data?: WaveSpeedPredictionData;
  // Fallback: some responses might have fields at top level
  id?: string;
  status?: WaveSpeedStatus;
  outputs?: string[];
  error?: string;
}

/**
 * Generate image/video using WaveSpeed API
 * Uses async task submission + polling
 */
export async function generateWithWaveSpeed(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] WaveSpeed generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const modelId = input.model.id;

  // Validate modelId to prevent path traversal
  if (/[^a-zA-Z0-9\-_/.]/.test(modelId) || modelId.includes('..')) {
    return { success: false, error: `Invalid model ID: ${modelId}` };
  }

  // CRB-09: bind the credential to the recipient this call uses before it is
  // attached anywhere. The adapter receives a key value, not its provenance, so
  // provenance is resolved here: a value equal to this instance's environment
  // entry is a server-environment credential.
  const credentialSource: CredentialSource =
    process.env.WAVESPEED_API_KEY === apiKey ? "server-environment" : "browser-supplied";
  const { connection, credential } = bindCredentialToDestination({
    provider: "wavespeed",
    role: "image",
    endpoint: WAVESPEED_API_BASE,
    credential: apiKey,
    credentialKind: "api-key",
    credentialSource,
    userAuthorizedDestination: false,
  });

  if (!credential) {
    console.error(`[API:${requestId}] WaveSpeed credential withheld from ${WAVESPEED_API_BASE}: recipient not authorized`);
    return {
      success: false,
      error: `${input.model.name || "WaveSpeed"}: WaveSpeed credential is not authorized for this destination`,
    };
  }

  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}`);

  // Determine output type from model capabilities
  const is3DModel = input.model.capabilities.some(c => c.includes("3d"));
  const isVideoModel = input.model.capabilities.includes("text-to-video") ||
                       input.model.capabilities.includes("image-to-video");

  // Build WaveSpeed payload — spread parameters first so explicit prompt wins
  const payload: Record<string, unknown> = {
    ...input.parameters,
    prompt: input.prompt,
  };

  // Apply dynamic inputs (schema-mapped connections)
  // These have the correct parameter names from the schema (e.g., "images" for edit models)
  if (hasDynamicInputs) {
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        // If the key is "images" and value is not an array, wrap it
        if (key === "images" && !Array.isArray(value)) {
          payload[key] = [value];
        } else if (key !== "images" && Array.isArray(value)) {
          // Unwrap array to single value for non-array params
          payload[key] = value[0];
        } else {
          payload[key] = value;
        }
      }
    }
  } else if (input.images && input.images.length > 0) {
    // Fallback: if no dynamic inputs but images array is provided
    // Use "image" for single image (default WaveSpeed format)
    payload.image = input.images[0];
  }

  console.log(`[API:${requestId}] Submitting to WaveSpeed with inputs: ${Object.keys(payload).join(", ")}`);

  // Submit task
  // Model ID goes directly in the URL path (slashes are part of the path)
  const submitUrl = `${WAVESPEED_API_BASE}/${modelId}`;
  console.log(`[API:${requestId}] WaveSpeed submit URL: ${submitUrl}`);

  const submitResponse = await fetch(submitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    let errorDetail = errorText || `HTTP ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.error || errorJson.message || errorJson.detail || errorText || `HTTP ${submitResponse.status}`;
    } catch {
      // Keep original text
    }
    // CRB-09: upstream text can echo the credential or a signed URL.
    errorDetail = redactSecretsInText(String(errorDetail));

    console.error(`[API:${requestId}] WaveSpeed submit failed: ${submitResponse.status} - ${errorDetail}`);

    if (submitResponse.status === 429) {
      return {
        success: false,
        error: `${input.model.name || 'WaveSpeed'}: Rate limit exceeded. Try again in a moment.`,
      };
    }

    return {
      success: false,
      error: `${input.model.name || 'WaveSpeed'}: ${errorDetail}`,
    };
  }

  const submitResult: WaveSpeedSubmitResponse = await submitResponse.json();
  console.log(`[API:${requestId}] WaveSpeed submit response:`, JSON.stringify(redactSecretsDeep(submitResult, { secretFields: "replace" })).substring(0, 500));

  const taskId = submitResult.data?.id || submitResult.id;
  // Use the polling URL provided by the API if available, only when it stays on
  // the connection's authorized recipient.
  let providedPollUrl: string | undefined = submitResult.data?.urls?.get;
  if (providedPollUrl) {
    // CRB-09: the credential may not follow a Provider-supplied URL to another host.
    if (!credentialAllowedFor(connection, providedPollUrl)) {
      console.warn(`[API:${requestId}] WaveSpeed provided a poll URL outside the authorized recipient: ${redactSecretsInText(providedPollUrl)} — falling back to constructed URL`);
      providedPollUrl = undefined;
    }
  }

  if (!taskId) {
    console.error(`[API:${requestId}] No task ID in WaveSpeed submit response`);
    return {
      success: false,
      error: "WaveSpeed: No task ID returned from API",
    };
  }

  console.log(`[API:${requestId}] WaveSpeed task submitted: ${taskId}`);
  if (providedPollUrl) {
    console.log(`[API:${requestId}] WaveSpeed provided poll URL: ${redactSecretsInText(providedPollUrl)}`);
  }

  // Poll for completion using the URL from the API response, or construct it
  // Status flow: created → processing → completed/failed
  const maxWaitTime = 5 * 60 * 1000; // 5 minutes
  const pollInterval = 1000; // 1 second
  const startTime = Date.now();
  let lastStatus = "";

  let resultData: WaveSpeedPredictionResponse | null = null;

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      console.error(`[API:${requestId}] WaveSpeed task timed out after 5 minutes`);
      return {
        success: false,
        error: `${input.model.name}: Generation timed out after 5 minutes`,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      // Use provided poll URL if available, otherwise construct it
      const pollUrl = providedPollUrl || `${WAVESPEED_API_BASE}/predictions/${taskId}/result`;
      const pollResponse = await fetch(
        pollUrl,
        {
          headers: {
            Authorization: `Bearer ${credential}`,
          },
        }
      );

      // Log poll response status for debugging
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      console.log(`[API:${requestId}] WaveSpeed poll (${elapsedSec}s): ${pollResponse.status} from ${redactSecretsInText(pollUrl)}`);

      // 404 means result not ready yet - continue polling
      if (pollResponse.status === 404) {
        lastStatus = "pending";
        continue;
      }

      if (!pollResponse.ok) {
        const errorText = await pollResponse.text();
        let errorDetail = errorText || `HTTP ${pollResponse.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail = errorJson.error || errorJson.message || errorJson.detail || errorDetail;
        } catch {
          // Keep original text
        }
        // CRB-09: upstream text can echo the credential or a signed URL.
        errorDetail = redactSecretsInText(String(errorDetail));
        console.error(`[API:${requestId}] WaveSpeed poll failed: ${pollResponse.status} - ${errorDetail}`);
        return {
          success: false,
          error: `${input.model.name}: ${errorDetail}`,
        };
      }

      const pollData: WaveSpeedPredictionResponse = await pollResponse.json();
      console.log(`[API:${requestId}] WaveSpeed poll data:`, JSON.stringify(redactSecretsDeep(pollData, { secretFields: "replace" })).substring(0, 300));

      // Extract status from nested data object (WaveSpeed wraps response in { code, message, data: {...} })
      const currentStatus = pollData.data?.status || pollData.status;
      const currentError = pollData.data?.error || pollData.error;

      // Log status changes
      if (currentStatus !== lastStatus) {
        console.log(`[API:${requestId}] WaveSpeed status changed: ${lastStatus} → ${currentStatus}`);
        lastStatus = currentStatus || "";
      }

      // Check if task is complete
      if (currentStatus === "completed") {
        console.log(`[API:${requestId}] WaveSpeed task completed`);
        resultData = pollData;
        break;
      }

      // Check if task failed
      if (currentStatus === "failed") {
        const failureReason = redactSecretsInText(String(currentError || pollData.message || "Generation failed"));
        console.error(`[API:${requestId}] WaveSpeed task failed: ${failureReason}`);
        return {
          success: false,
          error: `${input.model.name}: ${failureReason}`,
        };
      }

      // Continue polling for "created" or "processing" status
    } catch (pollError) {
      const message = redactSecretsInText(pollError instanceof Error ? pollError.message : String(pollError));
      console.error(`[API:${requestId}] WaveSpeed poll error: ${message}`);
      return {
        success: false,
        error: `${input.model.name}: ${message}`,
      };
    }
  }

  // Safety check (should never happen since we break on completed)
  if (!resultData) {
    return {
      success: false,
      error: `${input.model.name}: No result received`,
    };
  }

  // Extract outputs - WaveSpeed wraps response in { code, message, data: { outputs: [...] } }
  let outputUrls: string[] = [];
  const resultDataInner = resultData.data;

  // Format 1: data.outputs array (standard WaveSpeed format)
  if (resultDataInner?.outputs && Array.isArray(resultDataInner.outputs) && resultDataInner.outputs.length > 0) {
    outputUrls = resultDataInner.outputs;
  }
  // Format 2: data.output object with images/videos arrays
  else if (resultDataInner?.output) {
    if (isVideoModel && resultDataInner.output.videos && resultDataInner.output.videos.length > 0) {
      outputUrls = resultDataInner.output.videos;
    } else if (resultDataInner.output.images && resultDataInner.output.images.length > 0) {
      outputUrls = resultDataInner.output.images;
    }
  }
  // Format 3: Fallback - outputs at top level (unlikely but safe)
  else if (resultData.outputs && Array.isArray(resultData.outputs) && resultData.outputs.length > 0) {
    outputUrls = resultData.outputs;
  }

  if (outputUrls.length === 0) {
    console.error(`[API:${requestId}] No outputs in WaveSpeed result. Response:`, JSON.stringify(redactSecretsDeep(resultData, { secretFields: "replace" })).substring(0, 500));
    return {
      success: false,
      error: `${input.model.name}: No outputs in generation result`,
    };
  }

  // Fetch the first output and convert to base64
  const outputUrl = outputUrls[0];

  // CRB-09: a result URL must stay inside the Provider's registered output
  // origins before this process downloads it or hands it to the client.
  let outputOrigin: string | null = null;
  try {
    outputOrigin = new URL(outputUrl).origin;
  } catch {
    outputOrigin = null;
  }
  if (!outputOrigin || !WAVESPEED_MEDIA_ORIGINS.includes(outputOrigin)) {
    console.error(`[API:${requestId}] Invalid output URL from WaveSpeed: ${redactSecretsInText(outputUrl)}`);
    return { success: false, error: "Invalid output URL: destination-not-authorized" };
  }

  // For 3D models, return URL directly (GLB files are binary — skip downloading/buffering)
  if (is3DModel) {
    console.log(`[API:${requestId}] SUCCESS - Returning 3D model URL`);
    return {
      success: true,
      outputs: [
        {
          type: "3d",
          data: "",
          url: outputUrl,
        },
      ],
    };
  }

  console.log(`[API:${requestId}] Fetching WaveSpeed output from: ${redactSecretsInText(outputUrl).substring(0, 80)}...`);

  // Every hop of the download — protocol, resolved address, authorized origin,
  // media type and size — is validated instead of trusting the Provider's URL.
  const outputDownload = await downloadSafeMedia(outputUrl, {
    authorizedOrigins: WAVESPEED_MEDIA_ORIGINS,
    allowedMediaTypes: RESULT_MEDIA_TYPES,
    allowOctetStreamForMediaPaths: true,
    extensionsForOpaqueMedia: RESULT_MEDIA_EXTENSIONS,
    maxBytes: MAX_MEDIA_SIZE,
  });

  if (!outputDownload.ok) {
    console.error(`[API:${requestId}] Invalid output URL from WaveSpeed: ${redactSecretsInText(outputUrl)} (${outputDownload.reason}${outputDownload.detail ? `: ${outputDownload.detail}` : ""})`);
    return {
      success: false,
      error: `Invalid output URL: ${outputDownload.reason}${outputDownload.detail ? ` (${outputDownload.detail})` : ""}`,
    };
  }

  const outputArrayBuffer = outputDownload.bytes;
  const outputSizeMB = outputArrayBuffer.byteLength / (1024 * 1024);

  const isAudioModel = input.model.capabilities.some(c => c.includes("audio"));
  const rawContentType = outputDownload.mediaType;
  const contentType =
    (rawContentType.startsWith("video/") || rawContentType.startsWith("image/") || rawContentType.startsWith("audio/"))
      ? rawContentType
      : (isVideoModel ? "video/mp4" : isAudioModel ? "audio/mpeg" : "image/png");

  console.log(`[API:${requestId}] Output: ${contentType}, ${outputSizeMB.toFixed(2)}MB`);

  // For very large videos (>20MB), return URL only (data left empty for consumers)
  if (isVideoModel && outputSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      outputs: [
        {
          type: "video",
          data: "",
          url: outputUrl,
        },
      ],
    };
  }

  const outputBase64 = Buffer.from(outputArrayBuffer).toString("base64");
  const isAudio = contentType.startsWith("audio/") || isAudioModel;

  if (isAudio) {
    const audioContentType = contentType.startsWith("audio/") ? contentType : "audio/mpeg";
    console.log(`[API:${requestId}] SUCCESS - Returning audio`);
    return {
      success: true,
      outputs: [
        {
          type: "audio",
          data: `data:${audioContentType};base64,${outputBase64}`,
          url: outputUrl,
        },
      ],
    };
  }

  console.log(`[API:${requestId}] SUCCESS - Returning ${isVideoModel ? "video" : "image"}`);

  return {
    success: true,
    outputs: [
      {
        type: isVideoModel ? "video" : "image",
        data: `data:${contentType};base64,${outputBase64}`,
        url: outputUrl,
      },
    ],
  };
}

