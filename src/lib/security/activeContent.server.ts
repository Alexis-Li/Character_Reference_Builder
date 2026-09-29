import sharp from "sharp";
import { classifyMediaContent } from "./activeContent";

/** Decode every pixel before persisting a declared raster image. */
export async function isDecodableRaster(contentType: string, bytes: Uint8Array): Promise<boolean> {
  if (classifyMediaContent(contentType, bytes) !== "raster") return false;
  try {
    // stats() forces libvips to decode the image without retaining a raw output
    // buffer. The pixel limit prevents small compressed inputs from expanding
    // without bound in the server process.
    const input = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    await sharp(input, { failOn: "error", limitInputPixels: 100_000_000 }).stats();
    return true;
  } catch {
    return false;
  }
}
