/**
 * Active-content classification (CRB-09 / Issue #10).
 *
 * An SVG that reaches application origin is an executable document, not an
 * image: scripts, event handlers, external references and `foreignObject`
 * content run with the app's origin privileges. The product therefore treats
 * SVG as unsafe input by default.
 *
 * Policy implemented here:
 * - raster and video/audio/model payloads are ordinary media;
 * - SVG is inspected: script, event-handler, external-reference and embedded
 *   document constructs make it *active* and it is rejected;
 * - an SVG with no active construct is *inert* and may only be provided as a
 *   credential-free download, never inline from the application origin.
 */

export type MediaContentKind =
  | "raster"
  | "video"
  | "audio"
  | "model"
  | "inert-svg"
  | "active-svg"
  | "unknown";

const RASTER_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/avif"];
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"];
const AUDIO_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/aac", "audio/flac"];
const MODEL_TYPES = ["model/gltf-binary", "model/gltf+json", "application/octet-stream"];

const ACTIVE_SVG_PATTERNS: ReadonlyArray<RegExp> = [
  /<script[\s>]/i,
  /<foreignObject[\s>]/i,
  /<iframe[\s>]/i,
  /<embed[\s>]/i,
  /<object[\s>]/i,
  /<use[^>]+(?:href|xlink:href)\s*=\s*["']?(?:https?:)?\/\//i,
  /\son[a-z]+\s*=/i,
  /javascript:/i,
  /<!ENTITY/i,
  /<!DOCTYPE[^>]*(?:SYSTEM|PUBLIC)/i,
];

function decodeText(bytes: Uint8Array, limit = 512 * 1024): string {
  const slice = bytes.byteLength > limit ? bytes.subarray(0, limit) : bytes;
  return new TextDecoder("utf-8", { fatal: false }).decode(slice);
}

/** True when an SVG document contains anything that can execute or fetch. */
export function isActiveSvg(svgText: string): boolean {
  return ACTIVE_SVG_PATTERNS.some((pattern) => pattern.test(svgText));
}

/**
 * Classify a downloaded or uploaded payload by its declared type and its bytes.
 * A non-media response is `unknown` — it must be rejected, never renamed as an
 * image.
 */
export function classifyMediaContent(contentType: string, bytes: Uint8Array): MediaContentKind {
  const type = contentType.split(";")[0].trim().toLowerCase();

  if (type === "image/svg+xml" || type === "image/svg") {
    return isActiveSvg(decodeText(bytes)) ? "active-svg" : "inert-svg";
  }
  if (RASTER_TYPES.includes(type)) return "raster";
  if (VIDEO_TYPES.includes(type)) return "video";
  if (AUDIO_TYPES.includes(type)) return "audio";
  if (MODEL_TYPES.includes(type)) return "model";

  // A text/HTML payload that happens to start with XML is still not media.
  const head = decodeText(bytes, 4096).trimStart();
  if (/^<\?xml|^<svg/i.test(head)) {
    return classifyMediaContent("image/svg+xml", bytes);
  }
  return "unknown";
}

/** Media types accepted for a role project asset, whatever the source. */
export const ACCEPTED_ASSET_MEDIA_TYPES: readonly string[] = [
  ...RASTER_TYPES,
  ...VIDEO_TYPES,
  ...AUDIO_TYPES,
  ...MODEL_TYPES,
];

/**
 * Headers for serving a user-supplied SVG as a download from a credential-free
 * context: no inline rendering, no same-origin script capability, no sniffing.
 */
export const INERT_SVG_DOWNLOAD_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "image/svg+xml",
  "Content-Disposition": "attachment",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};
