/**
 * fal.ai Provider for Generate API Route
 *
 * Handles image/video generation using fal.ai's Queue API.
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import {
  PROVIDER_RECIPIENTS,
  bindCredentialToDestination,
  credentialAllowedFor,
  type CredentialSource,
} from "@/lib/security/providerConnection";
import { downloadSafeMedia } from "@/lib/security/safeMedia.server";
import {
  activeAddressResolver,
  checkNetworkTarget,
  originInList,
} from "@/lib/security/networkTargets.server";
import { redactSecretsDeep, redactSecretsInText } from "@/lib/security/secretRedaction";
import {
  INPUT_PATTERNS,
  InputMapping,
  ParameterTypeInfo,
  coerceParameterTypes,
} from "../schemaUtils";

const FAL_CATALOG_API_BASE = "https://api.fal.ai/v1";
const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_UPLOAD_INITIATE_URL = "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";

/**
 * Origins a fal.ai result may be downloaded from: the registered recipient
 * origins for the image role plus the CDNs fal.ai serves generated media from.
 * Every hop is additionally checked for protocol, resolved address, media type
 * and size by the download seam.
 */
const FAL_MEDIA_ORIGINS: readonly string[] = [
  ...(PROVIDER_RECIPIENTS.fal?.image ?? []),
  "https://fal.media",
  "https://cdn.fal.media",
  "https://cdn.fal.ai",
];

/** Media types a fal.ai result may declare. */
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

/**
 * Storage origins fal.ai may name for a signed upload and for the uploaded file
 * URL. The caller's image bytes are PUT only to one of these hosts, and the
 * resolved address of that host still has to be public.
 */
const FAL_CDN_UPLOAD_ORIGINS: readonly string[] = [
  "https://fal.ai",
  "https://cdn.fal.ai",
  "https://fal.media",
  "https://cdn.fal.media",
  "https://rest.alpha.fal.ai",
];

/**
 * Extended input mapping with parameter types for fal.ai
 */
interface FalInputMapping extends InputMapping {
  parameterTypes: ParameterTypeInfo;
}

/**
 * In-memory cache for fal.ai schema mappings to avoid extra API call per generation
 */
const falInputMappingCache = new Map<string, { result: FalInputMapping; timestamp: number }>();
const FAL_MAPPING_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/** Clear the fal schema mapping cache (exported for testing) */
export function clearFalInputMappingCache() {
  falInputMappingCache.clear();
}

/**
 * Fetch fal.ai model schema and extract input parameter mappings
 * Uses the Model Search API with OpenAPI expansion (same as /api/models/[modelId])
 * Results are cached in-memory for 30 minutes per model.
 */
async function getFalInputMapping(modelId: string, apiKey: string | null): Promise<FalInputMapping> {
  // Check cache first
  const cached = falInputMappingCache.get(modelId);
  if (cached && Date.now() - cached.timestamp < FAL_MAPPING_CACHE_TTL) {
    return cached.result;
  }
  const paramMap: Record<string, string> = {};
  const arrayParams = new Set<string>();
  const schemaArrayParams = new Set<string>();
  const parameterTypes: ParameterTypeInfo = {};

  try {
    // Use fal.ai Model Search API with OpenAPI expansion
    // CRB-09: the credential is bound to the catalog recipient before it is
    // attached; only the bound value is sent.
    const credentialSource: CredentialSource =
      process.env.FAL_API_KEY === apiKey ? "server-environment" : "browser-supplied";
    const { credential } = bindCredentialToDestination({
      provider: "fal",
      role: "image",
      endpoint: FAL_CATALOG_API_BASE,
      credential: apiKey,
      credentialKind: "api-key",
      credentialSource,
      userAuthorizedDestination: false,
    });

    const headers: Record<string, string> = {};
    if (credential) {
      headers["Authorization"] = `Key ${credential}`;
    }

    const url = `${FAL_CATALOG_API_BASE}/models?endpoint_id=${encodeURIComponent(modelId)}&expand=openapi-3.0`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes };
    }

    const data = await response.json();
    const modelData = data.models?.[0];
    if (!modelData?.openapi) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes };
    }

    // Extract input schema from OpenAPI spec (same logic as /api/models/[modelId])
    const spec = modelData.openapi;
    let inputSchema: Record<string, unknown> | null = null;

    for (const pathObj of Object.values(spec.paths || {})) {
      const postOp = (pathObj as Record<string, unknown>)?.post as Record<string, unknown> | undefined;
      const reqBody = postOp?.requestBody as Record<string, unknown> | undefined;
      const content = reqBody?.content as Record<string, Record<string, unknown>> | undefined;
      const jsonContent = content?.["application/json"];

      if (jsonContent?.schema) {
        const schema = jsonContent.schema as Record<string, unknown>;
        if (schema.$ref && typeof schema.$ref === "string") {
          const refPath = schema.$ref.replace("#/components/schemas/", "");
          inputSchema = spec.components?.schemas?.[refPath] as Record<string, unknown>;
          break;
        } else if (schema.properties) {
          inputSchema = schema;
          break;
        }
      }
    }

    if (!inputSchema) {
      return { paramMap, arrayParams, schemaArrayParams, parameterTypes };
    }

    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    if (!properties) return { paramMap, arrayParams, schemaArrayParams, parameterTypes };

    // First pass: detect all array-typed properties and extract parameter types
    // This is used for dynamicInputs which use schema names directly
    for (const [propName, prop] of Object.entries(properties)) {
      const property = prop as Record<string, unknown>;
      if (property?.type === "array") {
        schemaArrayParams.add(propName);
      }
      // Extract parameter type for type coercion
      const type = property?.type as string | undefined;
      if (type && ["string", "integer", "number", "boolean", "array", "object"].includes(type)) {
        parameterTypes[propName] = type as ParameterTypeInfo[string];
      }
    }

    // Second pass: match properties to INPUT_PATTERNS and detect array types
    const propertyNames = Object.keys(properties);
    for (const [genericName, patterns] of Object.entries(INPUT_PATTERNS)) {
      for (const pattern of patterns) {
        let matchedParam: string | null = null;

        // Check for exact match first
        if (properties[pattern]) {
          matchedParam = pattern;
        } else {
          // Check for case-insensitive partial match
          const match = propertyNames.find(name =>
            name.toLowerCase().includes(pattern.toLowerCase()) ||
            pattern.toLowerCase().includes(name.toLowerCase())
          );
          if (match) {
            matchedParam = match;
          }
        }

        if (matchedParam) {
          paramMap[genericName] = matchedParam;
          // Check if this property expects an array type
          const property = properties[matchedParam] as Record<string, unknown>;
          if (property?.type === "array") {
            arrayParams.add(genericName);
          }
          break;
        }
      }
    }

    const result = { paramMap, arrayParams, schemaArrayParams, parameterTypes };
    falInputMappingCache.set(modelId, { result, timestamp: Date.now() });
    return result;
  } catch {
    // Schema parsing failed - return defaults without caching so next call retries
    return { paramMap, arrayParams, schemaArrayParams, parameterTypes };
  }
}

export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20 MB

/** Maximum size for downloaded result media (mirrors kie.ts / wavespeed.ts) */
const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB

/**
 * Upload a base64 data URL image to fal.ai CDN storage.
 * Returns the CDN URL to use in API requests instead of inline base64.
 * If the input is already a URL (not base64), returns it as-is.
 */
export async function uploadImageToFal(base64DataUrl: string, apiKey: string | null): Promise<string> {
  // Already a URL, not base64
  if (!base64DataUrl.startsWith("data:")) return base64DataUrl;

  const match = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return base64DataUrl;

  const estimatedBytes = Math.ceil(match[2].length * 3 / 4);
  if (estimatedBytes > MAX_UPLOAD_SIZE) {
    throw new Error(`Image too large to upload (${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB, max ${MAX_UPLOAD_SIZE / (1024 * 1024)} MB)`);
  }

  const contentType = match[1];
  const binaryData = Buffer.from(match[2], "base64");

  // CRB-09: bind the credential to the CDN upload recipient before attaching it.
  const credentialSource: CredentialSource =
    process.env.FAL_API_KEY === apiKey ? "server-environment" : "browser-supplied";
  const { credential } = bindCredentialToDestination({
    provider: "fal",
    role: "image",
    endpoint: FAL_UPLOAD_INITIATE_URL,
    credential: apiKey,
    credentialKind: "api-key",
    credentialSource,
    userAuthorizedDestination: false,
  });

  const authHeaders: Record<string, string> = {};
  if (credential) authHeaders["Authorization"] = `Key ${credential}`;

  // Step 1: Initiate upload to get a signed PUT URL
  const ext = contentType.split("/")[1] || "png";
  const initiateResponse = await fetch(
    FAL_UPLOAD_INITIATE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({
        content_type: contentType,
        file_name: `${Date.now()}.${ext}`,
      }),
    }
  );

  if (!initiateResponse.ok) {
    throw new Error(`Failed to initiate fal CDN upload: ${initiateResponse.status}`);
  }

  const { upload_url: uploadUrl, file_url: fileUrl } = await initiateResponse.json();

  // Validate both URLs before using them (SSRF protection)
  if (!uploadUrl || !fileUrl) {
    throw new Error("fal CDN initiate response missing upload_url or file_url");
  }

  // CRB-09: the signed URLs are named by the Provider response. They are
  // accepted only when they point at a fal-controlled storage origin, and the
  // PUT target additionally has to resolve to public addresses only — a DNS
  // name or an IPv4-mapped literal aimed at loopback, private, link-local or
  // metadata space is refused. The PUT carries no credential.
  if (!originInList(uploadUrl, FAL_CDN_UPLOAD_ORIGINS)) {
    throw new Error(`fal CDN upload_url failed validation: not an authorized fal storage origin`);
  }
  if (!originInList(fileUrl, FAL_CDN_UPLOAD_ORIGINS)) {
    throw new Error(`fal CDN file_url failed validation: not an authorized fal storage origin`);
  }

  const uploadTargetCheck = await checkNetworkTarget(uploadUrl, { resolve: activeAddressResolver() });
  if (!uploadTargetCheck.ok) {
    throw new Error(`fal CDN upload_url failed validation: ${uploadTargetCheck.reason ?? "blocked-address"}`);
  }

  // Step 2: PUT the binary data to the validated signed URL. A signed storage
  // PUT is a single hop: a redirect would move the caller's bytes to a host
  // that was never address-checked, so it is refused instead of followed.
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: binaryData,
    redirect: "manual",
  });

  if (putResponse.status >= 300 && putResponse.status < 400) {
    throw new Error(`Failed to upload to fal CDN: unexpected redirect ${putResponse.status}`);
  }

  if (!putResponse.ok) {
    throw new Error(`Failed to upload to fal CDN: ${putResponse.status}`);
  }

  return fileUrl;
}

/**
 * Generate using fal.ai Queue API
 * Uses async queue submission + polling (1s interval) instead of blocking fal.run.
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 */
export async function generateWithFalQueue(
  requestId: string,
  apiKey: string | null,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] fal.ai queue generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, Prompt: ${input.prompt.length} chars`);

  const modelId = input.model.id;
  const hasDynamicInputs = input.dynamicInputs && Object.keys(input.dynamicInputs).length > 0;
  console.log(`[API:${requestId}] Dynamic inputs: ${hasDynamicInputs ? Object.keys(input.dynamicInputs!).join(", ") : "none"}, API key: ${apiKey ? "yes" : "no"}`);

  // Fetch schema for type coercion and input mapping (cached)
  const { paramMap, arrayParams, schemaArrayParams, parameterTypes } = await getFalInputMapping(modelId, apiKey);

  // Build request body - parameters are applied per-path below to avoid double-spreading
  const requestBody: Record<string, unknown> = {};

  // Upload base64 images to fal CDN to avoid sending large payloads inline
  const uploadImage = async (value: string | string[]): Promise<string | string[]> => {
    if (Array.isArray(value)) {
      return Promise.all(value.map(v => typeof v === "string" && v.startsWith("data:") ? uploadImageToFal(v, apiKey) : Promise.resolve(v)));
    }
    if (typeof value === "string" && value.startsWith("data:")) {
      return uploadImageToFal(value, apiKey);
    }
    return value;
  };

  if (hasDynamicInputs) {
    // Apply coerced parameters first, then dynamic inputs override
    Object.assign(requestBody, coerceParameterTypes(input.parameters, parameterTypes));
    const filteredInputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.dynamicInputs!)) {
      if (value !== null && value !== undefined && value !== '') {
        let processedValue: unknown = value;
        // Upload base64 images to CDN
        if (typeof value === "string" || Array.isArray(value)) {
          processedValue = await uploadImage(value);
        }
        // Wrap in array if schema expects array but we have a single value
        if (schemaArrayParams.has(key) && !Array.isArray(processedValue)) {
          filteredInputs[key] = [processedValue];
        } else if (!schemaArrayParams.has(key) && Array.isArray(processedValue)) {
          // Unwrap array to single value if schema expects a string (e.g. image_url)
          if (processedValue.length > 0) {
            filteredInputs[key] = processedValue[0];
          }
        } else {
          filteredInputs[key] = processedValue;
        }
      }
    }
    Object.assign(requestBody, filteredInputs);

    // Ensure prompt is included even when dynamicInputs are present
    // (executor sends prompt as top-level field, not in dynamicInputs)
    const promptParam = paramMap.prompt || "prompt";
    if (input.prompt && !requestBody[promptParam]) {
      requestBody[promptParam] = input.prompt;
    }
  } else {
    // Fallback: use schema to map generic input names to model-specific parameter names
    if (input.prompt) {
      const promptParam = paramMap.prompt || "prompt";
      requestBody[promptParam] = input.prompt;
    }

    if (input.images && input.images.length > 0) {
      // Upload images to CDN before sending
      const uploadedImages = await Promise.all(
        input.images.map(img => uploadImageToFal(img, apiKey))
      );
      const imageParam = paramMap.image || "image_url";
      if (arrayParams.has("image")) {
        requestBody[imageParam] = uploadedImages;
      } else {
        requestBody[imageParam] = uploadedImages[0];
      }
    }

    // Map any parameters that might need renaming (use coerced values)
    const coercedParams = coerceParameterTypes(input.parameters, parameterTypes);
    for (const [key, value] of Object.entries(coercedParams)) {
      const mappedKey = paramMap[key] || key;
      requestBody[mappedKey] = value;
    }
  }

  // CRB-09: bind the credential to the queue recipient (the submit URL) before
  // it is attached anywhere. The adapter receives a key value, not its
  // provenance, so provenance is resolved here: a value equal to this
  // instance's environment entry is a server-environment credential.
  const credentialSource: CredentialSource =
    process.env.FAL_API_KEY === apiKey ? "server-environment" : "browser-supplied";
  const { connection, credential } = bindCredentialToDestination({
    provider: "fal",
    role: "image",
    endpoint: `${FAL_QUEUE_BASE}/${modelId}`,
    credential: apiKey,
    credentialKind: apiKey ? "api-key" : "none",
    credentialSource,
    userAuthorizedDestination: false,
  });

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (credential) {
    headers["Authorization"] = `Key ${credential}`;
  }

  // Submit to queue
  console.log(`[API:${requestId}] Submitting to fal.ai queue with inputs: ${Object.keys(requestBody).join(", ")}`);
  const submitResponse = await fetch(`${FAL_QUEUE_BASE}/${modelId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    let errorDetail = errorText || `HTTP ${submitResponse.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      if (typeof errorJson.error === 'object' && errorJson.error?.message) {
        errorDetail = errorJson.error.message;
      } else if (errorJson.detail) {
        if (Array.isArray(errorJson.detail)) {
          errorDetail = errorJson.detail.map((d: { msg?: string; loc?: string[] }) =>
            d.msg || JSON.stringify(d)
          ).join('; ');
        } else {
          errorDetail = errorJson.detail;
        }
      } else if (errorJson.message) {
        errorDetail = errorJson.message;
      } else if (typeof errorJson.error === 'string') {
        errorDetail = errorJson.error;
      }
    } catch {
      // Keep original text if not JSON
    }
    // CRB-09: upstream text can echo the credential or a signed URL.
    errorDetail = redactSecretsInText(String(errorDetail));

    if (submitResponse.status === 429) {
      return {
        success: false,
        error: `${input.model.name}: Rate limit exceeded. ${apiKey ? "Try again in a moment." : "Add an API key in settings for higher limits."}`,
      };
    }

    return {
      success: false,
      error: `${input.model.name}: ${errorDetail}`,
    };
  }

  const submitResult = await submitResponse.json();
  console.log(`[API:${requestId}] Queue submit response:`, JSON.stringify(redactSecretsDeep(submitResult, { secretFields: "replace" })).substring(0, 500));
  const falRequestId = submitResult.request_id;

  if (!falRequestId) {
    console.error(`[API:${requestId}] No request_id in queue submit response`);
    return {
      success: false,
      error: "No request_id in queue response",
    };
  }

  // Use URLs from the response only when the credential is allowed to reach
  // them; otherwise fall back to URLs constructed on the authorized recipient.
  // CRB-09: a Provider-supplied URL must not be able to move the key to another host.
  const fallbackStatusUrl = `${FAL_QUEUE_BASE}/${modelId}/requests/${falRequestId}/status`;
  const fallbackResponseUrl = `${FAL_QUEUE_BASE}/${modelId}/requests/${falRequestId}`;
  let statusUrl = fallbackStatusUrl;
  let responseUrl = fallbackResponseUrl;

  if (submitResult.status_url) {
    if (credentialAllowedFor(connection, submitResult.status_url)) {
      statusUrl = submitResult.status_url;
    } else {
      console.warn(`[API:${requestId}] fal.ai provided an unauthorized status URL: ${redactSecretsInText(submitResult.status_url)} — falling back to constructed URL`);
    }
  }
  if (submitResult.response_url) {
    if (credentialAllowedFor(connection, submitResult.response_url)) {
      responseUrl = submitResult.response_url;
    } else {
      console.warn(`[API:${requestId}] fal.ai provided an unauthorized response URL: ${redactSecretsInText(submitResult.response_url)} — falling back to constructed URL`);
    }
  }

  console.log(`[API:${requestId}] Queue request submitted: ${falRequestId}, status URL: ${redactSecretsInText(statusUrl)}`);

  // Poll for completion
  const maxWaitTime = 10 * 60 * 1000; // 10 minutes for video
  const pollInterval = 1000; // 1 second (matches Replicate/WaveSpeed)
  const startTime = Date.now();
  let lastStatus = "";

  while (true) {
    if (Date.now() - startTime > maxWaitTime) {
      console.error(`[API:${requestId}] Queue request timed out after 10 minutes`);
      return {
        success: false,
        error: `${input.model.name}: Video generation timed out after 10 minutes`,
      };
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const statusResponse = await fetch(
      statusUrl,
      { headers: credential ? { "Authorization": `Key ${credential}` } : {} }
    );

    if (!statusResponse.ok) {
      console.error(`[API:${requestId}] Failed to poll status: ${statusResponse.status}`);
      return {
        success: false,
        error: `Failed to poll status: ${statusResponse.status}`,
      };
    }

    const statusResult = await statusResponse.json();
    const status = statusResult.status;

    if (status !== lastStatus) {
      console.log(`[API:${requestId}] Queue status: ${status}`);
      lastStatus = status;
    }

    if (status === "COMPLETED") {
      // Fetch the result
      const resultResponse = await fetch(
        responseUrl,
        { headers: credential ? { "Authorization": `Key ${credential}` } : {} }
      );

      if (!resultResponse.ok) {
        console.error(`[API:${requestId}] Failed to fetch result: ${resultResponse.status}`);
        return {
          success: false,
          error: `Failed to fetch result: ${resultResponse.status}`,
        };
      }

      const result = await resultResponse.json();

      // Extract media URL from result
      let mediaUrl: string | null = null;

      // Check for 3D model output (GLB mesh) — must check before images
      if (result.model_mesh?.url) {
        mediaUrl = result.model_mesh.url;
      } else if (result.mesh?.url) {
        mediaUrl = result.mesh.url;
      } else if (result.glb?.url) {
        mediaUrl = result.glb.url;
      } else if (result.model_glb?.url) {
        mediaUrl = result.model_glb.url;
      } else if (result.model_urls?.glb?.url) {
        mediaUrl = result.model_urls.glb.url;
      } else if (result.video && result.video.url) {
        mediaUrl = result.video.url;
      } else if (result.audio && result.audio.url) {
        mediaUrl = result.audio.url;
      } else if (result.images && Array.isArray(result.images) && result.images.length > 0) {
        mediaUrl = result.images[0].url;
      } else if (result.image && result.image.url) {
        mediaUrl = result.image.url;
      } else if (result.output && typeof result.output === "string") {
        mediaUrl = result.output;
      }

      if (!mediaUrl) {
        console.error(`[API:${requestId}] No media URL found in queue result. Result keys: ${Object.keys(result).join(", ")}`);
        return {
          success: false,
          error: "No media URL in response",
        };
      }

      const is3DModel = input.model.capabilities.some(c => c.includes("3d"));
      const isVideoModel = input.model.capabilities.some(c => c.includes("video"));
      const isAudioModel = input.model.capabilities.some(c => c.includes("audio"));

      // For 3D models, return URL directly (GLB files are binary — don't base64 encode)
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

      // Fetch the media and convert to base64
      console.log(`[API:${requestId}] Fetching output from: ${redactSecretsInText(mediaUrl).substring(0, 80)}...`);
      // Every hop of the download — protocol, resolved address, authorized
      // origin, media type and size — is validated instead of trusting the URL.
      const mediaDownload = await downloadSafeMedia(mediaUrl, {
        authorizedOrigins: FAL_MEDIA_ORIGINS,
        allowedMediaTypes: RESULT_MEDIA_TYPES,
        allowOctetStreamForMediaPaths: true,
        extensionsForOpaqueMedia: RESULT_MEDIA_EXTENSIONS,
        maxBytes: MAX_MEDIA_SIZE,
      });

      if (!mediaDownload.ok) {
        // A video above the cap was never buffered: this transport has always
        // handed the client the URL for that case, so it keeps doing so.
        if (mediaDownload.reason === "oversized" && isVideoModel && !isAudioModel) {
          console.log(`[API:${requestId}] SUCCESS - Returning URL for oversized video (${mediaDownload.detail ?? ""})`);
          return {
            success: true,
            outputs: [{ type: "video", data: "", url: mediaUrl }],
          };
        }
        console.error(`[API:${requestId}] Invalid media URL from fal.ai: ${redactSecretsInText(mediaUrl)} (${mediaDownload.reason}${mediaDownload.detail ? `: ${mediaDownload.detail}` : ""})`);
        return {
          success: false,
          error: `Invalid media URL: ${mediaDownload.reason}${mediaDownload.detail ? ` (${mediaDownload.detail})` : ""}`,
        };
      }

      // Detect actual media type from response content-type, falling back to model hints
      const rawContentType = mediaDownload.mediaType;
      const isAudioResponse = rawContentType.startsWith("audio/") || (!rawContentType.startsWith("video/") && !rawContentType.startsWith("image/") && isAudioModel);

      if (isAudioResponse) {
        const audioContentType = rawContentType.startsWith("audio/") ? rawContentType : "audio/mpeg";
        const audioBase64 = Buffer.from(mediaDownload.bytes).toString("base64");
        console.log(`[API:${requestId}] SUCCESS - Returning audio`);
        return {
          success: true,
          outputs: [{
            type: "audio",
            data: `data:${audioContentType};base64,${audioBase64}`,
            url: mediaUrl,
          }],
        };
      }

      const contentType = rawContentType;
      const isVideo = contentType.startsWith("video/");
      const mediaSizeMB = mediaDownload.bytes.byteLength / (1024 * 1024);

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

      const mediaBase64 = Buffer.from(mediaDownload.bytes).toString("base64");
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

    if (status === "FAILED") {
      const errorMessage = redactSecretsInText(String(statusResult.error || "Video generation failed"));
      console.error(`[API:${requestId}] Queue request failed: ${errorMessage}`);
      return {
        success: false,
        error: `${input.model.name}: ${errorMessage}`,
      };
    }

    // Continue polling for IN_QUEUE, IN_PROGRESS, etc.
  }
}
