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

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function matchesRasterFormat(type: string, bytes: Uint8Array): boolean {
  if (type === "image/png") {
    if (bytes.length < 57 || ascii(bytes, 0, 8) !== "\x89PNG\r\n\x1a\n") return false;
    let offset = 8;
    let hasImageData = false;
    while (offset + 12 <= bytes.length) {
      const length = u32be(bytes, offset);
      if (length > bytes.length - offset - 12) return false;
      const chunk = ascii(bytes, offset + 4, offset + 8);
      if (offset === 8 && (chunk !== "IHDR" || length !== 13 ||
        u32be(bytes, offset + 8) === 0 || u32be(bytes, offset + 12) === 0)) return false;
      if (chunk === "IDAT" && length > 0) hasImageData = true;
      offset += length + 12;
      if (chunk === "IEND") return length === 0 && hasImageData && offset === bytes.length;
    }
    return false;
  }
  if (type === "image/jpeg" || type === "image/jpg") {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  if (type === "image/gif") {
    return bytes.length >= 15 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6)) &&
      (bytes[6] | (bytes[7] << 8)) > 0 && (bytes[8] | (bytes[9] << 8)) > 0 &&
      bytes.includes(0x2c, 13) && bytes[bytes.length - 1] === 0x3b;
  }
  if (type === "image/webp") {
    const chunk = ascii(bytes, 12, 16);
    const declaredLength = bytes.length >= 8
      ? (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0
      : 0;
    return bytes.length >= 20 && ascii(bytes, 0, 4) === "RIFF" &&
      declaredLength === bytes.length - 8 && ascii(bytes, 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(chunk);
  }
  if (type === "image/avif") {
    if (bytes.length < 24 || ascii(bytes, 4, 8) !== "ftyp") return false;
    const boxLength = u32be(bytes, 0);
    if (boxLength < 24 || boxLength > bytes.length) return false;
    for (let offset = 8; offset + 4 <= boxLength; offset += 4) {
      if (offset === 12) continue; // minor version, not a brand
      if (["avif", "avis"].includes(ascii(bytes, offset, offset + 4))) return true;
    }
    return false;
  }
  return false;
}

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

  const head = decodeText(bytes, 4096).trimStart();
  const looksLikeSvg = /^(?:<\?xml\b[^>]*>\s*)?<svg[\s>]/i.test(head);
  if (looksLikeSvg) {
    if (isActiveSvg(decodeText(bytes))) return "active-svg";
    return type === "image/svg+xml" || type === "image/svg" ? "inert-svg" : "unknown";
  }
  if (type === "image/svg+xml" || type === "image/svg") return "unknown";
  if (RASTER_TYPES.includes(type)) return matchesRasterFormat(type, bytes) ? "raster" : "unknown";
  if (VIDEO_TYPES.includes(type)) return "video";
  if (AUDIO_TYPES.includes(type)) return "audio";
  if (MODEL_TYPES.includes(type)) return "model";

  // A text/HTML payload that happens to start with XML is still not media.
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
