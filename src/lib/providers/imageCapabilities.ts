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
 *
 * A purpose is present ONLY when a user or preset explicitly declared the
 * role on the edge carrying the image. Absent means legacy/unknown and must
 * never be backfilled from array position: connection order is edge
 * traversal order, and reconnecting edges would silently change the meaning.
 */
export type ReferencePurpose = "target" | "retained-view" | "auxiliary";

export interface ReferenceInput {
  /** Data URL or HTTP URL of the reference image. */
  image: string;
  /** Explicitly declared role. Absent for legacy inputs without a declared role. */
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
 * single place to update. Per-model deviations get their own entry below
 * when real-call evidence justifies them — a shared provider default is
 * never applied to an unlisted model.
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
 * Declared image capabilities per provider entry (`provider/modelId`).
 * Only the entries below are approved for the reference contract. Any other
 * provider or model id is *undeclared*: structured reference/mask requests
 * fail closed with an actionable gap instead of being forced through an
 * unverified path.
 *
 * Known entry ids come from the models catalog (`src/app/api/models/route.ts`)
 * and the legacy `ModelType` union. Numeric limits are intentionally shared
 * per provider until CRB-07 real calls justify per-model deviations; the
 * fail-closed lookup itself is entry-level so one provider never vouches
 * for an unlisted model.
 */
const ENTRY_IMAGE_CAPABILITIES: Record<string, ImageCapabilities> = {
  "gemini/nano-banana": GEMINI_IMAGE_CAPABILITIES,
  "gemini/nano-banana-pro": GEMINI_IMAGE_CAPABILITIES,
  "gemini/nano-banana-2": GEMINI_IMAGE_CAPABILITIES,
  "gemini/nano-banana-2-lite": GEMINI_IMAGE_CAPABILITIES,
  // API-id aliases used by older callers (MODEL_MAP values). Same entry,
  // same limits — listed explicitly so the lookup stays entry-level.
  "gemini/gemini-2.5-flash-image": GEMINI_IMAGE_CAPABILITIES,
  "gemini/gemini-3-pro-image-preview": GEMINI_IMAGE_CAPABILITIES,
  "gemini/gemini-3.1-flash-image-preview": GEMINI_IMAGE_CAPABILITIES,
  "gemini/gemini-3.1-flash-lite-image": GEMINI_IMAGE_CAPABILITIES,
  "openai/gpt-image-1": OPENAI_IMAGE_CAPABILITIES,
  "openai/gpt-image-2": OPENAI_IMAGE_CAPABILITIES,
};

/** Capabilities declared for one entry, or null when undeclared. */
export function imageCapabilities(
  provider: ProviderType,
  modelId?: string
): ImageCapabilities | null {
  if (!modelId) return null;
  return ENTRY_IMAGE_CAPABILITIES[`${provider}/${modelId}`] ?? null;
}

/**
 * Where the purposes in a reference set came from. `declared` means every
 * reference carries an explicitly declared role; `legacy` means none does;
 * `mixed` means some do; `none` means the request carries no references.
 * Legacy inputs are accepted but never upgraded to declared roles.
 */
export type ReferencePurposeSource = "declared" | "legacy" | "mixed" | "none";

/**
 * Summarize the actually-sent reference set for call records: the purposes
 * in request order (null unless every reference declares one) plus their
 * source. Position is never used to invent a purpose.
 */
export function summarizePurposes(references: ReferenceInput[]): {
  purposes: ReferencePurpose[] | null;
  purposeSource: ReferencePurposeSource;
} {
  if (references.length === 0) return { purposes: null, purposeSource: "none" };
  const declared = references.filter((r) => r.purpose !== undefined);
  if (declared.length === references.length) {
    return {
      purposes: references.map((r) => r.purpose!),
      purposeSource: "declared",
    };
  }
  if (declared.length === 0) return { purposes: null, purposeSource: "legacy" };
  return { purposes: null, purposeSource: "mixed" };
}

/**
 * The complete input set an adapter is about to send, for count/size
 * checks only. Structured references win when present; otherwise legacy
 * flat `images` are mapped to purposeless entries. The mapping carries no
 * role claim — it only ensures legacy inputs face the same limits.
 */
export function effectiveReferences(
  references: ReferenceInput[],
  images?: string[]
): ReferenceInput[] {
  if (references.length > 0) return references;
  return (images ?? []).map((image) => ({ image }));
}

/**
 * Encoded (wire) byte size of one reference input — the data-URL string
 * itself, which is what request builders and vendor limits actually
 * measure. Returns null for remote URLs and opaque raw payloads whose size
 * cannot be derived locally.
 */
export function estimateImageBytes(dataUrl: string): number | null {
  if (!dataUrl) return null;
  if (/^data:/i.test(dataUrl)) return Buffer.byteLength(dataUrl, "utf8");
  return null;
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
      if (bytes === null) {
        // Remote URLs cannot be measured locally; the provider would be the
        // first to reject them, so fail here with an actionable gap instead.
        // Opaque raw payloads (no URL scheme, no data-URL marker) keep the
        // legacy behavior: the adapter forwards them and the provider enforces.
        if (/^(https?:|blob:)/i.test(reference.image) || reference.image.includes("://")) {
          gaps.push({
            kind: "image-size",
            message: `Reference ${index + 1} size cannot be verified before submission (remote URL). Download it to a data URL within the ${megabytes(capabilities.maxImageBytes)} per-image limit of ${where}, or choose an entry that accepts remote inputs.`,
          });
        }
        return;
      }
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
 *
 * The real chain passes `persistedSource` (the node's saved `modelSource`):
 * the label then comes from that persisted origin, never from comparing
 * values against the mutable global default. An explicit selection is always
 * `node-override` even when its value happens to equal the current default;
 * a node created from the default stays `project-default` with its saved
 * snapshot even after the global default changes; absent source means
 * `node-legacy` (origin unknown).
 *
 * The `projectDefault` value-comparison path remains only for callers that
 * have no persisted source (older tests); new code must pass persistedSource.
 */
export function resolveGenerationModel(input: {
  nodeSelected?: SelectedModel;
  legacyModel?: ModelType;
  projectDefault?: SelectedModel;
  persistedSource?: ModelResolutionSource;
}): ModelResolution {
  const { nodeSelected, legacyModel, projectDefault, persistedSource } = input;
  if (persistedSource !== undefined) {
    if (nodeSelected) {
      return { model: nodeSelected, resolvedFrom: persistedSource };
    }
    const modelId: ModelType = legacyModel ?? "nano-banana-pro";
    return {
      model: {
        provider: "gemini",
        modelId,
        displayName: MODEL_DISPLAY_NAMES[modelId] ?? modelId,
      },
      resolvedFrom: persistedSource,
    };
  }
  if (nodeSelected && projectDefault) {
    if (sameModel(nodeSelected, projectDefault)) {
      return { model: nodeSelected, resolvedFrom: "project-default" };
    }
    return { model: nodeSelected, resolvedFrom: "node-override" };
  }
  if (nodeSelected) {
    // No persisted source and no default to compare against: the origin is
    // unknown, so legacy — never a guessed override.
    return { model: nodeSelected, resolvedFrom: "node-legacy" };
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
 * success: every call record carries exactly one channel, set from the
 * transport that actually submitted the request.
 */
export type ProviderAuthChannel = "api-key" | "oauth-experimental";

/** Submission outcome of one provider attempt. */
export type ProviderCallStage = "succeeded" | "failed";

/**
 * Evidence of one provider submission, generated server-side after the
 * request actually reached the provider transport (fetch/SDK). Pre-submit
 * rejections (422 gaps, 401 missing key, 400 validation) produce no record;
 * absence of a record means no submission. HTTP/network failures after the
 * transport started are recorded as `failed`, never as success.
 */
export interface ProviderCallRecord {
  /** Epoch ms when the submission attempt started. */
  at: number;
  provider: ProviderType;
  modelId: string;
  displayName: string;
  /** Persisted origin of the model choice, echoed from the request. */
  resolvedFrom: ModelResolutionSource;
  /** False when the entry has no declared capability set. */
  declared: boolean;
  /** Declared capabilities at call time, present only when declared. */
  capabilities?: ImageCapabilities;
  /** Number of reference images actually included in the request. */
  referenceCount: number;
  /** Reference purposes in request order; null unless every reference declares one. */
  purposes: ReferencePurpose[] | null;
  /** Whether every/some/no reference carried an explicitly declared role. */
  purposeSource: ReferencePurposeSource;
  /** True when an edit mask was included in the submitted request. */
  hasMask: boolean;
  /** Actual credential transport that submitted the request. */
  auth: ProviderAuthChannel;
  /** Whether the provider transport reported success or failure. */
  stage: ProviderCallStage;
}
