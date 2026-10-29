import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compressScreenshot } from "@/lib/screenshot-compression";

const screenshot =
  Buffer.from(`<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg"><stop stop-color="#cce0f4"/><stop offset="1" stop-color="#fff4dc"/></linearGradient></defs>
  <rect width="640" height="360" fill="url(#bg)"/>
  ${Array.from({ length: 20 }, (_, row) => `<text x="12" y="${18 + row * 17}" font-family="sans-serif" font-size="12">${row + 1}. Example screenshot — https://example.test/jobs/123?view=all — $2,450.00</text>`).join("")}
</svg>`);

describe("compressScreenshot", () => {
  it.each(["png", "jpeg", "webp"] as const)(
    "returns a smaller decodable WebP and its digest for %s input",
    async (format) => {
      const original = await sharp(screenshot)
        .toFormat(format, {
          compressionLevel: 0,
          quality: 100,
          chromaSubsampling: "4:4:4",
        })
        .toBuffer();
      const result = await compressScreenshot(original);
      expect(result).not.toBeNull();
      expect(result!.mime).toBe("image/webp");
      expect(result!.bytes.length).toBeLessThan(original.length);
      expect(result!.sha256).toBe(
        createHash("sha256").update(result!.bytes).digest("hex"),
      );
      const { data, info } = await sharp(result!.bytes, { failOn: "warning" })
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(640);
      expect(info.height).toBe(360);
      expect(data.length).toBe(info.width * info.height * info.channels);
      expect((await sharp(result!.bytes).metadata()).format).toBe("webp");
    },
  );

  it("keeps the original when encoding has no savings, including tiny images", async () => {
    const original = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .webp({ quality: 90, alphaQuality: 100, effort: 4 })
      .toBuffer();
    expect(await compressScreenshot(original)).toBeNull();
  });

  it("preserves transparent and semitransparent alpha without resizing", async () => {
    const pixels = Buffer.alloc(64 * 64 * 4);
    for (let pixel = 0; pixel < 64 * 64; pixel++) {
      pixels[pixel * 4] = 100;
      pixels[pixel * 4 + 1] = 160;
      pixels[pixel * 4 + 2] = 220;
      pixels[pixel * 4 + 3] = pixel % 256;
    }
    const original = await sharp(pixels, {
      raw: { width: 64, height: 64, channels: 4 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const result = await compressScreenshot(original);
    expect(result).not.toBeNull();
    const decoded = await sharp(result!.bytes).ensureAlpha().raw().toBuffer();
    expect(decoded.filter((_, index) => index % 4 === 3)).toEqual(
      pixels.filter((_, index) => index % 4 === 3),
    );
  });

  it("applies EXIF orientation to pixels and strips metadata", async () => {
    const original = await sharp(
      Buffer.from(
        `<svg width="80" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" fill="red"/><rect x="40" width="40" height="40" fill="blue"/></svg>`,
      ),
    )
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .toBuffer();
    const result = await compressScreenshot(original);
    expect(result).not.toBeNull();
    const metadata = await sharp(result!.bytes).metadata();
    expect(metadata.width).toBe(40);
    expect(metadata.height).toBe(80);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    const { data, info } = await sharp(result!.bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const top = (10 * info.width + 20) * info.channels;
    const bottom = (70 * info.width + 20) * info.channels;
    expect(data[top]).toBeGreaterThan(230);
    expect(data[top + 2]).toBeLessThan(25);
    expect(data[bottom]).toBeLessThan(25);
    expect(data[bottom + 2]).toBeGreaterThan(230);
  });

  it("returns null for empty and corrupt input instead of throwing", async () => {
    await expect(compressScreenshot(new Uint8Array())).resolves.toBeNull();
    await expect(
      compressScreenshot(Buffer.from("not an image")),
    ).resolves.toBeNull();
  });

  it("returns null when a valid image header has truncated pixels", async () => {
    const original = await sharp(screenshot)
      .png({ compressionLevel: 0 })
      .toBuffer();
    const truncated = original.subarray(0, Math.floor(original.length / 2));
    expect((await sharp(truncated).metadata()).format).toBe("png");
    await expect(compressScreenshot(truncated)).resolves.toBeNull();
  });

  it("rejects multiple frames instead of silently keeping the first", async () => {
    const pixels = Buffer.concat([
      Buffer.alloc(20 * 20 * 3, 0),
      Buffer.alloc(20 * 20 * 3, 255),
    ]);
    const animated = await sharp(pixels, {
      raw: { width: 20, height: 40, pageHeight: 20, channels: 3 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(compressScreenshot(animated)).resolves.toBeNull();
  });

  it("rejects images larger than 40 million pixels before decoding", async () => {
    const original = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    // A valid PNG IHDR with an oversized width, without allocating a huge image.
    original.writeUInt32BE(40_000_001, 16);
    let crc = 0xffffffff;
    for (const byte of original.subarray(12, 29)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    original.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
    await expect(
      sharp(original, { limitInputPixels: false }).metadata(),
    ).resolves.toMatchObject({ width: 40_000_001, height: 1 });
    await expect(compressScreenshot(original)).resolves.toBeNull();
  });
});
