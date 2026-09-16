import { NextResponse } from "next/server";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";

export interface EnvStatusResponse {
  gemini: boolean;
  openai: boolean;
  anthropic: boolean;
  replicate: boolean;
  fal: boolean;
  kie: boolean;
  wavespeed: boolean;
}

/**
 * Discloses which Provider credentials this instance can see. Not billable and
 * not a file access, but it is still local instance state: a page that is not
 * this session must not be able to enumerate the configured providers.
 */
export const GET = withPrivilegedApi([], async () => {
  // Check which API keys are configured via environment variables
  const status: EnvStatusResponse = {
    gemini: !!process.env.GEMINI_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    replicate: !!process.env.REPLICATE_API_KEY,
    fal: !!process.env.FAL_API_KEY,
    kie: !!process.env.KIE_API_KEY,
    wavespeed: !!process.env.WAVESPEED_API_KEY,
  };

  return NextResponse.json(status);
});
