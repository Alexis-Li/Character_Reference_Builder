import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/utils/logger";
import { joinWorkflowPath, validateWorkflowPath } from "@/utils/pathValidation";
import { atomicReplaceFile } from "@/lib/projectFiles.server";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";
import { checkWriteTarget } from "@/lib/security/projectWriteScope.server";
import { redactSecretsInText } from "@/lib/security/secretRedaction";
import { classifyMediaContent } from "@/lib/security/activeContent";

export const maxDuration = 300; // 5 minute timeout for large image operations

const IMAGES_FOLDER = "inputs";
const LEGACY_IMAGES_FOLDER = ".images"; // For backward compatibility

/** Raster media types this route stores, keyed to their on-disk extension. */
const RASTER_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// POST: Save an image to the workflow's inputs or generations folder
export const POST = withPrivilegedApi(["local-file-write"], async (request: NextRequest) => {
  let workflowPath: string | undefined;
  let imageId: string | undefined;
  let folder: string | undefined;
  try {
    const body = await request.json();
    workflowPath = body.workflowPath;
    imageId = body.imageId;
    folder = body.folder || IMAGES_FOLDER; // Default to "inputs"
    const imageData = body.imageData; // Base64 data URL

    // Validate folder is one of the allowed values
    if (folder !== IMAGES_FOLDER && folder !== "generations") {
      folder = IMAGES_FOLDER;
    }

    logger.info('file.save', 'Workflow image save request received', {
      workflowPath,
      imageId,
      folder,
      hasImageData: !!imageData,
    });

    if (!workflowPath || !imageId || !imageData) {
      logger.warn('file.save', 'Workflow image save validation failed: missing fields', {
        hasWorkflowPath: !!workflowPath,
        hasImageId: !!imageId,
        hasImageData: !!imageData,
      });
      return NextResponse.json(
        { success: false, error: "Missing required fields (workflowPath, imageId, imageData)" },
        { status: 400 }
      );
    }

    // Validate path to prevent traversal attacks
    const pathValidation = validateWorkflowPath(workflowPath);
    if (!pathValidation.valid) {
      logger.warn('file.error', 'Workflow image save failed: invalid path', {
        workflowPath,
        error: pathValidation.error,
      });
      return NextResponse.json(
        { success: false, error: pathValidation.error },
        { status: 400 }
      );
    }

    // Confine writes: the workflow directory is the write root, but it must
    // itself be an authorized root and outside the application's own source and
    // static subtrees. This runs before anything is created.
    const workflowScope = checkWriteTarget(workflowPath);
    if (!workflowScope.ok) {
      logger.warn('file.error', 'Workflow image save refused: write scope rejected', {
        workflowPath,
        reason: workflowScope.reason,
      });
      return NextResponse.json(
        { success: false, error: `Write target not authorized (${workflowScope.reason})` },
        { status: 400 }
      );
    }

    // Validate workflow directory exists, or create it if missing
    try {
      const stats = await fs.stat(workflowPath);
      if (!stats.isDirectory()) {
        logger.warn('file.error', 'Workflow image save failed: path is not a directory', {
          workflowPath,
        });
        return NextResponse.json(
          { success: false, error: "Workflow path is not a directory" },
          { status: 400 }
        );
      }
    } catch (dirError) {
      const err = dirError as NodeJS.ErrnoException;
      const isNotFound =
        err?.code === "ENOENT" ||
        (typeof err?.message === "string" &&
          (err.message.includes("ENOENT") || err.message.includes("no such file or directory")));

      if (!isNotFound) {
        logger.warn('file.error', 'Workflow image save failed: directory validation error', {
          workflowPath,
          error: dirError instanceof Error ? dirError.message : 'Unknown error',
        });
        return NextResponse.json(
          { success: false, error: "Directory validation failed" },
          { status: 400 }
        );
      }

      try {
        await fs.mkdir(workflowPath, { recursive: true });
        logger.info('file.save', 'Created workflow directory for image save', {
          workflowPath,
        });
      } catch (mkdirError) {
        logger.error('file.error', 'Failed to create workflow directory', {
          workflowPath,
        }, mkdirError instanceof Error ? mkdirError : undefined);
        return NextResponse.json(
          { success: false, error: "Failed to create workflow directory" },
          { status: 500 }
        );
      }
    }

    // Create target folder if it doesn't exist
    const targetFolder = joinWorkflowPath(workflowPath, folder);
    const folderScope = checkWriteTarget(targetFolder);
    if (!folderScope.ok) {
      logger.warn('file.error', 'Workflow image save refused: write scope rejected', {
        workflowPath,
        targetFolder,
        reason: folderScope.reason,
      });
      return NextResponse.json(
        { success: false, error: `Write target not authorized (${folderScope.reason})` },
        { status: 400 }
      );
    }
    try {
      await fs.mkdir(targetFolder, { recursive: true });
    } catch (mkdirError) {
      logger.error('file.error', 'Failed to create target folder', {
        targetFolder,
      }, mkdirError instanceof Error ? mkdirError : undefined);
      return NextResponse.json(
        { success: false, error: "Failed to create target folder" },
        { status: 500 }
      );
    }

    // Sanitize imageId to prevent path traversal
    const safeImageId = path.basename(imageId);
    if (safeImageId !== imageId || imageId.includes('..')) {
      return NextResponse.json(
        { success: false, error: "Invalid imageId" },
        { status: 400 }
      );
    }

    // Parse the data URL exactly: matching the prefix (including any
    // `;charset=…`-style parameters) is what keeps the `data:` header out of the
    // bytes on disk, and the declared type decides whether the payload may be
    // stored at all. No data URL prefix means raw base64 PNG.
    const dataUrlMatch = imageData.match(/^data:([^;,]+)((?:;[^;,]*)*);base64,([\s\S]*)$/);
    const declaredMime = dataUrlMatch ? dataUrlMatch[1] : "image/png";
    const base64Data = dataUrlMatch ? dataUrlMatch[3] : imageData;
    const buffer = Buffer.from(base64Data, "base64");

    // Only raster media is stored: this route feeds assets back into the app,
    // so an SVG (a document, not an image) or an HTML/text payload must never be
    // written under an image extension.
    const contentKind = classifyMediaContent(declaredMime, buffer);
    if (contentKind !== "raster") {
      let refusal = `Refused: only raster image data can be stored (${declaredMime || "unknown type"})`;
      if (contentKind === "active-svg") {
        refusal = "Refused: SVG payload contains active content (script, event handler or external reference)";
      } else if (contentKind === "inert-svg") {
        refusal = "Refused: SVG payloads are not stored as workflow images";
      }
      logger.warn('file.error', 'Workflow image save refused: content is not a raster image', {
        workflowPath,
        imageId,
        declaredMime,
        contentKind,
      });
      return NextResponse.json(
        { success: false, error: redactSecretsInText(refusal) },
        { status: 400 }
      );
    }

    const extension = RASTER_EXTENSIONS[declaredMime] ?? "png";
    const filename = `${safeImageId}.${extension}`;
    const filePath = joinWorkflowPath(targetFolder, filename);

    // The resolved asset path must stay inside the workflow directory that the
    // request was allowed to write into.
    const fileScope = checkWriteTarget(filePath);
    if (!fileScope.ok) {
      logger.warn('file.error', 'Workflow image save refused: write scope rejected', {
        workflowPath,
        filePath,
        reason: fileScope.reason,
      });
      return NextResponse.json(
        { success: false, error: `Write target not authorized (${fileScope.reason})` },
        { status: 400 }
      );
    }

    // An interrupted replacement must leave either the old asset or the fully
    // written new asset available to the project manifest.
    await atomicReplaceFile(filePath, buffer);

    logger.info('file.save', 'Workflow image saved successfully', {
      filePath,
      imageId,
      fileSize: buffer.length,
    });

    return NextResponse.json({
      success: true,
      imageId,
      filePath,
    });
  } catch (error) {
    logger.error('file.error', 'Failed to save workflow image', {
      workflowPath,
      imageId,
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

// GET: Load an image from the workflow's folders (inputs, generations, or legacy .images)
export const GET = withPrivilegedApi(["local-file-read"], async (request: NextRequest) => {
  const workflowPath = request.nextUrl.searchParams.get("workflowPath");
  const imageId = request.nextUrl.searchParams.get("imageId");
  const folder = request.nextUrl.searchParams.get("folder"); // Optional hint for which folder to check first

  logger.info('file.load', 'Workflow image load request received', {
    workflowPath,
    imageId,
    folder,
  });

  if (!workflowPath || !imageId) {
    logger.warn('file.load', 'Workflow image load validation failed: missing parameters', {
      hasWorkflowPath: !!workflowPath,
      hasImageId: !!imageId,
    });
    return NextResponse.json(
      { success: false, error: "Missing required parameters (workflowPath, imageId)" },
      { status: 400 }
    );
  }

  try {
    // Validate path to prevent traversal attacks
    const pathValidation = validateWorkflowPath(workflowPath);
    if (!pathValidation.valid) {
      logger.warn('file.error', 'Workflow image load failed: invalid path', {
        workflowPath,
        error: pathValidation.error,
      });
      return NextResponse.json(
        { success: false, error: pathValidation.error },
        { status: 400 }
      );
    }

    // Sanitize imageId to prevent path traversal
    const safeImageId = path.basename(imageId);
    if (safeImageId !== imageId || imageId.includes('..')) {
      return NextResponse.json(
        { success: false, error: "Invalid imageId" },
        { status: 400 }
      );
    }

    // Validate workflow directory exists
    try {
      const stats = await fs.stat(workflowPath);
      if (!stats.isDirectory()) {
        return NextResponse.json(
          { success: false, error: "Workflow path is not a directory" },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { success: false, error: "Workflow directory does not exist" },
        { status: 400 }
      );
    }

    // Construct file path - check folders and extensions in order
    const possibleExtensions = ["png", "jpg", "jpeg", "gif", "webp"];
    const inputsFolder = joinWorkflowPath(workflowPath, IMAGES_FOLDER);
    const generationsFolder = joinWorkflowPath(workflowPath, "generations");
    const legacyFolder = joinWorkflowPath(workflowPath, LEGACY_IMAGES_FOLDER);

    // Build search order based on folder hint
    const searchOrder = folder === "generations"
      ? [generationsFolder, inputsFolder, legacyFolder]
      : [inputsFolder, generationsFolder, legacyFolder];

    let filePath: string | null = null;
    let foundExtension = "png"; // Track which extension was found

    // Check each folder and extension combination in order
    for (const searchFolder of searchOrder) {
      for (const ext of possibleExtensions) {
        const filename = `${safeImageId}.${ext}`;
        const candidatePath = joinWorkflowPath(searchFolder, filename);
        try {
          await fs.access(candidatePath);
          filePath = candidatePath;
          foundExtension = ext;
          if (searchFolder === legacyFolder) {
            logger.info('file.load', 'Found image in legacy .images folder', { filePath });
          }
          break;
        } catch {
          // File not found with this extension, try next
        }
      }
      if (filePath) break; // Stop searching if file was found
    }

    if (!filePath) {
      // Return 200 with success: false to avoid Next.js error overlay
      // Missing files are expected when workflow refs point to deleted/moved images
      logger.info('file.load', 'Workflow image not found (expected for missing refs)', {
        imageId,
        searchedFolders: searchOrder,
      });
      return NextResponse.json({
        success: false,
        error: "Image file not found",
        notFound: true,
      });
    }

    // Read the image file
    const buffer = await fs.readFile(filePath);

    // Convert to base64 data URL with correct MIME type
    const base64 = buffer.toString("base64");
    const mimeType = foundExtension === "jpg" || foundExtension === "jpeg"
      ? "image/jpeg"
      : `image/${foundExtension}`;
    const dataUrl = `data:${mimeType};base64,${base64}`;

    logger.info('file.load', 'Workflow image loaded successfully', {
      filePath,
      imageId,
      fileSize: buffer.length,
    });

    return NextResponse.json({
      success: true,
      imageId,
      image: dataUrl,
    });
  } catch (error) {
    logger.error('file.error', 'Failed to load workflow image', {
      workflowPath,
      imageId,
    }, error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? redactSecretsInText(error.message) : "Load failed",
      },
      { status: 500 }
    );
  }
});
