import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as crypto from "crypto";
import { logger } from "@/utils/logger";
import { joinWorkflowPath, validateWorkflowPath } from "@/utils/pathValidation";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";
import { checkWriteTarget } from "@/lib/security/projectWriteScope.server";
import { redactSecretsInText } from "@/lib/security/secretRedaction";
import { downloadSafeMedia, type SafeMediaOutcome } from "@/lib/security/safeMedia.server";
import {
  ACCEPTED_ASSET_MEDIA_TYPES,
  classifyMediaContent,
} from "@/lib/security/activeContent";

export const maxDuration = 300; // 5 minute timeout for large media operations

/** A provider media download is aborted after this long (large video files). */
const FETCH_TIMEOUT_MS = 60000;
/** Hard cap on a single stored asset (500MB max). */
const MAX_CONTENT_SIZE = 500 * 1024 * 1024;
/** Extensions accepted for opaque binaries served by provider CDNs. */
const OPAQUE_MEDIA_EXTENSIONS = [
  "glb",
  "gltf",
  "obj",
  "fbx",
  "usdz",
  "stl",
  "ply",
  "mp4",
  "webm",
  "mov",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
];

// Helper to get file extension from MIME type
function getExtensionFromMime(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "model/gltf-binary": "glb",
    "model/gltf+json": "gltf",
    "model/obj": "obj",
    "model/vnd.usdz+zip": "usdz",
    "model/fbx": "fbx",
    "model/stl": "stl",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/aac": "aac",
  };

  // Check explicit mapping first
  if (mimeToExt[mimeType]) {
    return mimeToExt[mimeType];
  }

  // Fallback based on MIME type prefix
  if (mimeType.startsWith("image/")) {
    return "png";
  }
  if (mimeType.startsWith("video/")) {
    return "mp4";
  }
  if (mimeType.startsWith("model/")) {
    return "glb";
  }
  if (mimeType.startsWith("audio/")) {
    return "mp3";
  }

  // Unknown type - use generic binary extension
  return "bin";
}

// Helper to detect if a string is an HTTP URL
function isHttpUrl(str: string): boolean {
  return str.startsWith("http://") || str.startsWith("https://");
}

// Known file extensions for 3D models and common media
const KNOWN_3D_EXTENSIONS = new Set(["glb", "gltf", "obj", "fbx", "usdz", "stl", "ply"]);
const KNOWN_MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "webm", "mov"]);

// Helper to extract a recognized file extension from a URL pathname
export function getExtensionFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const lastDot = pathname.lastIndexOf(".");
    if (lastDot === -1 || lastDot === pathname.length - 1) return null;
    const ext = pathname.substring(lastDot + 1).toLowerCase();
    if (KNOWN_3D_EXTENSIONS.has(ext) || KNOWN_MEDIA_EXTENSIONS.has(ext)) return ext;
    return null;
  } catch {
    return null;
  }
}

// Helper to compute MD5 hash of buffer content
function computeContentHash(buffer: Buffer): string {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

// Helper to find existing file by hash suffix
async function findExistingFileByHash(
  directoryPath: string,
  hash: string,
  extension: string
): Promise<string | null> {
  try {
    const files = await fs.readdir(directoryPath);
    // Look for files ending with this hash before extension
    const hashSuffix = `_${hash}.${extension}`;
    const matching = files.find((f) => f.endsWith(hashSuffix));
    return matching || null;
  } catch {
    return null;
  }
}

/**
 * Caller-visible refusal for a rejected media download. A blocked or
 * unauthorized destination is reported as refused, never silently accepted.
 */
function describeDownloadRefusal(failure: Extract<SafeMediaOutcome, { ok: false }>): {
  status: number;
  message: string;
} {
  switch (failure.reason) {
    case "blocked-address":
      return {
        status: 400,
        message: `Refused: destination address is not allowed (${failure.detail ?? "blocked address"})`,
      };
    case "destination-not-authorized":
      return {
        status: 400,
        message: `Refused: destination is not an authorized media source (${failure.detail ?? "unknown origin"})`,
      };
    case "blocked-protocol":
      return {
        status: 400,
        message: `Refused: destination protocol is not allowed (${failure.detail ?? "blocked protocol"})`,
      };
    case "invalid-url":
      return { status: 400, message: "Invalid media URL" };
    case "too-many-redirects":
      return {
        status: 400,
        message: `Refused: redirect chain is longer than allowed (${failure.detail ?? "too many hops"})`,
      };
    case "unsupported-media-type":
      return {
        status: 400,
        message: `Refused: unsupported media type (${failure.detail ?? "no content type"})`,
      };
    case "oversized":
      return {
        status: 413,
        message: `Content size exceeds maximum allowed ${MAX_CONTENT_SIZE} bytes`,
      };
    case "resolution-failed":
      return {
        status: 502,
        message: `Failed to resolve media destination (${failure.detail ?? "unknown host"})`,
      };
    case "upstream-error":
      return {
        status: 502,
        message: `Failed to fetch content: ${failure.detail ?? "upstream error"}`,
      };
  }
}

// POST: Save a generated image or video to the generations folder (or outputs folder)
export const POST = withPrivilegedApi(
  ["local-file-write", "remote-media-fetch"],
  async (request: NextRequest) => {
  let directoryPath: string | undefined;
  try {
    const body = await request.json();
    directoryPath = body.directoryPath;
    const image = body.image;
    const video = body.video;
    const model3d = body.model3d;
    const audio = body.audio;
    const prompt = body.prompt;
    const imageId = body.imageId; // Optional ID for carousel support
    const customFilename = body.customFilename; // Optional custom filename (without extension)
    const createDirectory = body.createDirectory; // Optional flag to create directory if it doesn't exist

    const isVideo = !!video;
    const isModel = !!model3d;
    const isAudio = !!audio;
    const content = video || model3d || audio || image;

    logger.info('file.save', 'Generation auto-save request received', {
      directoryPath,
      hasImage: !!image,
      hasVideo: !!video,
      hasModel3d: !!model3d,
      hasAudio: !!audio,
      prompt,
      customFilename,
    });

    if (!directoryPath || !content) {
      logger.warn('file.save', 'Generation save validation failed: missing fields', {
        hasDirectoryPath: !!directoryPath,
        hasContent: !!content,
      });
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    const pathValidation = validateWorkflowPath(directoryPath);
    if (!pathValidation.valid) {
      logger.warn('file.save', 'Generation save path validation failed', {
        directoryPath,
        error: pathValidation.error,
      });
      return NextResponse.json(
        { success: false, error: pathValidation.error },
        { status: 400 }
      );
    }

    // Confine writes: the caller-supplied project directory is the write root,
    // but it must itself be an authorized root and outside the application's
    // own source and static subtrees. This runs before anything is created.
    const directoryScope = checkWriteTarget(directoryPath);
    if (!directoryScope.ok) {
      logger.warn('file.save', 'Generation save refused: directory outside authorized write scope', {
        directoryPath,
        reason: directoryScope.reason,
      });
      return NextResponse.json(
        { success: false, error: `Write target not authorized (${directoryScope.reason})` },
        { status: 400 }
      );
    }

    // Validate directory exists (or create if requested)
    try {
      const stats = await fs.stat(directoryPath);
      if (!stats.isDirectory()) {
        logger.warn('file.error', 'Generation save failed: path is not a directory', {
          directoryPath,
        });
        return NextResponse.json(
          { success: false, error: "Path is not a directory" },
          { status: 400 }
        );
      }
    } catch (dirError) {
      // Directory doesn't exist - create it if requested
      if (createDirectory) {
        try {
          await fs.mkdir(directoryPath, { recursive: true });
          logger.info('file.save', 'Created output directory', { directoryPath });
        } catch (mkdirError) {
          logger.error('file.error', 'Failed to create output directory', {
            directoryPath,
          }, mkdirError instanceof Error ? mkdirError : undefined);
          return NextResponse.json(
            { success: false, error: "Failed to create output directory" },
            { status: 500 }
          );
        }
      } else {
        logger.warn('file.error', 'Generation save failed: directory does not exist', {
          directoryPath,
        });
        return NextResponse.json(
          { success: false, error: "Directory does not exist" },
          { status: 400 }
        );
      }
    }

    let buffer: Buffer;
    let extension: string;
    let mediaType: string;

    if (isHttpUrl(content)) {
      // Handle HTTP URL (common for large video files from providers)
      logger.info('file.save', 'Fetching content from URL', { url: content.substring(0, 100) });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        // One safe-media seam for the whole download: every hop of the redirect
        // chain is checked against the address policy before it is followed, the
        // response must be an accepted media type and the byte budget is
        // enforced while reading.
        const download = await downloadSafeMedia(content, {
          authorizedOrigins: "provider-output",
          allowedMediaTypes: ACCEPTED_ASSET_MEDIA_TYPES,
          allowOctetStreamForMediaPaths: true,
          extensionsForOpaqueMedia: OPAQUE_MEDIA_EXTENSIONS,
          maxBytes: MAX_CONTENT_SIZE,
          signal: controller.signal,
        });

        if (!download.ok) {
          const refusal = describeDownloadRefusal(download);
          logger.warn('file.save', 'Generation save refused: unsafe media download', {
            directoryPath,
            reason: download.reason,
            detail: download.detail,
          });
          return NextResponse.json(
            { success: false, error: redactSecretsInText(refusal.message) },
            { status: refusal.status }
          );
        }

        mediaType = download.mediaType;

        // For 3D models, try extracting extension from URL first (most reliable with CDN URLs)
        const urlExtension = isModel ? getExtensionFromUrl(content) : null;

        if (urlExtension) {
          extension = urlExtension;
        } else {
          const contentType = (mediaType.startsWith("video/") || mediaType.startsWith("image/") || mediaType.startsWith("model/") || mediaType.startsWith("audio/"))
            ? mediaType
            : (isModel ? "model/gltf-binary" : isAudio ? "audio/mpeg" : isVideo ? "video/mp4" : "image/png");
          extension = getExtensionFromMime(contentType);
        }

        buffer = Buffer.from(download.bytes);
      } catch (fetchError) {
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
        }
        throw fetchError;
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      // Handle base64 data URL. The payload is taken from the match itself, so
      // the `data:` header (with or without `;charset=…`-style parameters) can
      // never end up inside the stored bytes.
      const dataUrlMatch = content.match(/^data:([^;,]+)((?:;[^;,]*)*);base64,([\s\S]*)$/);
      if (dataUrlMatch) {
        mediaType = dataUrlMatch[1];
        extension = getExtensionFromMime(mediaType);
        buffer = Buffer.from(dataUrlMatch[3], "base64");
      } else {
        // Fallback: assume it's raw base64 without data URL prefix
        mediaType = isAudio ? "audio/mpeg" : isVideo ? "video/mp4" : isModel ? "model/gltf-binary" : "image/png";
        extension = isAudio ? "mp3" : isVideo ? "mp4" : "png";
        buffer = Buffer.from(content, "base64");
      }
    }

    // Nothing text-like may be renamed as an image asset: an SVG carrying active
    // content and any unknown/HTML/text payload are refused on both branches.
    // An inert SVG stays supported, but only as a download artifact.
    const contentKind = classifyMediaContent(mediaType, buffer);
    if (contentKind === "active-svg" || contentKind === "unknown") {
      logger.warn('file.save', 'Generation save refused: content is not storable media', {
        directoryPath,
        mediaType,
        contentKind,
      });
      return NextResponse.json(
        {
          success: false,
          error: redactSecretsInText(
            contentKind === "active-svg"
              ? "Refused: SVG payload contains active content (script, event handler or external reference)"
              : `Refused: unsupported media content (${mediaType || "unknown type"})`
          ),
        },
        { status: 400 }
      );
    }

    // Safety net: if extension resolved to "bin" but we know the media type, use correct extension
    if (extension === "bin") {
      if (isModel && isHttpUrl(content)) {
        extension = getExtensionFromUrl(content) || "glb";
      } else {
        extension = isModel ? "glb" : isAudio ? "mp3" : isVideo ? "mp4" : "png";
      }
    }

    // Compute content hash for deduplication
    const contentHash = computeContentHash(buffer);

    // Check for existing file with same hash (deduplication)
    const existingFile = await findExistingFileByHash(directoryPath, contentHash, extension);
    if (existingFile) {
      const existingPath = joinWorkflowPath(directoryPath, existingFile);
      logger.info('file.save', 'Generation deduplicated: existing file found', {
        contentHash,
        existingFile,
        filePath: existingPath,
      });

      return NextResponse.json({
        success: true,
        filePath: existingPath,
        filename: existingFile,
        imageId: existingFile.replace(`.${extension}`, ''),
        isDuplicate: true,
      });
    }

    // Generate filename - use custom filename if provided, otherwise use prompt snippet
    let filename: string;
    if (customFilename) {
      // Sanitize custom filename
      const sanitizedFilename = customFilename
        .replace(/[^a-zA-Z0-9-_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
      filename = `${sanitizedFilename}_${contentHash}.${extension}`;
    } else {
      const promptSnippet = prompt
        ? prompt
            .slice(0, 30)
            .replace(/[^a-zA-Z0-9]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "")
            .toLowerCase()
        : "generation";
      filename = `${promptSnippet}_${contentHash}.${extension}`;
    }
    const filePath = joinWorkflowPath(directoryPath, filename);

    // The resolved asset path must stay inside the project directory that the
    // request was allowed to write into.
    const fileScope = checkWriteTarget(filePath);
    if (!fileScope.ok) {
      logger.warn('file.save', 'Generation save refused: file outside authorized write scope', {
        directoryPath,
        filePath,
        reason: fileScope.reason,
      });
      return NextResponse.json(
        { success: false, error: `Write target not authorized (${fileScope.reason})` },
        { status: 400 }
      );
    }

    // Write the file
    await fs.writeFile(filePath, buffer);

    logger.info('file.save', 'Generation auto-saved successfully', {
      filePath,
      filename,
      fileSize: buffer.length,
      isVideo,
      isModel,
      isAudio,
      contentHash,
    });

    return NextResponse.json({
      success: true,
      filePath,
      filename,
      imageId: filename.replace(`.${extension}`, ''),
      isDuplicate: false,
    });
  } catch (error) {
    logger.error('file.error', 'Failed to save generation', {
      directoryPath,
    }, error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? redactSecretsInText(error.message) : "Save failed",
      },
      { status: 500 }
    );
  }
});
