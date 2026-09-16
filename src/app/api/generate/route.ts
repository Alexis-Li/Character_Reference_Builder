/**
 * Generate API Route
 * 
 * TIMEOUT CONFIGURATION:
 * - maxDuration: Only applies on Vercel, not locally
 * - AbortSignal.timeout: Controls outgoing fetch to providers
 * - For local development, server.requestTimeout must be set in scripts/server.js (Node.js default is 5 minutes)
 * 
 * FAL.AI QUEUE API NOTE:
 * Uses generateWithFalQueue with async queue submission + polling.
 * Images are uploaded to fal CDN before submission to avoid payload size issues.
 */
import { NextRequest, NextResponse } from "next/server";
import { GenerateRequest, GenerateResponse, ModelType, SelectedModel, ProviderType } from "@/types";
import { GenerationInput, ModelCapability, checkReferenceGaps, effectiveReferences, imageCapabilities, normalizeReferences, ReferenceInput, ModelResolutionSource } from "@/lib/providers/types";
import { generateWithGemini, generateWithGeminiVideo } from "./providers/gemini";
import { generateWithReplicate } from "./providers/replicate";
import { generateWithFalQueue } from "./providers/fal";
import { submitKieTask } from "./providers/kie";
import { generateWithWaveSpeed } from "./providers/wavespeed";
import { generateWithOpenAI } from "./providers/openai";
import { generateWithOpenAIOAuth } from "./providers/openaiOAuth";
import { buildMediaResponse } from "./shared";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";
import { redactSecretsInText } from "@/lib/security/secretRedaction";
export const maxDuration = 600; // 10 minute timeout for video generation polling
export const dynamic = 'force-dynamic'; // Ensure this route is always dynamic

const NOT_EXECUTED = { execution: "not-executed" as const, querySupport: "unsupported" as const };
const UNKNOWN_EXECUTION = {
  execution: "unknown" as const,
  querySupport: "unsupported" as const,
  statusUnknown: true as const,
};
const SUBMITTED = { execution: "submitted" as const, querySupport: "unsupported" as const };


/**
 * Extended request format that supports both legacy and multi-provider requests
 */
interface MultiProviderGenerateRequest extends GenerateRequest {
  selectedModel?: SelectedModel;
  parameters?: Record<string, unknown>;
  /** Dynamic inputs from schema-based connections (e.g., image_url, tail_image_url, prompt) */
  dynamicInputs?: Record<string, string | string[]>;
  /** Structured reference inputs with roles, in fixed order (CRB-03). */
  references?: unknown;
  /** Optional edit mask as data URL (CRB-03). */
  mask?: string;
  /** Persisted origin of the model choice, echoed in the call record. */
  modelSource?: ModelResolutionSource;
}


function capabilitiesForMediaType(mediaType?: string): ModelCapability[] {
  const map: Record<string, ModelCapability[]> = {
    audio: ["text-to-audio"],
    video: ["text-to-video"],
    "3d": ["text-to-3d"],
  };
  return map[mediaType ?? ""] ?? ["text-to-image"];
}

/**
 * Every branch below spends a server-held Provider credential, and the image
 * branches hand the caller's reference bytes to that Provider.
 */
export const POST = withPrivilegedApi(
  ["cloud-request", "design-reference-upload"],
  async (request: NextRequest, { session }) => {
  const requestId = Math.random().toString(36).substring(7);
  let providerInvocationStarted = false;
  console.log(`\n[API:${requestId}] ========== NEW GENERATE REQUEST ==========`);

  try {
    const body: MultiProviderGenerateRequest = await request.json();
    const {
      images,
      prompt,
      model = "nano-banana-pro",
      aspectRatio,
      resolution,
      useGoogleSearch,
      useImageSearch,
      selectedModel,
      parameters,
      dynamicInputs,
      references: rawReferences,
      mask,
      mediaType,
      modelSource,
    } = body;

    // Prompt is required unless:
    // - Provided via dynamicInputs
    // - Images are provided (image-to-video/image-to-image models)
    // - Dynamic inputs contain image frames (first_frame, last_frame, etc.)
    // - Dynamic inputs contain a video (video-to-video upscalers/restorers) or audio
    const hasPrompt = prompt || (dynamicInputs && (
      typeof dynamicInputs.prompt === 'string'
        ? dynamicInputs.prompt
        : Array.isArray(dynamicInputs.prompt) && dynamicInputs.prompt.length > 0
    ));
    const hasImages = (images && images.length > 0);
    const hasImageInputs = dynamicInputs && Object.keys(dynamicInputs).some(key =>
      key.includes('frame') || key.includes('image')
    );
    const hasMediaInputs = dynamicInputs && Object.entries(dynamicInputs).some(([key, value]) =>
      (key.includes('video') || key.includes('audio')) &&
      (
        (typeof value === 'string' && value.trim().length > 0) ||
        (Array.isArray(value) && value.some((v) => typeof v === 'string' && v.trim().length > 0))
      )
    );

    if (!hasPrompt && !hasImages && !hasImageInputs && !hasMediaInputs) {
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          ...NOT_EXECUTED,
          error: "Prompt, image, video, or audio input is required",
        },
        { status: 400 }
      );
    }

    // Determine which provider to use
    const provider: ProviderType = selectedModel?.provider || "gemini";
    console.log(`[API:${requestId}] Provider: ${provider}, Model: ${selectedModel?.modelId || model}`);

    // CRB-03: capability checks run against the complete input set the
    // adapters are about to send — never the structured subset alone.
    // Structured `references` win when present; otherwise legacy flat
    // `images` to a contract entry (gemini/openai) are losslessly mapped so
    // over-count, oversize, and remote-URL inputs cannot bypass via the old
    // field. Non-contract providers keep their schema-driven legacy behavior;
    // structured references to them still fail closed inside checkReferenceGaps.
    let references: ReferenceInput[];
    try {
      references = normalizeReferences(rawReferences);
    } catch (error) {
      return NextResponse.json<GenerateResponse>(
        { success: false, ...NOT_EXECUTED, error: error instanceof Error ? redactSecretsInText(error.message) : "Invalid references" },
        { status: 400 }
      );
    }
    if (mask !== undefined && typeof mask !== "string") {
      return NextResponse.json<GenerateResponse>(
        { success: false, ...NOT_EXECUTED, error: "mask must be a data URL string" },
        { status: 400 }
      );
    }
    const entryModelId = selectedModel?.modelId || model;
    const declaredCapabilities = imageCapabilities(provider, entryModelId);
    const referencesForCheck =
      provider === "gemini" || provider === "openai"
        ? effectiveReferences(references, images)
        : references;
    // Entry-level fail-closed: an unknown gemini/openai model never inherits
    // a provider-wide default, even for text-only requests.
    const unknownContractEntry =
      (provider === "gemini" || provider === "openai") && declaredCapabilities === null;
    const capabilityGaps = unknownContractEntry
      ? [{
          kind: "capability-undeclared" as const,
          message: `${provider}/${entryModelId} has no declared reference capability. Choose an approved image entry (for example Gemini nano-banana or OpenAI gpt-image) or send plain input images.`,
        }]
      : checkReferenceGaps(
          declaredCapabilities,
          { references: referencesForCheck, mask, prompt: prompt || undefined },
          { provider, modelId: entryModelId }
        );
    if (capabilityGaps.length > 0) {
      console.log(`[API:${requestId}] Capability gaps: ${capabilityGaps.map((g) => g.kind).join(", ")}`);
      return NextResponse.json<GenerateResponse>(
        { success: false, ...NOT_EXECUTED, error: "Capability gaps must be resolved before submission", gaps: capabilityGaps },
        { status: 422 }
      );
    }

    // Route to appropriate provider
    if (provider === "replicate") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...NOT_EXECUTED, error: "selectedModel with modelId and displayName is required for Replicate" },
          { status: 400 }
        );
      }

      // User-provided key takes precedence over env variable
      const replicateApiKey = request.headers.get("X-Replicate-API-Key") || process.env.REPLICATE_API_KEY;
      if (!replicateApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            ...NOT_EXECUTED,
            error: "Replicate API key not configured. Add REPLICATE_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }

      // Keep Data URIs as-is since localhost URLs won't work (provider can't reach them)
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values, keep Data URIs
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values (arrays pass through)
          if (value === null || value === undefined || value === '') {
            continue;
          }

          // Keep the value as-is (Data URIs work with Replicate)
          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "replicate",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        references,
        mask,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      providerInvocationStarted = true;
      const result = await generateWithReplicate(requestId, replicateApiKey, genInput);

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            ...UNKNOWN_EXECUTION,
            error: redactSecretsInText(result.error || "Generation failed"),
          },
          { status: 500 }
        );
      }

      // Return first output
      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...SUBMITTED, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output);
    }

    if (provider === "fal") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...NOT_EXECUTED, error: "selectedModel with modelId and displayName is required for fal.ai" },
          { status: 400 }
        );
      }

      // User-provided key takes precedence over env variable
      const falApiKey = request.headers.get("X-Fal-API-Key") || process.env.FAL_API_KEY || null;

      if (!falApiKey) {
        console.warn(`[API:${requestId}] No FAL API key configured. Proceeding without auth (rate-limited).`);
      }

      // Pass images as-is; generateWithFalQueue uploads base64 to CDN internally
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values (arrays pass through)
          if (value === null || value === undefined || value === '') {
            continue;
          }

          // Keep the value as-is; CDN upload happens in generateWithFalQueue
          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "fal",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        references,
        mask,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      providerInvocationStarted = true;
      const result = await generateWithFalQueue(requestId, falApiKey, genInput);

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            ...UNKNOWN_EXECUTION,
            error: redactSecretsInText(result.error || "Generation failed"),
          },
          { status: 500 }
        );
      }

      // Return first output
      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...SUBMITTED, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output);
    }

    if (provider === "kie") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...NOT_EXECUTED, error: "selectedModel with modelId and displayName is required for Kie.ai" },
          { status: 400 }
        );
      }

      // User-provided key takes precedence over env variable
      const kieApiKey = request.headers.get("X-Kie-Key") || process.env.KIE_API_KEY;
      if (!kieApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            ...NOT_EXECUTED,
            error: "Kie.ai API key not configured. Add KIE_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }

      // Process images - Kie requires URLs, we'll upload base64 images in submitKieTask
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values
          if (value === null || value === undefined || value === '') {
            continue;
          }

          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "kie",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        references,
        mask,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      // Submit task and return immediately — client polls for completion
      try {
        providerInvocationStarted = true;
        const { taskId } = await submitKieTask(requestId, kieApiKey, genInput);
        return NextResponse.json<GenerateResponse>({
          success: true,
          execution: "submitted",
          querySupport: "supported",
          upstreamRequestId: taskId,
          polling: true,
          taskId,
          pollProvider: 'kie',
          pollModelId: selectedModel.modelId,
          pollModelName: selectedModel.displayName,
          pollMediaType: mediaType || 'image',
        });
      } catch (error) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            ...UNKNOWN_EXECUTION,
            error: error instanceof Error ? redactSecretsInText(error.message) : "Task submission failed",
          },
          { status: 500 }
        );
      }
    }

    if (provider === "wavespeed") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...NOT_EXECUTED, error: "selectedModel with modelId and displayName is required for WaveSpeed" },
          { status: 400 }
        );
      }

      // User-provided key takes precedence over env variable
      const wavespeedApiKey = request.headers.get("X-WaveSpeed-Key") || process.env.WAVESPEED_API_KEY;
      if (!wavespeedApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            ...NOT_EXECUTED,
            error: "WaveSpeed API key not configured. Add WAVESPEED_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      }

      // Keep Data URIs as-is since localhost URLs won't work
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values
          if (value === null || value === undefined || value === '') {
            continue;
          }

          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "wavespeed",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        references,
        mask,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      providerInvocationStarted = true;
      const result = await generateWithWaveSpeed(requestId, wavespeedApiKey, genInput);

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            ...UNKNOWN_EXECUTION,
            error: redactSecretsInText(result.error || "Generation failed"),
          },
          { status: 500 }
        );
      }

      // Return first output
      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...SUBMITTED, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output);
    }

    if (provider === "openai") {
      if (!selectedModel?.modelId || !selectedModel?.displayName) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...NOT_EXECUTED, error: "selectedModel with modelId and displayName is required for OpenAI" },
          { status: 400 }
        );
      }

      // Two mutually exclusive transports: the API-key entry and the
      // OAuth-experimental entry. Presence of the experimental token header
      // selects the OAuth adapter; it never falls back to the API-key
      // endpoint, and the API-key path never claims an OAuth success.
      const oauthToken = request.headers.get("X-OpenAI-OAuth-Token");
      const openaiApiKey = request.headers.get("X-OpenAI-API-Key") || process.env.OPENAI_API_KEY;
      if (oauthToken) {
        // CRB-09: the experimental transport is deactivated until a versioned
        // Provider target is selected. CLI-only so a browser page can never
        // hold a reusable bearer; the adapter re-checks the flag itself.
        if (
          process.env.CRB_ENABLE_OAUTH_EXPERIMENTAL_TRANSPORT !== "1" ||
          session.requestClass !== "cli"
        ) {
          console.warn(`[API:${requestId}] OpenAI OAuth-experimental transport refused`);
          return NextResponse.json<GenerateResponse>(
            {
              success: false,
              ...NOT_EXECUTED,
              error:
                "The OpenAI OAuth-experimental transport is disabled. It requires CRB_ENABLE_OAUTH_EXPERIMENTAL_TRANSPORT=1 and is limited to CLI callers until a versioned Provider target is selected; use the API-key channel (X-OpenAI-API-Key or OPENAI_API_KEY) instead.",
            },
            { status: 403 }
          );
        }
        console.log(`[API:${requestId}] OpenAI auth channel: oauth-experimental`);
      } else if (!openaiApiKey) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            ...NOT_EXECUTED,
            error: "OpenAI API key not configured. Add OPENAI_API_KEY to .env.local or configure in Settings.",
          },
          { status: 401 }
        );
      } else {
        console.log(`[API:${requestId}] OpenAI auth channel: api-key`);
      }

      // Keep Data URIs as-is since localhost URLs won't work
      const processedImages: string[] = images ? [...images] : [];

      // Process dynamicInputs: filter empty values
      let processedDynamicInputs: Record<string, string | string[]> | undefined = undefined;

      if (dynamicInputs) {
        processedDynamicInputs = {};
        for (const key of Object.keys(dynamicInputs)) {
          const value = dynamicInputs[key];

          // Skip empty/null/undefined values (arrays pass through)
          if (value === null || value === undefined || value === '') {
            continue;
          }

          processedDynamicInputs[key] = value;
        }
      }

      // Build generation input
      const genInput: GenerationInput = {
        model: {
          id: selectedModel.modelId,
          name: selectedModel.displayName,
          provider: "openai",
          capabilities: capabilitiesForMediaType(mediaType),
          description: null,
        },
        prompt: prompt || "",
        images: processedImages,
        references,
        mask,
        modelSource,
        parameters,
        dynamicInputs: processedDynamicInputs,
      };

      providerInvocationStarted = true;
      const result = oauthToken
        ? await generateWithOpenAIOAuth(requestId, oauthToken, genInput)
        : await generateWithOpenAI(requestId, openaiApiKey!, genInput);

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            ...(result.call ? SUBMITTED : UNKNOWN_EXECUTION),
            error: redactSecretsInText(result.error || "Generation failed"),
            ...(result.call ? { call: result.call } : {}),
          },
          { status: 500 }
        );
      }

      // Return first output
      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...SUBMITTED, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output, result.call);
    }

    // Default: Use Gemini
    // User-provided key (from settings) takes precedence over env variable
    const geminiApiKey = request.headers.get("X-Gemini-API-Key") || process.env.GEMINI_API_KEY;

    if (!geminiApiKey) {
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          ...NOT_EXECUTED,
          error: "API key not configured. Add GEMINI_API_KEY to .env.local or configure in Settings.",
        },
        { status: 401 }
      );
    }

    // Use selectedModel.modelId if available (new format), fallback to legacy model field
    const geminiModel = (selectedModel?.modelId as ModelType) || model;

    // Resolve prompt: use top-level prompt, fall back to dynamicInputs.prompt
    // This handles cases where the prompt arrives via dynamicInputs instead of top-level
    let resolvedPrompt = prompt;
    if (!resolvedPrompt && dynamicInputs?.prompt) {
      resolvedPrompt = Array.isArray(dynamicInputs.prompt)
        ? dynamicInputs.prompt[0]
        : dynamicInputs.prompt;
    }
    // Validate: if a prompt was provided but isn't a string (corrupted data), return clear error
    // If no prompt provided but images exist, that's valid (image-to-image)
    if (resolvedPrompt !== undefined && resolvedPrompt !== null && typeof resolvedPrompt !== 'string') {
      return NextResponse.json<GenerateResponse>(
        { success: false, ...NOT_EXECUTED, error: "prompt must be a string" },
        { status: 400 }
      );
    }

    // Check if this is a Veo video model request
    if (selectedModel?.modelId?.startsWith("veo-")) {
      // Merge negative prompt from dynamic inputs (connected handle) into parameters
      const veoParams = { ...(parameters || {}) };
      if (dynamicInputs?.negative_prompt) {
        const neg = Array.isArray(dynamicInputs.negative_prompt)
          ? dynamicInputs.negative_prompt[0]
          : dynamicInputs.negative_prompt;
        if (neg) veoParams.negativePrompt = neg;
      }
      providerInvocationStarted = true;
      const result = await generateWithGeminiVideo(
        requestId,
        geminiApiKey,
        selectedModel.modelId,
        resolvedPrompt || "",
        images || [],
        veoParams,
      );

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...UNKNOWN_EXECUTION, error: redactSecretsInText(result.error || "Video generation failed") },
          { status: 500 }
        );
      }

      const output = result.outputs?.[0];
      if (!output?.data && !output?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, ...SUBMITTED, error: "No output in video generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(output);
    }
    providerInvocationStarted = true;
    return await generateWithGemini(
      requestId,
      geminiApiKey,
      resolvedPrompt,
      images || [],
      geminiModel,
      aspectRatio,
      resolution,
      useGoogleSearch,
      useImageSearch,
      references,
      mask,
      modelSource
    );
  } catch (error) {
    // Extract error information
    let errorMessage = "Generation failed";
    let errorDetails = "";

    if (error instanceof Error) {
      errorMessage = error.message;
      if ("cause" in error && error.cause) {
        errorDetails = JSON.stringify(error.cause);
      }
    }

    // Try to extract more details from API errors
    if (error && typeof error === "object") {
      const apiError = error as Record<string, unknown>;
      if (apiError.status) {
        errorDetails += ` Status: ${apiError.status}`;
      }
      if (apiError.statusText) {
        errorDetails += ` ${apiError.statusText}`;
      }
    }

    // Handle rate limiting
    if (errorMessage.includes("429")) {
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          ...(providerInvocationStarted ? UNKNOWN_EXECUTION : NOT_EXECUTED),
          error: "Rate limit reached. Please wait and try again.",
        },
        { status: 429 }
      );
    }

    console.error(
      `[API:${requestId}] Generation error: ${redactSecretsInText(errorMessage)}${errorDetails ? ` (${redactSecretsInText(errorDetails).substring(0, 200)})` : ""}`
    );
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        ...(providerInvocationStarted ? UNKNOWN_EXECUTION : NOT_EXECUTED),
        error: redactSecretsInText(errorMessage),
      },
      { status: 500 }
    );
  }
});
