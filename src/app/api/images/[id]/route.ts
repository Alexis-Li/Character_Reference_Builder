/**
 * Image Serving API Endpoint
 *
 * Serves temporarily stored images via URL for external providers.
 * Images are stored in memory and should be cleaned up by callers after use.
 * The store admits raster images only, so this origin never renders a
 * user-supplied document inline.
 *
 * GET /api/images/[id] - Retrieve stored image by ID
 */

import { NextRequest, NextResponse } from "next/server";
import { getImage } from "@/lib/images/store";
import { withPrivilegedApi } from "@/lib/security/requestGuard.server";

/**
 * GET handler - serve stored image
 */
export const GET = withPrivilegedApi(
  [],
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ): Promise<NextResponse> => {
  const { id } = await params;

  const image = getImage(id);

  if (!image) {
    return NextResponse.json(
      { error: "Image not found" },
      { status: 404 }
    );
  }

  // Convert Buffer to Uint8Array for NextResponse compatibility
  const uint8Array = new Uint8Array(image.data);

  return new NextResponse(uint8Array, {
    status: 200,
    headers: {
      "Content-Type": image.mimeType,
      "Cache-Control": "no-store",
      // The declared raster type is the whole contract: never let a browser
      // sniff the bytes into another document type.
      "X-Content-Type-Options": "nosniff",
    },
  });
});
