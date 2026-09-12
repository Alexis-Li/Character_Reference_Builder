/**
 * Provider Types
 *
 * Types for multi-provider support including image generation
 * providers and LLM providers.
 */

// Provider Types for multi-provider support (image/video generation)
export type ProviderType = "gemini" | "openai" | "anthropic" | "replicate" | "fal" | "kie" | "wavespeed";

// Model pricing info (stored when model is selected)
export interface SelectedModelPricing {
  type: 'per-run' | 'per-second';
  amount: number;
}

// Selected model for image/video generation nodes
export interface SelectedModel {
  provider: ProviderType;
  modelId: string;
  displayName: string;
  pricing?: SelectedModelPricing;  // Optional pricing info from provider API
  capabilities?: string[];  // Model capabilities (e.g., "text-to-image", "image-to-3d")
}

/** Persisted lifecycle of one cloud request attempt (CRB-04). */
export type CloudRequestStatus =
  | "not-submitted"
  | "submitting"
  | "completed"
  | "failed"
  | "unknown"
  | "wait-cancelled";

export type CloudFailureReason =
  | "capability-unavailable"
  | "provider-unavailable"
  | "quota-unavailable"
  | "authentication"
  | "input"
  | "content-rejected"
  | "provider-failed"
  | "network"
  | "cancelled"
  | "unknown";

export interface CloudRequestRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: CloudRequestStatus;
  attempt: "primary" | "fallback";
  originalEntry: SelectedModel;
  actualEntry: SelectedModel;
  switchReason?: string;
  estimatedCostUsd: number | null;
  /** Provider billing is not treated as known until a provider reports it. */
  actualCostUsd: number | null;
  querySupport: "supported" | "unsupported";
  upstreamRequestId?: string;
  failureReason?: CloudFailureReason;
  error?: string;
}

/**
 * Explicit automatic-fallback authorization for one node. Merely storing a
 * fallback model or API key never enables a paid request.
 */
export interface FallbackPolicy {
  enabled: boolean;
  /** Hard ceiling for the one fallback attempt; null means no budget grant. */
  maxCostUsd: number | null;
}

export interface ProviderConfig {
  id: ProviderType;
  name: string;
  enabled: boolean;
  apiKey: string | null;
  apiKeyEnvVar?: string; // For providers using environment variables (e.g., Gemini)
}

export interface ProviderSettings {
  providers: Record<ProviderType, ProviderConfig>;
}

// LLM Provider Options
export type LLMProvider = "google" | "openai" | "anthropic";

// LLM Model Options
export type LLMModelType =
  | "gemini-2.5-flash"
  | "gemini-3-flash-preview"
  | "gemini-3-pro-preview"
  | "gemini-3.1-pro-preview"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano"
  | "claude-opus-4.6"
  | "claude-sonnet-4.5"
  | "claude-haiku-4.5";

// Recently used models tracking
export interface RecentModel {
  provider: ProviderType;
  modelId: string;
  displayName: string;
  timestamp: number;
}
