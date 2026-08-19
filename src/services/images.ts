/**
 * Image loading and validation for the Vision Helper MCP server.
 *
 * Accepts an image in any of these forms:
 *   - http(s) URL          (downloaded with redirect + private-host validation,
 *                           streamed with a hard byte cap)
 *   - local file path      (absolute or relative to the server's CWD, ~ expanded)
 *   - file:// URI
 *   - data: URI            (data:image/png;base64,...)
 *   - raw base64 payload   (MIME type sniffed from magic bytes)
 *
 * Only the content types OpenRouter supports for vision input are accepted
 * (PNG, JPEG, WebP, GIF); anything else is rejected with conversion guidance
 * before any bytes are uploaded.
 */

import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import {
  ABSOLUTE_MAX_IMAGE_SIZE,
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  SUPPORTED_FORMATS,
  SUPPORTED_IMAGE_TYPES,
} from "../constants.js";

export interface LoadedImage {
  mimeType: string;
  base64: string;
  byteLength: number;
  sourceLabel: string;
}

/** User-facing error with guidance, never leaks internal details. */
export class VisionImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionImageError";
  }
}

const DATA_URI_RE = /^data:([^;,]+);base64,(.*)$/s;

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// IPv4 prefixes that must never be fetched: loopback, private, link-local,
// CGNAT, benchmarking, and the reserved 0.0.0.0/8 and 192.0.0.0/24 ranges.
const PRIVATE_IPV4_PREFIXES: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 (CGNAT)
  [0x7f000000, 8], // 127.0.0.0/8 (loopback)
  [0xa9fe0000, 16], // 169.254.0.0/16 (link-local)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc6120000, 15], // 198.18.0.0/15 (benchmarking)
];

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const num = ipv4ToNumber(ip);
  if (num === null) return false;
  for (const [prefix, bits] of PRIVATE_IPV4_PREFIXES) {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    if (((num & mask) >>> 0) === prefix) return true;
  }
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) {
    if (host === "::1" || host === "::") return true;
    if (/^fe80:/i.test(host)) return true; // link-local
    if (/^f[cd]/i.test(host)) return true; // fc00::/7 ULA
    if (host.startsWith("::ffff:")) {
      return isPrivateIpv4(host.slice("::ffff:".length)); // IPv4-mapped
    }
  }
  return false;
}

/** Validate that a URL is http(s) and does not point at a private/internal host. */
async function assertPublicUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VisionImageError(`Invalid image URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VisionImageError(
      `Unsupported URL protocol '${parsed.protocol}' in ${url}. Only http(s) image URLs are accepted.`
    );
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (isPrivateHostname(host)) {
    throw new VisionImageError(
      `Refusing to fetch image from private or internal host '${host}' (${url}).`
    );
  }
  if (isIP(host) !== 0) return; // numeric hosts fully validated above
  try {
    const addresses = await lookup(host, { all: true });
    for (const entry of addresses) {
      if (isPrivateHostname(entry.address)) {
        throw new VisionImageError(
          `Refusing to fetch image from '${host}' — it resolves to the private/internal address ${entry.address}.`
        );
      }
    }
  } catch (error) {
    if (error instanceof VisionImageError) throw error;
    throw new VisionImageError(`Could not resolve host '${host}' for image URL ${url}. Check the URL and retry.`);
  }
}

function enforceSize(buf: Buffer, maxBytes: number): void {
  if (buf.length > maxBytes) {
    throw new VisionImageError(
      `Image is ${buf.length} bytes, which exceeds MAX_IMAGE_SIZE (${maxBytes} bytes). ` +
        `Resize or compress the image, or raise MAX_IMAGE_SIZE (up to ${ABSOLUTE_MAX_IMAGE_SIZE / (1024 * 1024)} MB).`
    );
  }
}

/** Reject anything OpenRouter vision models cannot accept, with conversion guidance. */
function requireSupportedType(mime: string, context: string): string {
  if (!SUPPORTED_IMAGE_TYPES.has(mime)) {
    throw new VisionImageError(
      `${context} is '${mime}', but OpenRouter vision models only accept ${SUPPORTED_FORMATS}. ` +
        `Convert the image and retry.`
    );
  }
  return mime;
}

/** Detect the MIME type from magic bytes; returns null when unrecognized. */
export function sniffMimeType(bytes: Buffer): string | null {
  if (bytes.length < 4) return null;
  // PNG
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // GIF
  if (bytes.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  // WebP (RIFF....WEBP)
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  // TIFF (little/big endian)
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return "image/tiff";
  }
  // ICO
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return "image/x-icon";
  }
  // AVIF / HEIC (ftyp box)
  if (bytes.toString("ascii", 0, 4) === "ftyp") {
    const brand = bytes.toString("ascii", 4, 8);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "mif1") return "image/heic";
  }
  // SVG (XML text) — detected for a helpful error; never sent to OpenRouter.
  const head = bytes.subarray(0, 1024).toString("utf8").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

function requireImageMime(mime: string): string {
  const normalized = mime.trim().toLowerCase();
  if (!normalized.startsWith("image/")) {
    throw new VisionImageError(
      `Expected an image MIME type, got '${normalized}'. Supported formats: ${SUPPORTED_FORMATS}.`
    );
  }
  return normalized;
}

/** Stream the response body with a hard byte cap so no unbounded buffer is possible. */
async function readBodyCapped(response: Response, maxBytes: number, url: string): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new VisionImageError(
      `Image at ${url} is ${contentLength} bytes, exceeding MAX_IMAGE_SIZE (${maxBytes} bytes).`
    );
  }
  if (response.body === null) {
    throw new VisionImageError(`No response body received from ${url}.`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new VisionImageError(
        `Image at ${url} exceeds MAX_IMAGE_SIZE (${maxBytes} bytes); download aborted.`
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function downloadUrl(url: string, maxBytes: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);
  try {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicUrl(currentUrl);
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Vision-Helper-MCP/1.0" },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (location === null) {
          throw new VisionImageError(`Server at ${currentUrl} sent a redirect without a Location header.`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        throw new VisionImageError(
          `Failed to download image from ${currentUrl} (HTTP ${response.status}). ` +
            `Check that the URL is public and accessible.`
        );
      }
      return await readBodyCapped(response, maxBytes, currentUrl);
    }
    throw new VisionImageError(`Too many redirects (more than ${MAX_REDIRECTS}) downloading image from ${url}.`);
  } catch (error) {
    if (error instanceof VisionImageError) throw error;
    if (controller.signal.aborted) {
      throw new VisionImageError(
        `Timed out after ${IMAGE_DOWNLOAD_TIMEOUT_MS / 1000}s downloading image from ${url}. ` +
          `Try a smaller image or a different URL.`
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new VisionImageError(`Failed to fetch image from ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the string looks like a raw base64 payload (not a path/URL). */
function looksLikeBase64(s: string): boolean {
  const compact = s.replace(/\s+/g, "");
  if (compact.length < 64 || compact.length % 4 === 1) return false;
  return /^[A-Za-z0-9+/=]+$/.test(compact);
}

/**
 * Load a single image from any supported source into a data-URL-ready payload.
 *
 * @param sourceRaw URL, file path, file:// URI, data URI, or raw base64.
 * @param maxBytes  Maximum accepted payload size in bytes.
 */
export async function loadImage(sourceRaw: string, maxBytes: number): Promise<LoadedImage> {
  const source = sourceRaw.trim();
  if (source.length === 0) {
    throw new VisionImageError("Image source is empty. Provide a URL, file path, data URI, or base64 data.");
  }

  // 1. data: URI
  const dataUriMatch = source.match(DATA_URI_RE);
  if (dataUriMatch !== null) {
    const mime = requireSupportedType(
      requireImageMime(dataUriMatch[1]!),
      "Declared data URI MIME type"
    );
    const buf = Buffer.from(dataUriMatch[2]!.replace(/\s+/g, ""), "base64");
    if (buf.length === 0) throw new VisionImageError("data: URI contained no decodable image data.");
    enforceSize(buf, maxBytes);
    return { mimeType: mime, base64: buf.toString("base64"), byteLength: buf.length, sourceLabel: "data URI" };
  }

  // 2. http(s) URL
  if (/^https?:\/\//i.test(source)) {
    const buf = await downloadUrl(source, maxBytes);
    enforceSize(buf, maxBytes);
    const mime = sniffMimeType(buf);
    if (mime === null) {
      throw new VisionImageError(
        `Downloaded ${buf.length} bytes from ${source} but they are not a recognized image. ` +
          `Supported formats: ${SUPPORTED_FORMATS}.`
      );
    }
    const supported = requireSupportedType(mime, "Downloaded image format");
    return { mimeType: supported, base64: buf.toString("base64"), byteLength: buf.length, sourceLabel: `URL ${source}` };
  }

  // 2b. Any other URL scheme (ftp:, gopher:, ...) — rejected with guidance.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source) && !/^file:\/\//i.test(source)) {
    const scheme = source.slice(0, source.indexOf(":"));
    throw new VisionImageError(
      `Unsupported URL protocol '${scheme}:' in ${source}. Only http(s) image URLs are accepted.`
    );
  }

  // 3. file:// URI
  let filePath = source;
  if (filePath.startsWith("file://")) {
    let decoded = decodeURIComponent(filePath.slice("file://".length));
    if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1); // file:///C:/... on Windows
    filePath = decoded;
  }

  // 4. Local file path
  const candidatePath = filePath === "~" || filePath.startsWith("~/") || filePath.startsWith("~\\")
    ? path.join(homedir(), filePath.slice(2))
    : filePath;
  const absolutePath = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(process.cwd(), candidatePath);

  let fileBuf: Buffer | null = null;
  let fileNotFound = false;
  try {
    fileBuf = await readFile(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES") {
      throw new VisionImageError(`Permission denied reading file: ${absolutePath}.`);
    }
    // Anything that means "this is not a usable file path" falls through so
    // long base64 payloads (whose names exceed path limits) still reach the
    // base64 branch below.
    if (
      code !== "ENOENT" && code !== "EISDIR" && code !== "ENOTDIR" &&
      code !== "ENAMETOOLONG" && code !== "EINVAL"
    ) {
      throw error;
    }
    fileNotFound = true;
  }

  if (fileBuf !== null) {
    enforceSize(fileBuf, maxBytes);
    const mime = sniffMimeType(fileBuf);
    if (mime === null) {
      throw new VisionImageError(
        `File ${absolutePath} (${fileBuf.length} bytes) is not a recognized image. ` +
          `Supported formats: ${SUPPORTED_FORMATS}.`
      );
    }
    const supported = requireSupportedType(mime, `Format of file ${absolutePath}`);
    return {
      mimeType: supported,
      base64: fileBuf.toString("base64"),
      byteLength: fileBuf.length,
      sourceLabel: `file ${absolutePath}`,
    };
  }

  // 5. Raw base64 payload with sniffed MIME type
  if (looksLikeBase64(source)) {
    const compact = source.replace(/\s+/g, "");
    const buf = Buffer.from(compact, "base64");
    if (buf.length > 0) {
      const mime = sniffMimeType(buf);
      if (mime !== null) {
        enforceSize(buf, maxBytes);
        const supported = requireSupportedType(mime, "Base64 payload format");
        return { mimeType: supported, base64: buf.toString("base64"), byteLength: buf.length, sourceLabel: "base64 data" };
      }
    }
  }

  const notFoundHint = fileNotFound
    ? `No file found at ${absolutePath}. `
    : "";
  throw new VisionImageError(
    `${notFoundHint}Could not interpret the image source as a URL, existing file, data URI, or base64 image. ` +
      `Supported formats: ${SUPPORTED_FORMATS}.`
  );
}
