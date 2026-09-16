/**
 * OpenAI Provider for Generate API Route
 *
 * Handles image generation using OpenAI's Images API (gpt-image-1, gpt-image-2).
 * Supports both text-to-image (/v1/images/generations) and image-to-image (/v1/images/edits).
 *
 * CRB-03 (Issue #4): this is the second compatible entry of the capability
 * contract. ALL reference inputs are forwarded in fixed order via the
 * multipart `image[]` field (P04 — the pre-fix snapshot dropped every image
 * after the first). When callers pass structured references, purposes ride
 * along in the filename (e.g. `1-target.png`) so the vendor's prompt-side
 * ordering can be cross-checked; filenames never carry credentials.
 */

import { GenerationInput, GenerationOutput } from "@/lib/providers/types";
import {
  bindCredentialToDestination,
  type CredentialSource,
} from "@/lib/security/providerConnection";
import { redactSecretsInText } from "@/lib/security/secretRedaction";
import {
  imageCapabilities,
  summarizePurposes,
  type ProviderCallRecord,
  type ReferenceInput,
} from "@/lib/providers/imageCapabilities";

/**
 * Extract base64 data and MIME type from a data URL
 */
function extractBase64Data(dataUrl: string): { data: string; mimeType: string } {
  if (dataUrl.includes("base64,")) {
    const [header, data] = dataUrl.split("base64,");
    const mimeMatch = header.match(/data:([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
    return { data, mimeType };
  }
  return { data: dataUrl, mimeType: "image/png" };
}

/**
 * Generate image using OpenAI Images API
 */
export async function generateWithOpenAI(
  requestId: string,
  apiKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  console.log(`[API:${requestId}] OpenAI generation - Model: ${input.model.id}, Images: ${input.images?.length || 0}, References: ${input.references?.length ?? 0}, Prompt: ${input.prompt.length} chars`);

  const OPENAI_API_BASE = "https://api.openai.com/v1";
  const modelId = input.model.id;

  // CRB-03: the call record reflects what this transport actually sends.
  // Built here at transport start; only the stage is filled per outcome.
  const sentRefs: ReferenceInput[] = input.references?.length
    ? input.references
    : (input.images ?? []).map((image) => ({ image }));
  const { purposes, purposeSource } = summarizePurposes(sentRefs);
  const openaiDeclared = imageCapabilities("openai", modelId);
  const callBase: Omit<ProviderCallRecord, "stage"> = {
    at: Date.now(),
    provider: "openai",
    modelId,
    displayName: input.model.name,
    resolvedFrom: input.modelSource ?? "node-legacy",
    declared: openaiDeclared !== null,
    ...(openaiDeclared ? { capabilities: openaiDeclared } : {}),
    referenceCount: sentRefs.length,
    purposes,
    purposeSource,
    hasMask: Boolean(input.mask),
    auth: "api-key",
  };

  // CRB-09: the credential is attached only after it is bound to the recipient
  // this call actually uses. The adapter receives a key value, not its
  // provenance, so provenance is resolved here: a value equal to this
  // instance's environment entry is a server-environment credential.
  const credentialSource: CredentialSource =
    process.env.OPENAI_API_KEY === apiKey ? "server-environment" : "browser-supplied";
  const { credential } = bindCredentialToDestination({
    provider: "openai",
    role: "image",
    endpoint: OPENAI_API_BASE,
    credential: apiKey,
    credentialKind: "api-key",
    credentialSource,
    userAuthorizedDestination: false,
  });

  if (!credential) {
    console.error(`[API:${requestId}] OpenAI credential withheld from ${OPENAI_API_BASE}: recipient not authorized`);
    return {
      success: false,
      error: `${input.model.name}: OpenAI credential is not authorized for this destination`,
      call: { ...callBase, stage: "failed" },
    };
  }

  const hasImages = (input.images && input.images.length > 0)
    || Boolean(input.references?.length)
    || Boolean(input.mask);
  // If images are provided, use the edits endpoint; otherwise use generations
  const isImageToImage = hasImages;

  // Build parameters from user settings
  const parameters = input.parameters || {};

  // Determine endpoint
  const endpoint = isImageToImage
    ? `${OPENAI_API_BASE}/images/edits`
    : `${OPENAI_API_BASE}/images/generations`;

  let response: Response;

  if (isImageToImage) {
    // Multipart form data for image edits
    const formData = new FormData();
    formData.append("model", modelId);
    formData.append("prompt", input.prompt);
    // gpt-image models return base64 by default; response_format is not a valid parameter

    if (parameters.size) formData.append("size", String(parameters.size));
    if (parameters.quality) formData.append("quality", String(parameters.quality));
    if (parameters.n) formData.append("n", String(parameters.n));
    if (parameters.background) formData.append("background", String(parameters.background));
    // CRB-03 (P04): send EVERY reference image in fixed order. gpt-image
    // edits accepts up to 4 inputs via repeated image[] fields; truncating
    // to the first image silently dropped retained views and auxiliary
    // references, so inputs are appended as-is and capability gaps are
    // rejected earlier in the route (checkReferenceGaps), never here.
    const orderedImages = input.references?.length
      ? input.references.map((reference) => ({
          data: reference.image,
          filenameSuffix: reference.purpose ? `-${reference.purpose}` : "",
        }))
      : (input.images ?? []).map((image) => ({ data: image, filenameSuffix: "" }));

    orderedImages.forEach((image, index) => {
      const { data, mimeType } = extractBase64Data(image.data);
      const ext = mimeType === "image/jpeg" ? "jpg" : "png";
      const blob = new Blob([Buffer.from(data, "base64")], { type: mimeType });
      formData.append("image", blob, `${index + 1}${image.filenameSuffix}.${ext}`);
    });

    // CRB-03: the mask rides in its own multipart field per the Images API;
    // it is never mixed into the reference image[] list.
    if (input.mask) {
      const { data, mimeType } = extractBase64Data(input.mask);
      const blob = new Blob([Buffer.from(data, "base64")], { type: mimeType });
      formData.append("mask", blob, "mask.png");
    }

    console.log(`[API:${requestId}] OpenAI edits request: ${orderedImages.length} image(s), model=${modelId}`);

    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
      },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });
  } else {
    // JSON payload for text-to-image generations
    const body: Record<string, unknown> = {
      model: modelId,
      prompt: input.prompt,
      // gpt-image models return base64 by default; response_format is not a valid parameter
    };

    if (parameters.size) body.size = parameters.size;
    if (parameters.quality) body.quality = parameters.quality;
    if (parameters.n) body.n = parameters.n;
    if (parameters.background) body.background = parameters.background;

    console.log(`[API:${requestId}] OpenAI generations request: model=${modelId}`);

    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    // Default to a concise, status-based message so we never surface a raw HTML
    // gateway/error page (e.g. a Cloudflare 520) to the user.
    let errorDetail = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.error?.message || errorJson.error?.type || errorDetail;
    } catch {
      // Non-JSON body (HTML error page, etc.) — keep the status-based message.
    }
    // CRB-09: upstream text can echo the credential or a signed URL.
    errorDetail = redactSecretsInText(errorDetail);
    console.error(`[API:${requestId}] OpenAI error ${response.status}: ${redactSecretsInText(errorText).slice(0, 300)}`);

    // Handle rate limits
    if (response.status === 429) {
      return {
        success: false,
        error: `${input.model.name}: Rate limit exceeded. Try again in a moment.`,
        call: { ...callBase, stage: "failed" },
      };
    }

    // Upstream/gateway errors (500-599, incl. Cloudflare 520-524) are transient.
    if (response.status >= 500) {
      return {
        success: false,
        error: `${input.model.name}: OpenAI is temporarily unavailable (${errorDetail}). Please try again.`,
        call: { ...callBase, stage: "failed" },
      };
    }

    return {
      success: false,
      error: `${input.model.name}: ${errorDetail}`,
      call: { ...callBase, stage: "failed" },
    };
  }

  const data = await response.json();

  // Extract base64 image from response
  const firstImage = data.data?.[0];
  const b64Json = firstImage?.b64_json;

  if (!b64Json) {
    console.error(`[API:${requestId}] No b64_json in OpenAI response`);
    return {
      success: false,
      error: "No image returned from OpenAI",
      call: { ...callBase, stage: "failed" },
    };
  }

  // OpenAI returns PNG by default for b64_json format
  const mimeType = "image/png";
  const dataUrl = `data:${mimeType};base64,${b64Json}`;
  const imageSizeKB = (b64Json.length / 1024).toFixed(1);

  console.log(`[API:${requestId}] SUCCESS - Returning image: ${mimeType}, ${imageSizeKB}KB`);

  return {
    success: true,
    outputs: [
      {
        type: "image",
        data: dataUrl,
      },
    ],
    call: { ...callBase, stage: "succeeded" },
  };
}
