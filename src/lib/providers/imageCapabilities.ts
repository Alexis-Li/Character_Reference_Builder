/**
 * Image Provider Capability Contract (CRB-03)
 *
 * Business tasks declare what they need (references with purpose, masks);
 * each provider entry declares what it can actually accept. Incompatible
 * requests fail BEFORE submission with actionable gaps — inputs are never
 * truncated and never silently degraded.
 *
 * Layers distinguished by this contract:
 * - Project default: the user-configured default image model for new nodes.
 * - Node override:   the model explicitly chosen on one node.
 * - Call record:     what actually served the last run (primary or fallback).
 *
 * Registry values are pre-submit guards calibrated from vendor docs. The
 * default entry and exact limits are confirmed by real calls in CRB-07
 * (Issue #8); simulated contract tests never substitute for that evidence.
 */

import type { ProviderType, SelectedModel, ModelType } from "@/types";
import { MODEL_DISPLAY_NAMES } from "@/types";

/**
 * Role a reference image plays in one request. Order of the references
 * array is fixed and preserved end-to-end.
 * - `target`: the image being generated around / edited (the goal image).
 * - `retained-view`: a view that must be preserved unchanged.
 * - `auxiliary`: supporting context (style, detail, occluded-side hints).
 */
export type ReferencePurpose = "target" | "retained-view" | "auxiliary";

export interface ReferenceInput {
  /** Data URL or HTTP URL of the reference image. */
  image: string;
  /** Documented role of this reference. Legacy plain inputs omit it. */
  purpose?: ReferencePurpose;
}

/**
 * What one image generation entry can accept. Declared per provider;
 * model-specific deviations get their own entries when real-call evidence
 * (CRB-07) justifies them.
 */
export interface ImageCapabilities {
  /** Text-only generation without any reference input. */
  generate: boolean;
  /** Accepts reference images (editing / image-conditioned generation). */
  edit: boolean;
  /** Accepts more than one reference in a single request. */
  multiReference: boolean;
  /** Accepts an explicit edit mask. */
  mask: boolean;
  /** Maximum reference images per request (meaningful when edit is true). */
  maxReferenceImages: number;
  /** Maximum encoded (data URL) length per reference, in bytes. */
  maxImageBytes: number;
  /** Maximum combined encoded length of all reference inputs, in bytes. */
  maxRequestBytes: number;
}

export type CapabilityGapKind =
  | "capability-undeclared"
  | "edit-unsupported"
  | "generate-unsupported"
  | "reference-count"
  | "image-size"
  | "request-size"
  | "mask-unsupported";

export interface CapabilityGap {
  kind: CapabilityGapKind;
  /** User-actionable message. States the gap and how to resolve it. */
  message: string;
}

const MB = 1024 * 1024;

/**
 * Pre-submit guards, calibrated from vendor documentation:
 * - Gemini image models accept multiple inline reference images; vendor
 *   composition guidance recommends up to 3, and inline request data is
 *   capped around 20MB in total.
 * - OpenAI gpt-image edits accept up to 4 input images via `image[]`,
 *   each below 50MB, plus an optional mask.
 * CRB-07 real calls confirm or correct these numbers; entries here are the
 * single place to update.
 */
const GEMINI_IMAGE_CAPABILITIES: ImageCapabilities = {
  generate: true,
  edit: true,
  multiReference: true,
  mask: false, // Gemini image generation has no mask parameter.
  maxReferenceImages: 3,
  maxImageBytes: 7 * MB,
  maxRequestBytes: 20 * MB,
};

const OPENAI_IMAGE_CAPABILITIES: ImageCapabilities = {
  generate: true,
  edit: true,
  multiReference: true,
  mask: true,
  maxReferenceImages: 4,
  maxImageBytes: 50 * MB,
  // Derived upper bound (per-image limit x count); confirmed in CRB-07.
  maxRequestBytes: 4 * 50 * MB,
};

/**
 * Declared image capabilities per provider. Providers without an entry are
 * *undeclared*: structured reference/mask requests fail closed with an
 * actionable gap instead of being forced through an unverified path.
 */
const PROVIDER_IMAGE_CAPABILITIES: Partial<Record<ProviderType, ImageCapabilities>> = {
  gemini: GEMINI_IMAGE_CAPABILITIES,
  openai: OPENAI_IMAGE_CAPABILITIES,
};

/** Capabilities declared for one entry, or null when undeclared. */
export function imageCapabilities(
  provider: ProviderType,
  _modelId?: string
): ImageCapabilities | null {
  return PROVIDER_IMAGE_CAPABILITIES[provider] ?? null;
}

/**
 * Encoded (wire) byte size of one reference input — the data-URL string
 * itself, which is what request builders and vendor limits actually
 * measure. Returns null for inputs whose size cannot be derived locally.
 */
export function estimateImageBytes(dataUrl: string): number | null {
  if (!dataUrl) return null;
  const marker = "base64,";
  const at = dataUrl.indexOf(marker);
  if (at === -1) return null;
  return Buffer.byteLength(dataUrl, "utf8");
}
function megabytes(bytes: number): string {
  return `${(bytes / MB).toFixed(1)}MB`;
}

function entryLabel(entry: { provider: ProviderType; modelId?: string }): string {
  return entry.modelId ? `${entry.provider}/${entry.modelId}` : String(entry.provider);
}

function formatMB(bytes: number): string {
  return `${(bytes / MB).toFixed(0)}MB`;
}

/**
 * Validate request-level reference inputs against declared capabilities.
 * Returns every gap found (count, size, mask) with actionable messages.
 * Callers must fail the request before submission when the result is
 * non-empty; no input may be dropped to make a request "fit".
 */
export function checkReferenceGaps(
  capabilities: ImageCapabilities | null,
  request: {
    references?: ReferenceInput[];
    mask?: string;
    prompt?: string;
  },
  entry?: { provider: ProviderType; modelId?: string }
): CapabilityGap[] {
  const references = request.references ?? [];
  const hasReferences = references.length > 0;
  const hasMask = Boolean(request.mask);

  // Undeclared entry: fail closed only when the request carries the
  // structured contract (references/mask). Legacy plain-image requests keep
  // their existing schema-driven behavior.
  if (!capabilities) {
    if (!hasReferences && !hasMask) return [];
    return [{
      kind: "capability-undeclared",
      message: `${entry ? entryLabel(entry) : "The selected entry"} has no declared reference capability. Choose an approved image entry (for example Gemini nano-banana or OpenAI gpt-image) or send plain input images.`,
    }];
  }

  const gaps: CapabilityGap[] = [];
  const where = entry ? entryLabel(entry) : "this entry";

  if (hasReferences && !capabilities.edit) {
    gaps.push({
      kind: "edit-unsupported",
      message: `${where} does not accept reference images (generation only). Remove the reference inputs or choose an editing-capable entry.`,
    });
  }
  if (!hasReferences && !request.prompt && !capabilities.generate) {
    gaps.push({
      kind: "generate-unsupported",
      message: `${where} cannot generate from text alone. Provide a reference image or choose a text-to-image entry.`,
    });
  }
  if (hasReferences) {
    if (references.length > 1 && !capabilities.multiReference) {
      gaps.push({
        kind: "reference-count",
        message: `${where} accepts at most 1 reference image per request, but ${references.length} were provided. Keep one reference or choose an entry with multi-reference support. Inputs are never truncated automatically.`,
      });
    } else if (references.length > capabilities.maxReferenceImages) {
      gaps.push({
        kind: "reference-count",
        message: `${where} accepts up to ${capabilities.maxReferenceImages} reference image(s) per request, but ${references.length} were provided. Remove reference inputs or choose an entry with a higher multi-reference limit. Inputs are never truncated automatically.`,
      });
    }

    let totalBytes = 0;
    references.forEach((reference, index) => {
      const bytes = estimateImageBytes(reference.image);
      if (bytes === null) return; // size unknowable locally; provider enforces
      totalBytes += bytes;
      if (bytes > capabilities.maxImageBytes) {
        gaps.push({
          kind: "image-size",
          message: `Reference ${index + 1} is about ${(bytes / MB).toFixed(1)}MB, above the ${megabytes(capabilities.maxImageBytes)} limit of ${where}. Compress or downscale the image, or choose an entry with a larger input limit.`,
        });
      }
    });
    if (totalBytes > capabilities.maxRequestBytes) {
      gaps.push({
        kind: "request-size",
        message: `Combined reference size (about ${(totalBytes / MB).toFixed(1)}MB) exceeds the ${megabytes(capabilities.maxRequestBytes)} request limit of ${where}. Remove or compress reference images.`,
      });
    }
  }
  if (hasMask && !capabilities.mask) {
    gaps.push({
      kind: "mask-unsupported",
      message: `${where} does not accept mask input. Remove the mask or choose a mask-capable entry.`,
    });
  }
  return gaps;
}

const REFERENCE_PURPOSES: ReadonlySet<string> = new Set(["target", "retained-view", "auxiliary"]);

/**
 * Normalize the wire `references` field. Throws with an actionable message
 * on malformed entries so bad shapes never reach an adapter silently.
 */
export function normalizeReferences(raw: unknown): ReferenceInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("references must be an array of { image, purpose? }");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`references[${index}] must be an object with an image field`);
    }
    const { image, purpose } = entry as Record<string, unknown>;
    if (typeof image !== "string" || image.length === 0) {
      throw new Error(`references[${index}].image must be a non-empty string`);
    }
    if (purpose !== undefined) {
      if (typeof purpose !== "string" || !REFERENCE_PURPOSES.has(purpose)) {
        throw new Error(
          `references[${index}].purpose must be one of: target, retained-view, auxiliary`
        );
      }
    }
    return { image, ...(purpose !== undefined ? { purpose: purpose as ReferencePurpose } : {}) };
  });
}

/** Which layer supplied the model choice for one actual call. */
export type ModelResolutionSource = "project-default" | "node-override" | "node-legacy";

export interface ModelResolution {
  model: SelectedModel;
  resolvedFrom: ModelResolutionSource;
}

function sameModel(a: SelectedModel, b: SelectedModel): boolean {
  return a.provider === b.provider && a.modelId === b.modelId;
}

/**
 * Distinguish project default, node override, and legacy node config.
 * A node still carrying the project default resolves as project-default;
 * an explicit node choice (different from the default) wins as override.
 */
export function resolveGenerationModel(input: {
  nodeSelected?: SelectedModel;
  legacyModel?: ModelType;
  projectDefault?: SelectedModel;
}): ModelResolution {
  const { nodeSelected, legacyModel, projectDefault } = input;
  if (nodeSelected) {
    if (projectDefault && sameModel(nodeSelected, projectDefault)) {
      return { model: nodeSelected, resolvedFrom: "project-default" };
    }
    return { model: nodeSelected, resolvedFrom: "node-override" };
  }
  const modelId: ModelType = legacyModel ?? "nano-banana-pro";
  return {
    model: {
      provider: "gemini",
      modelId,
      displayName: MODEL_DISPLAY_NAMES[modelId] ?? modelId,
    },
    resolvedFrom: "node-legacy",
  };
}

/**
 * Credentials channel of one actual call. API-key requests and OAuth
 * experiments are recorded separately and can never claim each other's
 * success: every call record carries exactly one channel.
 */
export type ProviderAuthChannel = "api-key" | "oauth-experimental";

/** Evidence that a real request was submitted to a provider entry. */
export interface ProviderCallRecord {
  /** Epoch ms when the request was submitted. */
  at: number;
  provider: ProviderType;
  modelId: string;
  displayName: string;
  /** Which layer supplied the model choice. */
  resolvedFrom: ModelResolutionSource;
  /** False when the entry has no declared capability set. */
  declared: boolean;
  /** Declared capabilities at call time, present only when declared. */
  capabilities?: ImageCapabilities;
  /** Number of reference images actually included in the request. */
  referenceCount: number;
  /** Reference purposes in request order, when provided. */
  purposes: ReferencePurpose[] | null;
  auth: ProviderAuthChannel;
}
