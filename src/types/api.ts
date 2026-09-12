/**
 * API Types
 *
 * Request and response types for API routes including
 * image generation and LLM text generation.
 */

import type { AspectRatio, Resolution, ModelType } from "./models";
import type { CapabilityGap, ProviderCallRecord } from "@/lib/providers/imageCapabilities";
import type { LLMProvider, LLMModelType } from "./providers";

// API Request/Response types for Image Generation
export interface GenerateRequest {
  images: string[]; // Now supports multiple images
  prompt: string;
  aspectRatio?: AspectRatio;
  resolution?: Resolution; // Only for Nano Banana Pro
  model?: ModelType;
  useGoogleSearch?: boolean; // Only for Nano Banana Pro and Nano Banana 2
  useImageSearch?: boolean; // Only for Nano Banana 2
  mediaType?: "image" | "video" | "3d" | "audio"; // Indicates expected output type for provider routing
}

export interface GenerateResponse {
  success: boolean;
  image?: string;
  video?: string;
  videoUrl?: string; // For large videos, return URL directly
  audio?: string; // Base64 audio data
  audioUrl?: string; // For large audio, return URL directly
  model3dUrl?: string; // For 3D models, return GLB URL directly
  contentType?: "image" | "video" | "3d" | "audio";
  error?: string;
  /** Query ended without proving success or failure; callers must not resubmit automatically. */
  statusUnknown?: boolean;
  /** Pre-submit capability gaps (CRB-03). Present when the request is rejected before any provider call. */
  gaps?: CapabilityGap[];
  /**
   * CRB-03: server-generated record of the provider submission, present only
   * when the request actually reached the provider transport. Pre-submit
   * rejections (422 gaps, 401 missing key, 400 validation) carry no record.
   */
  call?: ProviderCallRecord;
  // Client-side polling fields (for long-running Kie tasks)
  polling?: boolean; // true = task submitted, poll for completion
  taskId?: string; // Kie task ID to poll
  pollProvider?: string; // 'kie' — tells poll endpoint which provider
  pollModelId?: string; // model ID for result handling
  pollModelName?: string; // display name for error messages
  pollMediaType?: string; // 'video' | 'image' | 'audio' — for result handling
}

// API Request/Response types for LLM Text Generation
export interface LLMGenerateRequest {
  prompt: string;
  images?: string[];
  provider: LLMProvider;
  model: LLMModelType;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMGenerateResponse {
  success: boolean;
  text?: string;
  error?: string;
}
