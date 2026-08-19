import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { loadImage, sniffMimeType, VisionImageError } from "../src/services/images.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("sniffMimeType detects supported formats", () => {
  assert.equal(sniffMimeType(Buffer.concat([PNG_MAGIC, Buffer.alloc(16)])), "image/png");
  assert.equal(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])), "image/jpeg");
  assert.equal(sniffMimeType(Buffer.from("GIF89a", "ascii")), "image/gif");
  const webp = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")]);
  assert.equal(sniffMimeType(webp), "image/webp");
});

test("sniffMimeType detects other formats and unknown data", () => {
  assert.equal(sniffMimeType(Buffer.from([0x42, 0x4d, 0x00, 0x00])), "image/bmp");
  assert.equal(sniffMimeType(Buffer.from([0x49, 0x49, 0x2a, 0x00])), "image/tiff");
  assert.equal(sniffMimeType(Buffer.from([0x00, 0x00, 0x01, 0x00])), "image/x-icon");
  assert.equal(sniffMimeType(Buffer.from("ftypavif", "ascii")), "image/avif");
  assert.equal(sniffMimeType(Buffer.from("ftypheic", "ascii")), "image/heic");
  assert.equal(sniffMimeType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8")), "image/svg+xml");
  assert.equal(sniffMimeType(Buffer.from("hello world this is not an image", "utf8")), null);
  assert.equal(sniffMimeType(Buffer.from([0x01, 0x02])), null);
});

test("loadImage accepts a data URI", async () => {
  const img = await loadImage("data:image/png;base64,aGVsbG8=", 1024 * 1024);
  assert.equal(img.mimeType, "image/png");
  assert.equal(img.byteLength, 5);
  assert.equal(img.sourceLabel, "data URI");
});

test("loadImage rejects unsupported data URI formats", async () => {
  await assert.rejects(
    () => loadImage("data:image/bmp;base64,QQ==", 1024 * 1024),
    (err: unknown) => err instanceof VisionImageError && /only accept PNG, JPEG, WebP, or GIF/.test(err.message)
  );
});

test("loadImage accepts raw base64 with a sniffed type", async () => {
  const png = Buffer.concat([PNG_MAGIC, Buffer.alloc(56)]);
  const img = await loadImage(png.toString("base64"), 1024 * 1024);
  assert.equal(img.mimeType, "image/png");
  assert.equal(img.byteLength, 64);
  assert.equal(img.sourceLabel, "base64 data");
});

test("loadImage reads local files and file:// URIs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vh-test-"));
  try {
    const png = Buffer.concat([PNG_MAGIC, Buffer.alloc(32)]);
    const filePath = join(dir, "test.png");
    writeFileSync(filePath, png);

    const fromPath = await loadImage(filePath, 1024 * 1024);
    assert.equal(fromPath.mimeType, "image/png");
    assert.equal(fromPath.byteLength, 40);

    const fromUri = await loadImage(pathToFileURL(filePath).toString(), 1024 * 1024);
    assert.equal(fromUri.mimeType, "image/png");
    assert.equal(normalize(fromUri.sourceLabel.slice("file ".length)), filePath);  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadImage refuses private hosts and non-http protocols", async () => {
  await assert.rejects(
    () => loadImage("http://localhost/img.png", 1024 * 1024),
    (err: unknown) => err instanceof VisionImageError && /private or internal host/.test(err.message)
  );
  await assert.rejects(
    () => loadImage("ftp://example.com/img.png", 1024 * 1024),
    (err: unknown) => err instanceof VisionImageError && /Unsupported URL protocol 'ftp:'/.test(err.message)
  );
});

test("loadImage enforces the size limit", async () => {
  await assert.rejects(
    () => loadImage("data:image/png;base64,aGVsbG8=", 4),
    (err: unknown) => err instanceof VisionImageError && /exceeds MAX_IMAGE_SIZE/.test(err.message)
  );
});

test("loadImage rejects unrecognized input", async () => {
  await assert.rejects(
    () => loadImage("not an image", 1024 * 1024),
    (err: unknown) => err instanceof VisionImageError && /Could not interpret the image source/.test(err.message)
  );
});
