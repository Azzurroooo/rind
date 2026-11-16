import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { CancellationToken } from "../domain/cancellation.js";
import { CancelledError, ProviderError, type FailureStatus } from "../domain/errors.js";
import type { ImageAttachment } from "../domain/models.js";
import { applyExifOrientation } from "./exif-orientation.js";
import { loadPhotonSync, resetPhotonCache, type PhotonImageType, type PhotonModule } from "./photon.js";

export const IMAGE_WORKER_RESPONSE_TYPE = "rind:image-worker-response";

export interface SerializedImageWorkerResult {
  type: typeof IMAGE_WORKER_RESPONSE_TYPE;
  ok: true;
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
  hint: string;
}

export interface SerializedImageWorkerError {
  type: typeof IMAGE_WORKER_RESPONSE_TYPE;
  ok: false;
  message: string;
  code: string | null;
  status: FailureStatus;
  errorType: string;
}

export type ImageWorkerResponse = SerializedImageWorkerResult | SerializedImageWorkerError;

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 2000;
export const MAX_REQUEST_IMAGES = 8;
export const MAX_REQUEST_IMAGE_BYTES = 16 * 1024 * 1024;
export const LEGACY_IMAGE_NOTICE =
  "Older uploads references have no image snapshot. Resend the uploads reference or use read_file to inspect the image.";

export const IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

const UPLOAD_REFERENCE_RE =
  /(?<![\w./\\])(uploads\/[A-Za-z0-9._\-/]+\.(?:png|jpg|jpeg|webp|gif|bmp))(?![\w/\\-]|\.+[\w/\\-])/gi;

const ATTACHMENT_PATH_RE = /^attachments\/([0-9a-f]{64})\.(png|jpg|webp|gif|bmp)$/;

const ENCODE_STEPS: ReadonlyArray<readonly [number, number]> = [
  [2000, 90],
  [1600, 80],
  [1200, 70],
  [800, 65],
];

export type SupportedImageFormat = "PNG" | "JPEG" | "WEBP" | "GIF" | "BMP";

export function checkCancelled(token?: CancellationToken | null): void {
  if (token?.isCancelled) {
    throw new CancelledError(token.reason);
  }
}

export function detectImageSignature(sample: Buffer): SupportedImageFormat | null {
  if (
    sample.length >= 8 &&
    sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "PNG";
  }
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    return "JPEG";
  }
  if (sample.length >= 6) {
    const header6 = sample.subarray(0, 6).toString("ascii");
    if (header6 === "GIF87a" || header6 === "GIF89a") {
      return "GIF";
    }
  }
  if (sample.length >= 2 && sample[0] === 0x42 && sample[1] === 0x4d) {
    return "BMP";
  }
  if (
    sample.length >= 12 &&
    sample.subarray(0, 4).toString("ascii") === "RIFF" &&
    sample.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "WEBP";
  }
  return null;
}

export function isImageFile(filePath: string, sample: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_SUFFIXES.has(ext)) {
    return true;
  }
  return detectImageSignature(sample) !== null;
}

export interface DecodedImageHeader {
  format: SupportedImageFormat;
  mime: string;
  suffix: string;
  width: number;
  height: number;
}

export function parseImageHeader(data: Buffer): DecodedImageHeader {
  // PNG: 8-byte signature + IHDR chunk (4-byte length, "IHDR", 4-byte width, 4-byte height)
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    data.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { format: "PNG", mime: "image/png", suffix: "png", width, height };
    }
  }

  // GIF: "GIF87a" or "GIF89a" + uint16LE width + uint16LE height
  if (data.length >= 10) {
    const sig = data.subarray(0, 6).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") {
      const width = data.readUInt16LE(6);
      const height = data.readUInt16LE(8);
      if (width > 0 && height > 0) {
        return { format: "GIF", mime: "image/gif", suffix: "gif", width, height };
      }
    }
  }

  // BMP: "BM" + DIB header
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
    const dibSize = data.readUInt32LE(14);
    let width = 0;
    let height = 0;
    if (dibSize === 12) {
      width = data.readUInt16LE(18);
      height = data.readUInt16LE(20);
    } else if (dibSize >= 40) {
      width = Math.abs(data.readInt32LE(18));
      height = Math.abs(data.readInt32LE(22));
    }
    if (width > 0 && height > 0) {
      return { format: "BMP", mime: "image/bmp", suffix: "bmp", width, height };
    }
  }

  // WEBP: "RIFF" + size + "WEBP" + chunk ("VP8 ", "VP8L", "VP8X")
  if (
    data.length >= 25 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const chunkType = data.subarray(12, 16).toString("ascii");
    let width = 0;
    let height = 0;
    if (chunkType === "VP8 " && data.length >= 30) {
      width = data.readUInt16LE(26) & 0x3fff;
      height = data.readUInt16LE(28) & 0x3fff;
    } else if (chunkType === "VP8L" && data.length >= 25) {
      const b0 = data[21]!;
      const b1 = data[22]!;
      const b2 = data[23]!;
      const b3 = data[24]!;
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    } else if (chunkType === "VP8X" && data.length >= 30) {
      width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16));
      height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16));
    }
    if (width > 0 && height > 0) {
      return { format: "WEBP", mime: "image/webp", suffix: "webp", width, height };
    }
  }

  // JPEG: 0xFF 0xD8 ... scan SOF markers (0xC0..0xCF except 0xC4, 0xC8, 0xCC)
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < data.length && data[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= data.length) break;
      const marker = data[offset]!;
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        continue;
      }
      if (offset + 2 > data.length) break;
      const segLength = data.readUInt16BE(offset);
      if (segLength < 2 || offset + segLength > data.length) break;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc &&
        segLength >= 7
      ) {
        const height = data.readUInt16BE(offset + 3);
        const width = data.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          return { format: "JPEG", mime: "image/jpeg", suffix: "jpg", width, height };
        }
      }
      offset += segLength;
    }
  }

  throw new ProviderError("Image cannot be decoded. Use a valid PNG, JPEG, WebP, GIF or BMP.", {
    status: "rejected",
    code: "InvalidImage",
  });
}

function isMultiFrameGif(data: Buffer): boolean {
  if (data.length < 13) return false;
  let pos = 10;
  const packed = data[10]!;
  if ((packed & 0x80) !== 0) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    pos = 13 + gctSize;
  } else {
    pos = 13;
  }
  let frames = 0;
  while (pos < data.length) {
    const introducer = data[pos]!;
    pos += 1;
    if (introducer === 0x3b) {
      break;
    }
    if (introducer === 0x21) {
      if (pos >= data.length) break;
      pos += 1; // extension label
      while (pos < data.length) {
        const subLen = data[pos]!;
        pos += 1;
        if (subLen === 0) break;
        pos += subLen;
      }
      continue;
    }
    if (introducer === 0x2c) {
      frames += 1;
      if (frames > 1) return true;
      if (pos + 9 > data.length) break;
      const localPacked = data[pos + 8]!;
      pos += 9;
      if ((localPacked & 0x80) !== 0) {
        pos += 3 * (1 << ((localPacked & 0x07) + 1));
      }
      if (pos >= data.length) break;
      pos += 1; // LZW minimum code size
      while (pos < data.length) {
        const subLen = data[pos]!;
        pos += 1;
        if (subLen === 0) break;
        pos += subLen;
      }
      continue;
    }
    break;
  }
  return false;
}

function isMultiFrameWebp(data: Buffer): boolean {
  if (data.length < 30 || data.subarray(12, 16).toString("ascii") !== "VP8X") {
    return false;
  }
  if ((data[20]! & 0x02) === 0) {
    return false;
  }
  let offset = 12;
  let frames = 0;
  while (offset + 8 <= data.length) {
    const chunkId = data.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = data.readUInt32LE(offset + 4);
    if (chunkId === "ANMF") {
      frames += 1;
      if (frames > 1) return true;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return false;
}

function hasAlphaMetadataOrPixels(
  format: SupportedImageFormat,
  rawData: Buffer,
  rgbaPixels: Uint8Array,
): boolean {
  if (format === "PNG" && rawData.length >= 26) {
    const colorType = rawData[25];
    if (colorType === 4 || colorType === 6) {
      return true;
    }
  }
  for (let i = 3; i < rgbaPixels.length; i += 4) {
    if (rgbaPixels[i]! < 255) {
      return true;
    }
  }
  return false;
}

function fitDimensions(width: number, height: number, maxEdge: number): [number, number] {
  if (width <= maxEdge && height <= maxEdge) {
    return [width, height];
  }
  const scale = Math.min(maxEdge / width, maxEdge / height);
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
}

function resizeIfNeeded(
  photon: PhotonModule,
  source: PhotonImageType,
  targetW: number,
  targetH: number,
): PhotonImageType {
  if (source.get_width() === targetW && source.get_height() === targetH) {
    return source;
  }
  return photon.resize(source, targetW, targetH, photon.SamplingFilter.Lanczos3);
}

export interface ProcessedImage {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
  hint: string;
}

export function processImage(filePath: string, token?: CancellationToken | null): ProcessedImage {
  checkCancelled(token);
  const fd = fs.openSync(filePath, "r");
  let data: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > MAX_SOURCE_BYTES) {
      throw new ProviderError("Image exceeds the 20 MiB source limit.", {
        status: "rejected",
        code: "ImageTooLarge",
      });
    }
    data = Buffer.allocUnsafe(stat.size);
    const bytesRead = fs.readSync(fd, data, 0, stat.size, 0);
    data = data.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  checkCancelled(token);

  if (data.length === 0) {
    throw new ProviderError("Image cannot be decoded. Use a valid PNG, JPEG, WebP, GIF or BMP.", {
      status: "rejected",
      code: "InvalidImage",
    });
  }

  const signature = detectImageSignature(data);
  if (!signature) {
    throw new ProviderError("Use PNG, JPEG, WebP, GIF or BMP.", {
      status: "rejected",
      code: "UnsupportedImage",
    });
  }

  const header = parseImageHeader(data);
  if (header.width * header.height > MAX_IMAGE_PIXELS) {
    throw new ProviderError("Image exceeds the 40 million pixel limit.", {
      status: "rejected",
      code: "ImageTooLarge",
    });
  }

  const firstFrame =
    (signature === "GIF" && isMultiFrameGif(data)) ||
    (signature === "WEBP" && isMultiFrameWebp(data));

  const photon = loadPhotonSync();
  let decoded: PhotonImageType | null = null;
  let oriented: PhotonImageType | null = null;
  let baseThumbnail: PhotonImageType | null = null;

  try {
    try {
      decoded = photon.PhotonImage.new_from_byteslice(data);
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError) {
        resetPhotonCache();
      }
      throw new ProviderError("Image cannot be decoded. Use a valid PNG, JPEG, WebP, GIF or BMP.", {
        status: "rejected",
        code: "InvalidImage",
      });
    }

    const rawWidth = decoded.get_width();
    const rawHeight = decoded.get_height();
    if (rawWidth <= 0 || rawHeight <= 0) {
      throw new ProviderError("Image cannot be decoded. Use a valid PNG, JPEG, WebP, GIF or BMP.", {
        status: "rejected",
        code: "InvalidImage",
      });
    }
    if (rawWidth * rawHeight > MAX_IMAGE_PIXELS) {
      throw new ProviderError("Image exceeds the 40 million pixel limit.", {
        status: "rejected",
        code: "ImageTooLarge",
      });
    }

    const exifResult = applyExifOrientation(photon, decoded, data);
    oriented = exifResult.image;
    if (oriented !== decoded) {
      decoded.free();
      decoded = null;
    } else {
      decoded = null;
    }

    const orientedWidth = oriented.get_width();
    const orientedHeight = oriented.get_height();
    const transparent = hasAlphaMetadataOrPixels(signature, data, oriented.get_raw_pixels());

    checkCancelled(token);
    const [thumbW, thumbH] = fitDimensions(orientedWidth, orientedHeight, MAX_IMAGE_EDGE);
    baseThumbnail = resizeIfNeeded(photon, oriented, thumbW, thumbH);

    const baseHints: string[] = [];
    if (firstFrame) {
      baseHints.push("First frame only.");
    }
    if (exifResult.orientation !== 1) {
      baseHints.push("EXIF orientation corrected.");
    }
    if (thumbW !== rawWidth || thumbH !== rawHeight) {
      baseHints.push(`Original ${rawWidth}x${rawHeight}; sent ${thumbW}x${thumbH}.`);
    }

    for (const [edge, quality] of ENCODE_STEPS) {
      checkCancelled(token);
      const [stepW, stepH] = fitDimensions(thumbW, thumbH, edge);
      const candidate = resizeIfNeeded(photon, baseThumbnail, stepW, stepH);
      try {
        const usePng = transparent || (signature !== "JPEG" && edge === 2000);
        const encodedBytes = usePng ? candidate.get_bytes() : candidate.get_bytes_jpeg(quality);
        const payload = Buffer.from(encodedBytes);
        if (payload.length <= MAX_IMAGE_BYTES) {
          const hints = [...baseHints];
          if (edge !== 2000) {
            hints.push(`Reduced to ${stepW}x${stepH} to fit the image limit.`);
          }
          checkCancelled(token);
          return {
            data: payload,
            mime: usePng ? "image/png" : "image/jpeg",
            width: stepW,
            height: stepH,
            hint: hints.join(" "),
          };
        }
      } finally {
        if (candidate !== baseThumbnail) {
          candidate.free();
        }
      }
    }

    throw new ProviderError("Image could not fit the 3 MiB output limit. Use a smaller image.", {
      status: "rejected",
      code: "ImageTooLarge",
    });
  } finally {
    if (baseThumbnail && baseThumbnail !== oriented) {
      baseThumbnail.free();
    }
    if (oriented) {
      oriented.free();
    }
    if (decoded) {
      decoded.free();
    }
  }
}

export async function processImageAsync(
  filePath: string,
  token?: CancellationToken | null,
): Promise<ProcessedImage> {
  checkCancelled(token);
  const workerUrl = new URL(
    import.meta.url.endsWith(".ts") ? "./image-resize-worker.ts" : "./image-resize-worker.js",
    import.meta.url,
  );

  let worker: Worker;
  try {
    worker = new Worker(workerUrl);
  } catch {
    return processImage(filePath, token);
  }

  return await new Promise<ProcessedImage>((resolve, reject) => {
    let settled = false;
    const unsubscribe = token
      ? token.onCancel(() => {
          if (settled) return;
          settled = true;
          void worker.terminate().catch(() => undefined);
          reject(new CancelledError(token.reason || "Image operation cancelled"));
        })
      : () => {};

    const cleanup = () => {
      unsubscribe();
      void worker.terminate().catch(() => undefined);
    };

    worker.on("message", (msg: unknown) => {
      if (
        !msg ||
        typeof msg !== "object" ||
        (msg as { type?: unknown }).type !== IMAGE_WORKER_RESPONSE_TYPE
      ) {
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      const response = msg as ImageWorkerResponse;
      if (!response.ok) {
        if (response.code) {
          reject(
            new ProviderError(response.message, {
              status: response.status,
              code: response.code,
              errorType: response.errorType,
            }),
          );
        } else {
          reject(new Error(response.message));
        }
        return;
      }
      resolve({
        data: Buffer.from(response.data),
        mime: response.mime,
        width: response.width,
        height: response.height,
        hint: response.hint,
      });
    });

    worker.once("error", err => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(processImage(filePath, token));
      } catch (fallbackErr) {
        reject(fallbackErr ?? err);
      }
    });

    worker.once("exit", code => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Image worker exited unexpectedly with code ${code}`));
    });

    worker.postMessage({ filePath });
  });
}

const UPLOAD_FAST_RE = /uploads\//i;

export function uploadReferences(content: string): string[] {
  if (!UPLOAD_FAST_RE.test(content)) {
    return [];
  }
  const seen = new Set<string>();
  const matches = content.matchAll(UPLOAD_REFERENCE_RE);
  for (const match of matches) {
    if (match[1]) {
      seen.add(match[1]);
    }
  }
  return Array.from(seen);
}

export function resolveUploadPath(workspaceRoot: string | null | undefined, relPath: string): string | null {
  if (!workspaceRoot || !relPath) {
    return null;
  }
  const normalizedRel = relPath.replace(/\\/g, "/");
  if (normalizedRel.startsWith("/")) {
    return null;
  }
  const parts = normalizedRel.split("/");
  if (parts.length === 0 || parts[0] !== "uploads" || parts.some(p => p === "" || p === "." || p === "..")) {
    return null;
  }
  try {
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedCandidate = path.resolve(resolvedRoot, ...parts);
    const relToRoot = path.relative(resolvedRoot, resolvedCandidate);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      return null;
    }
    const realRoot = fs.realpathSync(resolvedRoot);
    const realCandidate = fs.realpathSync(resolvedCandidate);
    const realRel = path.relative(realRoot, realCandidate);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      return null;
    }
    return resolvedCandidate;
  } catch {
    return null;
  }
}

export function uploadPaths(text: string, workspaceRoot: string | null | undefined): string[] {
  const paths: string[] = [];
  for (const relative of uploadReferences(text)) {
    const resolved = resolveUploadPath(workspaceRoot, relative);
    let isFile = false;
    try {
      isFile = Boolean(resolved && fs.statSync(resolved).isFile());
    } catch {
      isFile = false;
    }
    if (!resolved || !isFile) {
      throw new Error(`Image reference is missing or outside the workspace: ${relative}`);
    }
    paths.push(resolved);
  }
  return paths;
}

export function attachmentPath(sessionBase: string, relative: string): string {
  if (!ATTACHMENT_PATH_RE.test(relative)) {
    throw new ProviderError("Invalid session image reference.", {
      status: "rejected",
      code: "InvalidAttachment",
    });
  }
  const base = path.resolve(sessionBase);
  const resolved = path.resolve(base, relative);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel) || path.dirname(resolved) !== path.join(base, "attachments")) {
    throw new ProviderError("Image reference escapes this session.", {
      status: "rejected",
      code: "InvalidAttachment",
    });
  }
  return resolved;
}

const LOADED_IMAGE_CACHE = new Map<string, [string, Buffer]>();

export function loadImage(sessionBase: string, attachment: ImageAttachment): Buffer {
  try {
    const filePath = attachmentPath(sessionBase, attachment.path);
    const stat = fs.statSync(filePath);
    if (stat.size <= 0 || stat.size > MAX_IMAGE_BYTES || stat.size !== attachment.size_bytes) {
      throw new Error("size mismatch");
    }
    const sig = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}:${attachment.mime_type}:${attachment.width}:${attachment.height}`;
    const cached = LOADED_IMAGE_CACHE.get(filePath);
    if (cached && cached[0] === sig) {
      return cached[1];
    }
    const data = fs.readFileSync(filePath);
    const stem = path.basename(filePath, path.extname(filePath));
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== stem) {
      throw new Error("hash mismatch");
    }
    const header = parseImageHeader(data);
    const clampedWidth = Math.min(header.width, MAX_IMAGE_EDGE);
    const clampedHeight = Math.min(header.height, MAX_IMAGE_EDGE);
    if (
      header.mime !== attachment.mime_type ||
      clampedWidth !== attachment.width ||
      clampedHeight !== attachment.height
    ) {
      throw new Error("image metadata mismatch");
    }
    if (!LOADED_IMAGE_CACHE.has(filePath) && LOADED_IMAGE_CACHE.size >= 16) {
      const oldest = LOADED_IMAGE_CACHE.keys().next().value;
      if (oldest !== undefined) LOADED_IMAGE_CACHE.delete(oldest);
    }
    LOADED_IMAGE_CACHE.set(filePath, [sig, data]);
    return data;
  } catch (err) {
    if (err instanceof ProviderError && err.code === "InvalidAttachment") {
      throw err;
    }
    throw new ProviderError("Session image is missing or damaged. Read the original image again.", {
      status: "rejected",
      code: "AttachmentUnavailable",
    });
  }
}

export function saveImage(
  sessionBase: string,
  processed: ProcessedImage,
  token?: CancellationToken | null,
): ImageAttachment {
  const { data, mime, width, height } = processed;
  const suffix = mime === "image/png" ? "png" : "jpg";
  const hash = createHash("sha256").update(data).digest("hex");
  const reference: ImageAttachment = {
    path: `attachments/${hash}.${suffix}`,
    mime_type: mime,
    width,
    height,
    size_bytes: data.length,
  };
  const targetPath = attachmentPath(sessionBase, reference.path);
  checkCancelled(token);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath)) {
    loadImage(sessionBase, reference);
    return reference;
  }
  const tempPath = path.join(path.dirname(targetPath), `.image-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, data);
    checkCancelled(token);
    fs.renameSync(tempPath, targetPath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup error
    }
  }
  return reference;
}

export function captureImage(
  sessionBase: string,
  filePath: string,
  token?: CancellationToken | null,
): [ImageAttachment, string] {
  checkCancelled(token);
  const source = path.resolve(filePath);
  const attachmentsDir = path.join(path.resolve(sessionBase), "attachments");
  if (path.dirname(source) === attachmentsDir) {
    const relative = `attachments/${path.basename(source)}`;
    attachmentPath(sessionBase, relative);
    try {
      const data = fs.readFileSync(source);
      if (data.length > MAX_IMAGE_BYTES) {
        throw new Error("oversized snapshot");
      }
      const header = parseImageHeader(data);
      const reference: ImageAttachment = {
        path: relative,
        mime_type: header.mime,
        width: Math.min(header.width, MAX_IMAGE_EDGE),
        height: Math.min(header.height, MAX_IMAGE_EDGE),
        size_bytes: data.length,
      };
      loadImage(sessionBase, reference);
      checkCancelled(token);
      return [reference, ""];
    } catch (err) {
      if (err instanceof ProviderError && err.code === "InvalidAttachment") {
        throw err;
      }
      throw new ProviderError("Image snapshot is missing or damaged. Read the original image again.", {
        status: "rejected",
        code: "AttachmentUnavailable",
      });
    }
  }
  const processed = processImage(filePath, token);
  return [saveImage(sessionBase, processed, token), processed.hint];
}

export function hasLegacyImages(messages: readonly Record<string, unknown>[]): boolean {
  return messages.some(
    msg =>
      msg.role === "user" &&
      !("attachments" in msg) &&
      uploadReferences(String(msg.content || "")).length > 0,
  );
}

export function checkImageBudget(attachments: readonly ImageAttachment[]): void {
  const encodedBytes = attachments.reduce(
    (sum, item) => sum + 4 * Math.floor((item.size_bytes + 2) / 3),
    0,
  );
  if (attachments.length > MAX_REQUEST_IMAGES || encodedBytes > MAX_REQUEST_IMAGE_BYTES) {
    throw new ProviderError(
      "Image request exceeds 8 images or 16 MiB encoded data. Compact older history or send fewer images.",
      { status: "rejected", code: "image_budget_exceeded" },
    );
  }
}

export function imageBudgetExceeded(messages: readonly Record<string, unknown>[]): boolean {
  try {
    const allAttachments: ImageAttachment[] = [];
    for (const msg of messages) {
      if (Array.isArray(msg.attachments)) {
        allAttachments.push(...(msg.attachments as ImageAttachment[]));
      }
    }
    checkImageBudget(allAttachments);
    return false;
  } catch {
    return true;
  }
}

export async function prepareImageMessages(
  messages: readonly Record<string, unknown>[],
  options: {
    loadImage: (attachment: ImageAttachment) => Promise<Buffer> | Buffer;
    imageInput: boolean | null;
    compact?: boolean;
  },
): Promise<Record<string, unknown>[]> {
  let omitted = "";
  const allAttachments: ImageAttachment[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.attachments)) {
      allAttachments.push(...(msg.attachments as ImageAttachment[]));
    }
  }
  if (options.imageInput === false) {
    omitted = "Image not sent: the current model does not support images. Select a vision model to inspect it.";
  } else if (options.compact) {
    try {
      checkImageBudget(allAttachments);
    } catch {
      omitted =
        "Images not re-examined for this summary: image request limit exceeded. Use prior observations and references only.";
    }
  } else {
    checkImageBudget(allAttachments);
  }

  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    const copied: Record<string, unknown> = { ...message };
    const attachments = Array.isArray(copied.attachments)
      ? (copied.attachments as ImageAttachment[])
      : [];
    delete copied.attachments;
    if (attachments.length > 0) {
      if (omitted) {
        const sources = attachments.map(item => item.path).join(", ");
        copied.content = `${String(copied.content || "")}\n[${omitted} References: ${sources}]`;
      } else {
        const loadedImages: { mime_type: string; data: Buffer }[] = [];
        for (const item of attachments) {
          loadedImages.push({
            mime_type: item.mime_type,
            data: await options.loadImage(item),
          });
        }
        copied.images = loadedImages;
      }
    } else if (hasLegacyImages([message])) {
      copied.content = `${String(copied.content || "")}\n[${LEGACY_IMAGE_NOTICE}]`;
    }
    result.push(copied);
  }
  return result;
}
