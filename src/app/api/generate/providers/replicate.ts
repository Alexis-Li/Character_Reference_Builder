/**
 * Replicate Provider for Generate API Route
 *
 * Handles image/video generation using Replicate's prediction API.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import {
  PROVIDER_RECIPIENTS,
  bindCredentialToDestination,
  type CredentialSource,
} from "@/lib/security/providerConnection";
import { downloadSafeMedia } from "@/lib/security/safeMedia.server";
import { redactSecretsInText } from "@/lib/security/secretRedaction";
import {
  getParameterTypesFromSchema,
  coerceParameterTypes,
  getInputMappingFromSchema,
} from "../schemaUtils";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

/**
 * Origins a Replicate result may be downloaded from: the registered recipient
 * origins for the image role plus the CDN Replicate serves prediction outputs
 * from. Every hop is additionally checked for protocol, resolved address,
 * media type and size by the download seam.
 */
const REPLICATE_MEDIA_ORIGINS: readonly string[] = [
  ...(PROVIDER_RECIPIENTS.replicate?.image ?? []),
  "https://replicate.delivery",
];

/** Media types a Replicate result may declare. */
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

/** No cap was declared before; bound the buffered result at 500MB like Kie/WaveSpeed. */
const MAX_MEDIA_SIZE = 500 * 1024 * 1024;

/**
 * Generate image using Replicate API
 */
export async function generateWithReplicate(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] Replicate generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  // CRB-09: bind the credential to the recipient this call uses before it is
  // attached anywhere. The adapter receives a key value, not its provenance, so
  // provenance is resolved here: a value equal to this instance's environment
  // entry is a server-environment credential.
  const credentialSource: CredentialSource =
    process.env.REPLICATE_API_KEY === apiKey ? "server-environment" : "browser-supplied";
  const { credential } = bindCredentialToDestination({
    provider: "replicate",
    role: "image",
    endpoint: REPLICATE_API_BASE,
    credential: apiKey,
    credentialKind: "api-key",
    credentialSource,
    userAuthorizedDestination: false,
  });

  if (!credential) {
    console.error(`[API:${requestId}] Replicate credential withheld from ${REPLICATE_API_BASE}: recipient not authorized`);
    return {
      success: false,
      error: `${input.model.name}: Replicate credential is not authorized for this destination`,
    };
  }

  // Get the latest version of the model
  const modelId = input.model.id;
  const [owner, name] = modelId.split("/");

  if (!owner || !name) {
    return {
      success: false,
      error: `Invalid Replicate model ID "${modelId}": expected "owner/name" format`,
    };
  }

  // First, get the model to find the latest version
  const modelResponse = await fetch(
    `${REPLICATE_API_BASE}/models/${owner}/${name}`,
    {
      headers: {
        Authorization: `Bearer ${credential}`,
      },
    }
  );

  if (!modelResponse.ok) {
    return {
      success: false,
      error: `Failed to get model info: ${modelResponse.status}`,
    };
  }

  const modelData = await modelResponse.json();
  const version = modelData.latest_version?.id;

  if (!version) {
    return {
      success: false,
      error: "Model has no available version",
    };
  }

  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Model version: ${version}, Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}`);

  // Get schema for type coercion and input mapping
  const schema = modelData.latest_version?.openapi_schema as Record<string, unknown> | undefined;
  const parameterTypes = getParameterTypesFromSchema(schema);

  // Build input for the prediction - parameters are applied per-path below to avoid double-spreading
  const predictionInput: Record<string, unknown> = {};

  // Add dynamic inputs if provided (these come from schema-mapped connections)
  if (hasDynamicInputs) {
    // Apply coerced parameters first, then dynamic inputs override
    Object.assign(predictionInput, coerceParameterTypes(input.parameters, parameterTypes));
    const { paramMap, schemaArrayParams } = getInputMappingFromSchema(schema);

    // Apply array wrapping based on schema type
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        if (schemaArrayParams.has(key) && !Array.isArray(value)) {
          predictionInput[key] = [value];  // Wrap in array
        } else if (!schemaArrayParams.has(key) && Array.isArray(value)) {
          predictionInput[key] = value[0];  // Unwrap array to single value
        } else {
          predictionInput[key] = value;
        }
      }
    }

    // Ensure prompt is included even when dynamicInputs are present
    // (executor sends prompt as top-level field, not in dynamicInputs)
    const promptParam = paramMap.prompt || "prompt";
    if (input.prompt && !predictionInput[promptParam]) {
      predictionInput[promptParam] = input.prompt;
    }
  } else {
    // Fallback: use schema to map generic input names to model-specific parameter names
    const { paramMap, arrayParams } = getInputMappingFromSchema(schema);

    // Map prompt input
    if (input.prompt) {
      const promptParam = paramMap.prompt || "prompt";
      predictionInput[promptParam] = input.prompt;
    }

    // Map image input - use array or string format based on schema
    if (input.images && input.images.length > 0) {
      const imageParam = paramMap.image || "image";
      if (arrayParams.has("image")) {
        predictionInput[imageParam] = input.images;
      } else {
        predictionInput[imageParam] = input.images[0];
      }
    }

    // Map any parameters that might need renaming (use coerced values)
    const coercedParams = coerceParameterTypes(input.parameters, parameterTypes);
    for (const [key, value] of Object.entries(coercedParams)) {
      const mappedKey = paramMap[key] || key;
      predictionInput[mappedKey] = value;
    }
  }

  // Create a prediction
  const createResponse = await fetch(`${REPLICATE_API_BASE}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version,
      input: predictionInput,
    }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    let errorDetail = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.detail || errorJson.message || errorJson.error || errorText;
    } catch {
      // Keep original text if not JSON
    }
    // CRB-09: upstream text can echo the credential or a signed URL.
    errorDetail = redactSecretsInText(String(errorDetail));

    // Handle rate limits
    if (createResponse.status === 429) {
      return {
        success: false,
        error: `${input.model.name}: Rate limit exceeded. Try again in a moment.`,
      };
    }

    return {
      success: false,
      error: `${input.model.name}: ${errorDetail}`,
    };
  }

  const prediction = await createResponse.json();
  console.log(`[API:${requestId}] Prediction created: ${prediction.id}`);

  // Poll for completion — video models get a longer timeout
  const isVideoModel = input.model.capabilities.some(c => c.includes("video"));
  const maxWaitTime = isVideoModel ? 10 * 60 * 1000 : 5 * 60 * 1000;
  const pollInterval = 1000; // 1 second
  const startTime = Date.now();

  let currentPrediction = prediction;
  let lastStatus = "";

  while (
    currentPrediction.status !== "succeeded" &&
    currentPrediction.status !== "failed" &&
    currentPrediction.status !== "canceled"
  ) {
    if (Date.now() - startTime > maxWaitTime) {
      return {
        success: false,
        error: `${input.model.name}: Generation timed out after ${maxWaitTime / 60000} minutes.`,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const pollResponse = await fetch(
      `${REPLICATE_API_BASE}/predictions/${currentPrediction.id}`,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
        },
      }
    );

    if (!pollResponse.ok) {
      return {
        success: false,
        error: `Failed to poll prediction: ${pollResponse.status}`,
      };
    }

    currentPrediction = await pollResponse.json();
    if (currentPrediction.status !== lastStatus) {
      console.log(`[API:${requestId}] Prediction status: ${currentPrediction.status}`);
      lastStatus = currentPrediction.status;
    }
  }

  if (currentPrediction.status === "failed") {
    const failureReason = currentPrediction.error || "Prediction failed";
    return {
      success: false,
      error: `${input.model.name}: ${failureReason}`,
    };
  }

  if (currentPrediction.status === "canceled") {
    return {
      success: false,
      error: "Prediction was canceled",
    };
  }

  // Extract output
  const output = currentPrediction.output;
  if (!output) {
    return {
      success: false,
      error: "No output from prediction",
    };
  }

  // Output can be a single URL string or an array — filter to valid strings only
  const rawOutputs = Array.isArray(output) ? output : [output];
  const outputUrls: string[] = rawOutputs.filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );

  if (outputUrls.length === 0) {
    return {
      success: false,
      error: "No output from prediction",
    };
  }

  // Fetch the first output and convert to base64
  const mediaUrl = outputUrls[0];

  // CRB-09: a result URL must stay inside the Provider's registered output
  // origins before this process downloads it or hands it to the client.
  let resultOrigin: string | null = null;
  try {
    resultOrigin = new URL(mediaUrl).origin;
  } catch {
    resultOrigin = null;
  }
  if (!resultOrigin || !REPLICATE_MEDIA_ORIGINS.includes(resultOrigin)) {
    console.error(`[API:${requestId}] Invalid media URL from Replicate: ${redactSecretsInText(mediaUrl)}`);
    return { success: false, error: "Invalid media URL: destination-not-authorized" };
  }

  // Check if this is a 3D model — return URL directly (GLB files are binary).
  // Short-circuit before fetching so we never download the potentially large GLB binary.
  const is3DModel = input.model.capabilities.some(c => c.includes("3d"));
  if (is3DModel) {
    console.log(`[API:${requestId}] SUCCESS - Returning 3D model URL`);
    return {
      success: true,
      outputs: [
        {
          type: "3d",
          data: "",
          url: mediaUrl,
        },
      ],
    };
  }

  console.log(`[API:${requestId}] Fetching output from: ${redactSecretsInText(mediaUrl).substring(0, 80)}...`);
  // Every hop of the download — protocol, resolved address, authorized origin,
  // media type and size — is validated instead of trusting the Provider's URL.
  const mediaDownload = await downloadSafeMedia(mediaUrl, {
    authorizedOrigins: REPLICATE_MEDIA_ORIGINS,
    allowedMediaTypes: RESULT_MEDIA_TYPES,
    allowOctetStreamForMediaPaths: true,
    extensionsForOpaqueMedia: RESULT_MEDIA_EXTENSIONS,
    maxBytes: MAX_MEDIA_SIZE,
  });

  if (!mediaDownload.ok) {
    console.error(`[API:${requestId}] Invalid media URL from Replicate: ${redactSecretsInText(mediaUrl)} (${mediaDownload.reason}${mediaDownload.detail ? `: ${mediaDownload.detail}` : ""})`);
    return {
      success: false,
      error: `Invalid media URL: ${mediaDownload.reason}${mediaDownload.detail ? ` (${mediaDownload.detail})` : ""}`,
    };
  }

  const contentType = mediaDownload.mediaType;
  const isVideo = contentType.startsWith("video/");
  const isConcreteMedia = contentType.startsWith("audio/") || isVideo || contentType.startsWith("image/");
  const isAudio = contentType.startsWith("audio/") ||
    (!isConcreteMedia && input.model.capabilities.some(c => c.includes("audio")));

  const mediaArrayBuffer = mediaDownload.bytes;
  const mediaSizeBytes = mediaArrayBuffer.byteLength;
  const mediaSizeMB = mediaSizeBytes / (1024 * 1024);

  console.log(`[API:${requestId}] Output: ${contentType}, ${mediaSizeMB.toFixed(2)}MB`);

  // For very large videos (>20MB), return URL only (data left empty for consumers)
  if (isVideo && mediaSizeMB > 20) {
    console.log(`[API:${requestId}] SUCCESS - Returning URL for large video`);
    return {
      success: true,
      outputs: [
        {
          type: "video",
          data: "",
          url: mediaUrl,
        },
      ],
    };
  }

  const mediaBase64 = Buffer.from(mediaArrayBuffer).toString("base64");

  if (isAudio) {
    const audioContentType = contentType.startsWith("audio/") ? contentType : "audio/mpeg";
    console.log(`[API:${requestId}] SUCCESS - Returning audio`);
    return {
      success: true,
      outputs: [
        {
          type: "audio",
          data: `data:${audioContentType};base64,${mediaBase64}`,
          url: mediaUrl,
        },
      ],
    };
  }

  console.log(`[API:${requestId}] SUCCESS - Returning ${isVideo ? "video" : "image"}`);

  return {
    success: true,
    outputs: [
      {
        type: isVideo ? "video" : "image",
        data: `data:${contentType};base64,${mediaBase64}`,
        url: mediaUrl,
      },
    ],
  };
}
