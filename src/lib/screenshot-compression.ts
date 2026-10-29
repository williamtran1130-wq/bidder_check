import { createHash } from "node:crypto";
import sharp from "sharp";

/** Best-effort server-side encoding; callers must validate the original first. */
export async function compressScreenshot(
  bytes: Uint8Array,
): Promise<{ bytes: Buffer; mime: "image/webp"; sha256: string } | null> {
  try {
    const image = sharp(Buffer.from(bytes), {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) > 1) return null;

    const output = await image
      .autoOrient()
      .webp({ quality: 90, alphaQuality: 100, effort: 4 })
      .toBuffer();
    if (output.length >= bytes.byteLength) return null;

    return {
      bytes: output,
      mime: "image/webp",
      sha256: createHash("sha256").update(output).digest("hex"),
    };
  } catch {
    return null;
  }
}
