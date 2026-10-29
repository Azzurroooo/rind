import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CancellationToken } from "../domain/cancellation.js";
import { CancelledError, ProviderError } from "../domain/errors.js";
import type { ImageAttachment } from "../domain/models.js";

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

export function checkCancelled(token?: CancellationToken | null): void {
  if (token?.isCancelled) {
    throw new CancelledError(token.reason);
  }
}

export function isImageFile(filePath: string, sample: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_SUFFIXES.has(ext)) {
    return true;
  }
  if (sample.length >= 8 && sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    return true;
  }
  if (sample.length >= 6) {
    const header6 = sample.subarray(0, 6).toString("ascii");
    if (header6 === "GIF87a" || header6 === "GIF89a") {
      return true;
    }
  }
  if (sample.length >= 2 && sample[0] === 0x42 && sample[1] === 0x4d) {
    return true;
  }
  if (
    sample.length >= 12 &&
    sample.subarray(0, 4).toString("ascii") === "RIFF" &&
    sample.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return true;
  }
  return false;
}

export interface DecodedImageHeader {
  format: "PNG" | "JPEG" | "WEBP" | "GIF" | "BMP";
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
        return { format: "GIF", mime: "image/png", suffix: "png", width, height };
      }
    }
  }

  // BMP: "BM" + header
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
      return { format: "BMP", mime: "image/png", suffix: "png", width, height };
    }
  }

  // WEBP: "RIFF" + size + "WEBP" + chunk ("VP8 ", "VP8L", "VP8X")
  if (
    data.length >= 30 &&
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
      const b0 = data[21];
      const b1 = data[22];
      const b2 = data[23];
      const b3 = data[24];
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    } else if (chunkType === "VP8X" && data.length >= 30) {
      width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
      height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
    }
    if (width > 0 && height > 0) {
      return { format: "WEBP", mime: "image/png", suffix: "png", width, height };
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
      const marker = data[offset];
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

export interface ProcessedImage {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
  hint: string;
}

export function processImage(filePath: string, token?: CancellationToken | null): ProcessedImage {
  checkCancelled(token);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SOURCE_BYTES) {
    throw new ProviderError("Image exceeds the 20 MiB source limit.", {
      status: "rejected",
      code: "ImageTooLarge",
    });
  }
  const data = fs.readFileSync(filePath);
  checkCancelled(token);
  const header = parseImageHeader(data);
  if (header.width * header.height > MAX_IMAGE_PIXELS) {
    throw new ProviderError("Image exceeds the 40 million pixel limit.", {
      status: "rejected",
      code: "ImageTooLarge",
    });
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new ProviderError("Image could not fit the 3 MiB output limit. Use a smaller image.", {
      status: "rejected",
      code: "ImageTooLarge",
    });
  }
  const width = Math.min(header.width, MAX_IMAGE_EDGE);
  const height = Math.min(header.height, MAX_IMAGE_EDGE);
  const hint =
    width !== header.width || height !== header.height
      ? `Original ${header.width}x${header.height}; sent ${width}x${height}.`
      : "";
  return {
    data,
    mime: header.mime,
    width,
    height,
    hint,
  };
}

export function uploadReferences(content: string): string[] {
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

export function loadImage(sessionBase: string, attachment: ImageAttachment): Buffer {
  try {
    const filePath = attachmentPath(sessionBase, attachment.path);
    const stat = fs.statSync(filePath);
    if (stat.size <= 0 || stat.size > MAX_IMAGE_BYTES || stat.size !== attachment.size_bytes) {
      throw new Error("size mismatch");
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
        mime_type: path.extname(source) === ".png" ? "image/png" : "image/jpeg",
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
  } else if (options.compact && imageBudgetExceeded(messages)) {
    omitted =
      "Images not re-examined for this summary: image request limit exceeded. Use prior observations and references only.";
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
