import { createHash } from "node:crypto";
import type { ProviderCallRecord, ReferenceInput } from "./imageCapabilities";

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Hash local bytes only: this helper never downloads a URL or stores a prompt. */
export function imageSha256(image: string): string | null {
  const encoded = image.includes("base64,") ? image.split("base64,")[1] : image;
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  return sha256(Buffer.from(encoded, "base64"));
}

export function inputEvidence(prompt: string | undefined, references: ReferenceInput[]) {
  return {
    ...(typeof prompt === "string" ? { promptSha256: sha256(prompt) } : {}),
    referenceSha256: references.map(ref => imageSha256(ref.image)),
  };
}

const OPENAI_COUNTERS = ["input_tokens", "output_tokens", "total_tokens"];
const GEMINI_COUNTERS = ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount", "cachedContentTokenCount", "toolUsePromptTokenCount"];
const DETAILS = ["text_tokens", "image_tokens", "cached_tokens"];

/** Never persist arbitrary response fields, text, credentials, or synthetic zeros. */
export function reportedUsage(source: NonNullable<ProviderCallRecord["usage"]>["source"], raw: unknown): Pick<ProviderCallRecord, "usage"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const metrics: Record<string, number> = {};
  const add = (key: string, count: unknown) => {
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) metrics[key] = count;
  };
  for (const key of source === "gemini" ? GEMINI_COUNTERS : OPENAI_COUNTERS) add(key, value[key]);
  if (source !== "gemini") {
    for (const key of ["input_tokens_details", "output_tokens_details"]) {
      const details = value[key];
      if (details && typeof details === "object" && !Array.isArray(details)) {
        for (const name of DETAILS) add(`${key}.${name}`, (details as Record<string, unknown>)[name]);
      }
    }
  }
  return Object.keys(metrics).length ? { usage: { source, metrics } } : {};
}
