import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CancellationToken } from "../../domain/cancellation.js";
import { ProviderError } from "../../domain/errors.js";
import { type ImageAttachment, toolCancelled, toolError, toolOk } from "../../domain/models.js";
import { attachmentPath, isImageFile } from "../images.js";
import { expandUserPath } from "../paths.js";
import { ToolSpec } from "./registry.js";

const MAX_WRITE_FILE_SIZE = 10 * 1024 * 1024;
const DIFF_MAX_LINES = 120;
const DIFF_MAX_CHARS = 12_000;
const READ_MAX_LIMIT = 2000;
const READ_MAX_BYTES = 50 * 1024;
const MAX_LINE_CHARS = 2000;
const RG_TIMEOUT_MS = 30_000;
const GLOB_SCAN_MULTIPLIER = 10;
const GLOB_MIN_SCAN_LIMIT = 10_000;

const SKIP_GLOBS: readonly string[] = [
  ".git",
  "node_modules",
  "venv",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".hg",
  ".svn",
  "site-packages",
].flatMap(folder => ["--glob", `!**/${folder}/**`]);

export class FileMutationQueue {
  private readonly queues = new Map<string, Promise<void>>();

  async run(
    filePath: string,
    operation: () => string | Promise<string>,
    options: {
      toolName: string;
      cancellationToken?: CancellationToken | null;
    },
  ): Promise<string> {
    let real = filePath;
    try {
      real = fs.realpathSync(filePath);
    } catch {
      real = path.resolve(filePath);
    }
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    const prev = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const chained = prev.then(() => current);
    this.queues.set(key, chained);

    try {
      if (options.cancellationToken) {
        if (options.cancellationToken.isCancelled) {
          return toolCancelled(options.toolName, options.cancellationToken.reason);
        }
        let unsub = null as (() => void) | null;
        const cancelWait = new Promise<"cancelled">(resolve => {
          unsub = options.cancellationToken!.onCancel(() => resolve("cancelled"));
        });
        try {
          const outcome = await Promise.race([prev.then(() => "acquired" as const), cancelWait]);
          if (outcome === "cancelled" || options.cancellationToken.isCancelled) {
            return toolCancelled(options.toolName, options.cancellationToken.reason);
          }
        } finally {
          unsub?.();
        }
      } else {
        await prev;
      }
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === chained) {
        this.queues.delete(key);
      }
    }
  }
}

class MutationError extends Error {
  readonly error_type: string;
  readonly meta: Record<string, unknown> | null;

  constructor(message: string, errorType: string, meta: Record<string, unknown> | null = null) {
    super(message);
    this.name = "MutationError";
    this.error_type = errorType;
    this.meta = meta;
  }
}

interface MutationRecord {
  readonly path: string;
  readonly before: Buffer | null;
  readonly after: Buffer;
  readonly mode: number | null;
}

function resolveMutationPath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new MutationError("File path must not be empty.", "InvalidPath");
  }
  try {
    return path.resolve(expandUserPath(rawPath));
  } catch (exc) {
    throw new MutationError(`Invalid file path: ${rawPath}: ${(exc as Error).message}`, "InvalidPath");
  }
}

function readExistingFile(filePath: string): { raw: Buffer; text: string; mode: number } {
  if (!fs.existsSync(filePath)) {
    throw new MutationError(`File does not exist: ${filePath}`, "NotFound");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new MutationError(`Permission denied reading file: ${filePath}`, "PermissionDenied");
    }
    throw new MutationError(`Failed to read file: ${filePath}: ${(exc as Error).message}`, "ReadError");
  }
  if (!stat.isFile()) {
    throw new MutationError(`Path is not a file: ${filePath}`, "NotAFile");
  }
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new MutationError(`Permission denied reading file: ${filePath}`, "PermissionDenied");
    }
    throw new MutationError(`Failed to read file: ${filePath}: ${(exc as Error).message}`, "ReadError");
  }
  if (raw.byteLength > MAX_WRITE_FILE_SIZE) {
    throw new MutationError("File is too large (>10MB) for a full-content edit.", "FileTooLarge");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new MutationError(`File is not valid UTF-8 text: ${filePath}`, "InvalidEncoding");
  }
  return { raw, text, mode: stat.mode & 0o777 };
}

function stageFile(filePath: string, content: Buffer, mode: number | null): string {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MutationError(`Parent path is not a directory: ${dir}`, "NotADirectory");
    }
    throw exc;
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new MutationError(`Parent path is not a directory: ${dir}`, "NotADirectory");
  }
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "w");
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (mode !== null) {
      try {
        fs.chmodSync(tempPath, mode);
      } catch {
        // ignore chmod errors on Windows
      }
    }
    return tempPath;
  } catch (exc) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw exc;
  }
}

function verifyUnchanged(mutation: MutationRecord): void {
  if (mutation.before === null) {
    if (fs.existsSync(mutation.path)) {
      throw new MutationError(`Target was created before the write: ${mutation.path}`, "PreimageMismatch", {
        path: mutation.path,
      });
    }
    return;
  }
  let current: Buffer;
  try {
    current = fs.readFileSync(mutation.path);
  } catch {
    throw new MutationError(`File changed before the write: ${mutation.path}`, "PreimageMismatch", {
      path: mutation.path,
    });
  }
  if (!current.equals(mutation.before)) {
    throw new MutationError(`File changed before the write: ${mutation.path}`, "PreimageMismatch", {
      path: mutation.path,
    });
  }
}

function commitMutation(mutation: MutationRecord): void {
  const staged = stageFile(mutation.path, mutation.after, mutation.mode);
  try {
    verifyUnchanged(mutation);
    fs.renameSync(staged, mutation.path);
  } finally {
    try {
      if (fs.existsSync(staged)) fs.unlinkSync(staged);
    } catch {
      // ignore
    }
  }
}

interface DiffHunkOp {
  readonly type: "equal" | "delete" | "insert";
  readonly oldIndex: number;
  readonly newIndex: number;
  readonly line: string;
}

function computeLineOps(oldLines: readonly string[], newLines: readonly string[]): DiffHunkOp[] {
  // Fast common prefix / suffix trim + Myers/LCS for interior
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const ops: DiffHunkOp[] = [];
  for (let i = 0; i < start; i++) {
    ops.push({ type: "equal", oldIndex: i, newIndex: i, line: oldLines[i] });
  }

  const oldMid = oldLines.slice(start, oldEnd);
  const newMid = newLines.slice(start, newEnd);
  const m = oldMid.length;
  const n = newMid.length;

  if (m === 0) {
    for (let j = 0; j < n; j++) {
      ops.push({ type: "insert", oldIndex: start, newIndex: start + j, line: newMid[j] });
    }
  } else if (n === 0) {
    for (let i = 0; i < m; i++) {
      ops.push({ type: "delete", oldIndex: start + i, newIndex: start, line: oldMid[i] });
    }
  } else if (m * n <= 4_000_000) {
    const dp = new Int32Array((m + 1) * (n + 1));
    const width = n + 1;
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (oldMid[i] === newMid[j]) {
          dp[i * width + j] = dp[(i + 1) * width + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * width + j];
          const right = dp[i * width + (j + 1)];
          dp[i * width + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (oldMid[i] === newMid[j]) {
        ops.push({ type: "equal", oldIndex: start + i, newIndex: start + j, line: oldMid[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        ops.push({ type: "delete", oldIndex: start + i, newIndex: start + j, line: oldMid[i] });
        i++;
      } else {
        ops.push({ type: "insert", oldIndex: start + i, newIndex: start + j, line: newMid[j] });
        j++;
      }
    }
    while (i < m) {
      ops.push({ type: "delete", oldIndex: start + i, newIndex: start + j, line: oldMid[i] });
      i++;
    }
    while (j < n) {
      ops.push({ type: "insert", oldIndex: start + i, newIndex: start + j, line: newMid[j] });
      j++;
    }
  } else {
    for (let i = 0; i < m; i++) {
      ops.push({ type: "delete", oldIndex: start + i, newIndex: start, line: oldMid[i] });
    }
    for (let j = 0; j < n; j++) {
      ops.push({ type: "insert", oldIndex: oldEnd, newIndex: start + j, line: newMid[j] });
    }
  }

  for (let k = 0; k < oldLines.length - oldEnd; k++) {
    ops.push({
      type: "equal",
      oldIndex: oldEnd + k,
      newIndex: newEnd + k,
      line: oldLines[oldEnd + k],
    });
  }
  return ops;
}

function splitLinesNoEnds(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (text.endsWith("\n") || text.endsWith("\r")) {
    lines.pop();
  }
  return lines;
}

function computeDiffMeta(filePath: string, before: string, after: string): {
  added: number;
  removed: number;
  diff: string;
} {
  const oldLines = splitLinesNoEnds(before);
  const newLines = splitLinesNoEnds(after);
  const ops = computeLineOps(oldLines, newLines);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "insert") added++;
    else if (op.type === "delete") removed++;
  }

  // Group non-equal ops with context=3 into unified diff hunks
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "equal") {
      changeIndices.push(i);
    }
  }
  if (changeIndices.length === 0) {
    return { added: 0, removed: 0, diff: "" };
  }

  const context = 3;
  const groups: Array<[number, number]> = [];
  for (const idx of changeIndices) {
    const groupStart = Math.max(0, idx - context);
    const groupEnd = Math.min(ops.length - 1, idx + context);
    if (groups.length > 0 && groupStart <= groups[groups.length - 1][1] + 1) {
      groups[groups.length - 1][1] = Math.max(groups[groups.length - 1][1], groupEnd);
    } else {
      groups.push([groupStart, groupEnd]);
    }
  }

  const rawDiffLines: string[] = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const [gStart, gEnd] of groups) {
    const slice = ops.slice(gStart, gEnd + 1);
    const oldCount = slice.filter(o => o.type !== "insert").length;
    const newCount = slice.filter(o => o.type !== "delete").length;
    const firstOld = slice[0].oldIndex + (oldCount > 0 ? 1 : 0);
    const firstNew = slice[0].newIndex + (newCount > 0 ? 1 : 0);
    const oldRange = oldCount === 1 ? `${firstOld}` : `${firstOld},${oldCount}`;
    const newRange = newCount === 1 ? `${firstNew}` : `${firstNew},${newCount}`;
    rawDiffLines.push(`@@ -${oldRange} +${newRange} @@`);
    for (const op of slice) {
      const prefix = op.type === "equal" ? " " : op.type === "delete" ? "-" : "+";
      rawDiffLines.push(`${prefix}${op.line}`);
    }
  }

  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const line of rawDiffLines) {
    if (lines.length >= DIFF_MAX_LINES || chars + line.length + 1 > DIFF_MAX_CHARS) {
      truncated = true;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  let result = lines.join("\n");
  if (truncated) {
    const marker = "\n... diff truncated ...";
    result = result.slice(0, DIFF_MAX_CHARS - marker.length) + marker;
  }
  return { added, removed, diff: result };
}

function mutationSuccess(
  toolName: string,
  mutation: MutationRecord,
  options?: { startLine?: number | null },
): string {
  const before = mutation.before ? mutation.before.toString("utf8") : "";
  const after = mutation.after.toString("utf8");
  const { added, removed, diff } = computeDiffMeta(mutation.path, before, after);
  const fileMeta: Record<string, unknown> = {
    path: mutation.path,
    added_lines: added,
    removed_lines: removed,
    diff,
  };
  if (toolName === "write_file") {
    fileMeta.created = mutation.before === null;
    fileMeta.size_bytes = mutation.after.byteLength;
  }
  if (options?.startLine !== undefined && options.startLine !== null) {
    fileMeta.start_line = options.startLine;
  }
  return toolOk(toolName, "Successfully modified 1 file.", { files: [fileMeta] });
}

function mutationFailure(toolName: string, exc: unknown, fallbackType: string): string {
  if (exc instanceof MutationError) {
    return toolError(toolName, exc.message, exc.error_type, exc.meta);
  }
  const code = (exc as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return toolError(toolName, `Permission denied during file operation: ${(exc as Error).message}`, "PermissionDenied");
  }
  return toolError(toolName, `File operation failed: ${(exc as Error).message}`, fallbackType);
}

export function writeFile(rawPath: string, content: string): string {
  try {
    if (typeof content !== "string") {
      throw new MutationError("content must be a string.", "InvalidContent");
    }
    const resolved = resolveMutationPath(rawPath);
    let before: Buffer | null = null;
    let mode: number | null = null;
    if (fs.existsSync(resolved)) {
      const existing = readExistingFile(resolved);
      before = existing.raw;
      mode = existing.mode;
    }
    const mutation: MutationRecord = {
      path: resolved,
      before,
      after: Buffer.from(content, "utf8"),
      mode,
    };
    commitMutation(mutation);
    return mutationSuccess("write_file", mutation);
  } catch (exc) {
    return mutationFailure("write_file", exc, "WriteError");
  }
}

export function editFile(rawPath: string, oldStr: string, newStr: string): string {
  try {
    if (typeof oldStr !== "string" || !oldStr || typeof newStr !== "string") {
      throw new MutationError(
        "old_str must be a non-empty string and new_str must be a string.",
        "InvalidContent",
      );
    }
    const resolved = resolveMutationPath(rawPath);
    const { raw: before, text, mode } = readExistingFile(resolved);
    const start = text.indexOf(oldStr);
    if (start < 0) {
      throw new MutationError("The specified old_str was not found in the file.", "OldStrNotFound");
    }
    if (start !== text.lastIndexOf(oldStr)) {
      throw new MutationError(
        "Found multiple matches for old_str; provide unique context.",
        "OldStrNotUnique",
      );
    }
    const updatedText = text.slice(0, start) + newStr + text.slice(start + oldStr.length);
    const mutation: MutationRecord = {
      path: resolved,
      before,
      after: Buffer.from(updatedText, "utf8"),
      mode,
    };
    commitMutation(mutation);
    let startLine = 1;
    for (let i = 0; i < start; i++) {
      if (text.charCodeAt(i) === 10) startLine++;
    }
    return mutationSuccess("edit_file", mutation, { startLine });
  } catch (exc) {
    return mutationFailure("edit_file", exc, "EditError");
  }
}

function checkCancelled(toolName: string, token?: CancellationToken | null): string | null {
  if (token?.isCancelled) {
    return toolCancelled(toolName, token.reason);
  }
  return null;
}

function existingPath(toolName: string, rawPath: string): [string, fs.Stats | null, string | null] {
  try {
    const resolved = path.resolve(expandUserPath(rawPath));
    const stat = fs.statSync(resolved);
    return [resolved, stat, null];
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return [rawPath, null, toolError(toolName, `Path does not exist: ${rawPath}`, "NotFound")];
    }
    if (code === "EACCES" || code === "EPERM") {
      return [rawPath, null, toolError(toolName, `Permission denied for path: ${rawPath}`, "PermissionDenied")];
    }
    return [rawPath, null, toolError(toolName, `Cannot access path: ${rawPath}: ${(exc as Error).message}`, "PathAccessError")];
  }
}

function looksBinary(sample: Buffer): boolean {
  if (sample.includes(0)) {
    return true;
  }
  if (sample.length === 0) {
    return false;
  }
  let controls = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) {
      controls++;
    }
  }
  return controls / sample.length > 0.1;
}

function parseStrictInt(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const n = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function readFile(
  rawPath: string,
  offset: unknown = 1,
  limit: unknown = 1000,
  cancellationToken?: CancellationToken | null,
  options?: {
    captureImage?: ((path: string, token?: CancellationToken | null) => [ImageAttachment, string | null]) | null;
    imageInput?: boolean | null;
  },
): string {
  const cancelled = checkCancelled("read_file", cancellationToken);
  if (cancelled) return cancelled;

  const [filePath, stat, err] = existingPath("read_file", rawPath);
  if (err) return err;
  if (!stat!.isFile()) {
    return toolError("read_file", `Path is not a file: ${rawPath}`, "NotAFile");
  }

  const parsedOffset = parseStrictInt(offset ?? 1);
  if (parsedOffset === null) {
    return toolError("read_file", "offset must be an integer.", "InvalidOffset");
  }
  const parsedLimit = parseStrictInt(limit ?? 1000);
  if (parsedLimit === null) {
    return toolError("read_file", "limit must be an integer.", "InvalidLimit");
  }
  if (parsedOffset < 1) {
    return toolError("read_file", "offset must be >= 1.", "InvalidOffset");
  }
  if (parsedLimit < 1) {
    return toolError("read_file", "limit must be >= 1.", "InvalidLimit");
  }

  try {
    const fd = fs.openSync(filePath, "r");
    let sample: Buffer;
    try {
      sample = Buffer.alloc(Math.min(8192, stat!.size));
      const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
      sample = sample.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }

    if (isImageFile(filePath, sample)) {
      if (parsedOffset !== 1 || parsedLimit !== 1000) {
        return toolError(
          "read_file",
          "Image reads do not accept line pagination. Omit offset and limit.",
          "InvalidImagePagination",
        );
      }
      if (options?.imageInput === false) {
        return toolError(
          "read_file",
          "The current model does not support images. Select a vision model.",
          "ImageInputUnsupported",
        );
      }
      if (!options?.captureImage) {
        return toolError("read_file", "Image reading requires an active session.", "ImageSessionRequired");
      }
      try {
        const [attachment, note] = options.captureImage(filePath, cancellationToken);
        const description = `Read image: ${path.basename(filePath)} · ${attachment.width}x${attachment.height} · ${attachment.mime_type}`;
        return toolOk("read_file", description + (note ? `\n${note}` : ""), undefined, {
          attachments: [attachment],
        });
      } catch (exc) {
        if (exc instanceof ProviderError) {
          return toolError("read_file", exc.message, exc.code);
        }
        throw exc;
      }
    }

    if (looksBinary(sample)) {
      return toolError("read_file", `Binary file cannot be read as text: ${rawPath}`, "BinaryFile");
    }

    const rawBytes = fs.readFileSync(filePath);
    let fullText: string;
    try {
      fullText = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    } catch {
      return toolError("read_file", `File is not valid UTF-8 text: ${rawPath}`, "InvalidEncoding");
    }

    const effectiveLimit = Math.min(parsedLimit, READ_MAX_LIMIT);
    const endLine = parsedOffset + effectiveLimit - 1;
    const selected: Array<[number, string]> = [];
    let hasMore = false;

    const rawLines = fullText.length === 0 ? [] : fullText.split(/\r\n|\n|\r/);
    if (fullText.endsWith("\n") || fullText.endsWith("\r")) {
      rawLines.pop();
    }
    const lastLine = rawLines.length;
    let outputBytes = Buffer.byteLength(`Showing lines ${parsedOffset} to 0:`, "utf8");

    for (let idx = 0; idx < rawLines.length; idx++) {
      const lineNo = idx + 1;
      if (lineNo < parsedOffset) {
        if (lineNo % 1000 === 0) {
          const c = checkCancelled("read_file", cancellationToken);
          if (c) return c;
        }
        continue;
      }
      if (lineNo > endLine) {
        hasMore = true;
        break;
      }
      const rawLine = rawLines[idx];
      const formatted = `${String(lineNo).padStart(4, " ")} | ${rawLine}\n`;
      const lineBytes = Buffer.byteLength(formatted, "utf8");
      if (outputBytes + lineBytes > READ_MAX_BYTES) {
        if (selected.length > 0) {
          hasMore = true;
          break;
        }
        return toolError(
          "read_file",
          `Line ${lineNo} exceeds the read budget and was not displayed. Use bash/Python to read this line in character slices, then resume at offset ${lineNo + 1}.`,
          "LineTooLong",
          { path: filePath, offset: lineNo },
        );
      }
      selected.push([lineNo, rawLine]);
      outputBytes += lineBytes;
      if (lineNo % 1000 === 0) {
        const c = checkCancelled("read_file", cancellationToken);
        if (c) return c;
      }
    }

    if (parsedOffset > lastLine && !(parsedOffset === 1 && lastLine === 0)) {
      return toolError(
        "read_file",
        `Offset ${parsedOffset} is beyond the end of the file (${lastLine} lines).`,
        "OffsetOutOfRange",
        { path: filePath, offset: parsedOffset },
      );
    }

    const shownEnd = selected.length > 0 ? selected[selected.length - 1][0] : 0;
    const output = [
      `Showing lines ${parsedOffset} to ${shownEnd}:`,
      ...selected.map(([lineNo, text]) => `${String(lineNo).padStart(4, " ")} | ${text}`),
    ];
    return toolOk("read_file", output.join("\n"), {
      path: filePath,
      offset: parsedOffset,
      limit: effectiveLimit,
      truncated: hasMore,
      line_truncated: false,
      next_offset: hasMore ? shownEnd + 1 : null,
      encoding: "utf-8",
    });
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") {
      return toolError("read_file", `Permission denied reading file: ${rawPath}`, "PermissionDenied");
    }
    return toolError("read_file", `Failed to read file: ${(exc as Error).message}`, "ReadError");
  }
}

function isFilesystemRoot(dirPath: string): boolean {
  const resolved = path.resolve(dirPath);
  return resolved === path.dirname(resolved);
}

function relativePosixPath(filePath: string, root: string, rootIsDir: boolean): string {
  const base = rootIsDir ? root : path.dirname(root);
  const rel = path.relative(base, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return filePath.replace(/\\/g, "/");
  }
  return rel.replace(/\\/g, "/");
}

function clipText(text: string, limit: number = MAX_LINE_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...(truncated:${text.length})`;
}

function rgErrorType(stderr: string, fallback: string): string {
  const lowered = stderr.toLowerCase();
  if (lowered.includes("permission") || lowered.includes("access is denied")) {
    return "PermissionDenied";
  }
  if (lowered.includes("regex") || lowered.includes("pattern") || lowered.includes("glob")) {
    return "InvalidPattern";
  }
  return fallback;
}

export async function globFiles(
  pattern: string,
  rawPath = ".",
  maxResults: unknown = 1000,
  cancellationToken?: CancellationToken | null,
): Promise<string> {
  const cancelled = checkCancelled("glob", cancellationToken);
  if (cancelled) return cancelled;

  const [searchPath, stat, err] = existingPath("glob", rawPath);
  if (err) return err;
  if (!stat!.isDirectory()) {
    return toolError("glob", `Path is not a directory: ${rawPath}`, "NotADirectory");
  }
  if (isFilesystemRoot(searchPath)) {
    return toolError(
      "glob",
      `Cannot search the filesystem root (${searchPath}); specify a workspace or project directory.`,
      "InvalidPath",
    );
  }
  if (typeof pattern !== "string" || !pattern) {
    return toolError("glob", "pattern must not be empty.", "InvalidPattern");
  }
  const parsedMax = parseStrictInt(maxResults ?? 1000);
  if (parsedMax === null) {
    return toolError("glob", "max_results must be an integer.", "InvalidMaxResults");
  }
  if (parsedMax < 1) {
    return toolError("glob", "max_results must be >= 1.", "InvalidMaxResults");
  }

  const scanLimit = Math.max(parsedMax * GLOB_SCAN_MULTIPLIER, GLOB_MIN_SCAN_LIMIT);
  const args = ["--files", "--hidden", "--glob", pattern, ...SKIP_GLOBS, "."];

  return await new Promise<string>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("rg", args, {
        cwd: searchPath,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(toolError("glob", "rg executable not found.", "RgUnavailable"));
      return;
    }

    const paths: string[] = [];
    let stdoutBuf = "";
    let stderrBuf = "";
    let scanTruncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (output: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub?.();
      resolve(output);
    };

    const killChild = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, RG_TIMEOUT_MS);

    const unsub = cancellationToken ? cancellationToken.onCancel(killChild) : null;

    child.on("error", (spawnErr: NodeJS.ErrnoException) => {
      if (spawnErr.code === "ENOENT") {
        finish(toolError("glob", "rg executable not found.", "RgUnavailable"));
      } else {
        finish(toolError("glob", `File lookup failed: ${spawnErr.message}`, "GlobError"));
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf = (stderrBuf + chunk).slice(-4096);
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (scanTruncated) return;
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        if (paths.length >= scanLimit) {
          scanTruncated = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
          break;
        }
        paths.push(path.resolve(searchPath, line));
      }
    });

    child.on("close", code => {
      const c = checkCancelled("glob", cancellationToken);
      if (c) {
        finish(c);
        return;
      }
      if (timedOut) {
        finish(
          toolError(
            "glob",
            `File lookup timed out after ${Math.trunc(RG_TIMEOUT_MS / 1000)}s; narrow the path or pattern.`,
            "Timeout",
          ),
        );
        return;
      }
      if (!scanTruncated && stdoutBuf.trim()) {
        const line = stdoutBuf.replace(/\r?\n$/, "");
        if (line && paths.length < scanLimit) {
          paths.push(path.resolve(searchPath, line));
        }
      }
      if (code !== 0 && code !== 1 && !scanTruncated) {
        finish(
          toolError(
            "glob",
            stderrBuf.trim() || "rg file lookup failed.",
            rgErrorType(stderrBuf, "GlobError"),
          ),
        );
        return;
      }
      paths.sort((a, b) => {
        const ka = a.replace(/\\/g, "/").toLowerCase();
        const kb = b.replace(/\\/g, "/").toLowerCase();
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      const results: Array<{ path: string; size_bytes: number }> = [];
      for (const filePath of paths) {
        if (results.length >= parsedMax) break;
        try {
          const st = fs.statSync(filePath);
          results.push({
            path: relativePosixPath(filePath, searchPath, true),
            size_bytes: st.size,
          });
        } catch {
          continue;
        }
      }
      finish(
        toolOk("glob", results, {
          path: searchPath,
          pattern,
          count: results.length,
          max_results: parsedMax,
          truncated: scanTruncated || paths.length > parsedMax,
        }),
      );
    });
  });
}

export async function grepFiles(
  pattern: string,
  rawPath = ".",
  fileGlob = "**/*",
  maxResults: unknown = 1000,
  cancellationToken?: CancellationToken | null,
): Promise<string> {
  const cancelled = checkCancelled("grep", cancellationToken);
  if (cancelled) return cancelled;

  const [searchPath, stat, err] = existingPath("grep", rawPath);
  if (err) return err;
  if (isFilesystemRoot(searchPath)) {
    return toolError(
      "grep",
      `Cannot search the filesystem root (${searchPath}); specify a workspace or project directory.`,
      "InvalidPath",
    );
  }
  if (typeof pattern !== "string" || !pattern) {
    return toolError("grep", "pattern must not be empty.", "InvalidPattern");
  }
  if (typeof fileGlob !== "string" || !fileGlob) {
    return toolError("grep", "glob must not be empty.", "InvalidPattern");
  }
  const parsedMax = parseStrictInt(maxResults ?? 1000);
  if (parsedMax === null) {
    return toolError("grep", "max_results must be an integer.", "InvalidMaxResults");
  }
  if (parsedMax < 1) {
    return toolError("grep", "max_results must be >= 1.", "InvalidMaxResults");
  }

  const rootIsDir = stat!.isDirectory();
  const args = [
    "--json",
    "--color",
    "never",
    "--glob",
    fileGlob,
    ...SKIP_GLOBS,
    "--",
    pattern,
    searchPath,
  ];

  return await new Promise<string>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("rg", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(toolError("grep", "rg executable not found.", "RgUnavailable"));
      return;
    }

    const results: Array<{ file: string; line: number; text: string }> = [];
    let stdoutBuf = "";
    let stderrBuf = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (output: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub?.();
      resolve(output);
    };

    const killChild = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, RG_TIMEOUT_MS);

    const unsub = cancellationToken ? cancellationToken.onCancel(killChild) : null;

    child.on("error", (spawnErr: NodeJS.ErrnoException) => {
      if (spawnErr.code === "ENOENT") {
        finish(toolError("grep", "rg executable not found.", "RgUnavailable"));
      } else {
        finish(toolError("grep", `Failed to start rg: ${spawnErr.message}`, "GrepError"));
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf = (stderrBuf + chunk).slice(-4096);
    });

    const handleLine = (rawLine: string) => {
      if (truncated || !rawLine.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type !== "match") return;
      if (results.length >= parsedMax) {
        truncated = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        return;
      }
      const data = (event.data as Record<string, unknown>) ?? {};
      const pathData = (data.path as Record<string, unknown>) ?? {};
      const rawMatchPath = String(pathData.text ?? "");
      const lineData = (data.lines as Record<string, unknown>) ?? {};
      const candidate = path.isAbsolute(rawMatchPath)
        ? rawMatchPath
        : path.resolve(rootIsDir ? searchPath : path.dirname(searchPath), rawMatchPath);
      results.push({
        file: relativePosixPath(candidate, searchPath, rootIsDir),
        line: Number(data.line_number ?? 0) || 0,
        text: clipText(String(lineData.text ?? "").replace(/[\r\n]+$/, "")),
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (truncated) return;
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        handleLine(line);
        if (truncated) break;
      }
    });

    child.on("close", code => {
      const c = checkCancelled("grep", cancellationToken);
      if (c) {
        finish(c);
        return;
      }
      if (timedOut) {
        finish(
          toolError(
            "grep",
            `Search timed out after ${Math.trunc(RG_TIMEOUT_MS / 1000)}s; narrow the path or pattern.`,
            "Timeout",
          ),
        );
        return;
      }
      if (!truncated && stdoutBuf.trim()) {
        handleLine(stdoutBuf);
      }
      if (code !== 0 && code !== 1 && !truncated) {
        finish(
          toolError(
            "grep",
            stderrBuf.trim() || "rg search failed.",
            rgErrorType(stderrBuf, "GrepError"),
          ),
        );
        return;
      }
      finish(
        toolOk("grep", results, {
          pattern,
          path: searchPath,
          glob: fileGlob,
          count: results.length,
          max_results: parsedMax,
          truncated,
        }),
      );
    });
  });
}

function normalizePathArguments(args: Record<string, unknown>): Record<string, unknown> {
  if ("file_path" in args) {
    const legacy = args.file_path;
    delete args.file_path;
    if ("path" in args && args.path !== legacy) {
      throw new Error("Conflicting path and file_path; supply only path.");
    }
    args.path = legacy;
  }
  return args;
}

function normalizeMutationArguments(args: Record<string, unknown>): Record<string, unknown> {
  delete args.expected_sha256;
  return normalizePathArguments(args);
}

function isRelativeTo(candidate: string, parent: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function buildFileToolSpecs(options?: {
  workspaceRoot?: string | null;
  allowedRoots?: Iterable<string> | null;
  sharedRoot?: string | null;
  sessionOutputRoot?: string | null;
  mutationQueue?: FileMutationQueue | null;
  captureImage?: ((path: string, token?: CancellationToken | null) => [ImageAttachment, string | null]) | null;
  imageInput?: () => boolean | null;
  sessionBaseProvider?: (() => string | null) | null;
}): ToolSpec[] {
  const mutationQueue = options?.mutationQueue ?? new FileMutationQueue();
  const root = path.resolve(expandUserPath(options?.workspaceRoot || process.cwd()));
  const allowed = options?.allowedRoots
    ? Array.from(options.allowedRoots, p => path.resolve(expandUserPath(p)))
    : [];
  const shared = options?.sharedRoot ? path.resolve(expandUserPath(options.sharedRoot)) : null;
  const sessionOutput = options?.sessionOutputRoot
    ? path.resolve(expandUserPath(options.sessionOutputRoot))
    : null;
  const imageInput = options?.imageInput ?? (() => null);

  const resolveScopedPath = (
    toolName: string,
    value: unknown,
    allowSessionOutput = false,
  ): [string | null, string | null] => {
    if (typeof value !== "string" || !value.trim()) {
      return [null, toolError(toolName, "Path is required.", "InvalidPath")];
    }
    const expanded = expandUserPath(value);
    let candidate: string;
    if (!path.isAbsolute(expanded)) {
      const parts = expanded.split(/[\\/]+/);
      if (shared && parts.length > 0 && parts[0].toLowerCase() === "shared") {
        candidate = path.resolve(shared, ...parts.slice(1));
      } else {
        candidate = path.resolve(root, expanded);
      }
    } else {
      candidate = path.resolve(expanded);
    }
    try {
      candidate = fs.realpathSync(candidate);
    } catch {
      // keep resolved candidate when target doesn't exist yet
    }
    if (allowed.length > 0 && !allowed.some(allowedRoot => isRelativeTo(candidate, allowedRoot))) {
      if (allowSessionOutput && sessionOutput && isRelativeTo(candidate, sessionOutput)) {
        return [candidate, null];
      }
      const base = options?.sessionBaseProvider ? options.sessionBaseProvider() : null;
      if (
        allowSessionOutput &&
        base &&
        path.dirname(candidate) === path.join(path.resolve(base), "attachments")
      ) {
        try {
          attachmentPath(base, `attachments/${path.basename(candidate)}`);
        } catch (exc) {
          if (exc instanceof ProviderError) {
            return [null, toolError(toolName, "Invalid image snapshot path.", "InvalidAttachment")];
          }
          throw exc;
        }
        return [candidate, null];
      }
      return [
        null,
        toolError(toolName, `Path is outside this Agent Capsule: ${value}`, "WorkspaceBoundary"),
      ];
    }
    return [candidate, null];
  };

  return [
    new ToolSpec({
      name: "read_file",
      isAsync: false,
      parallel: true,
      normalizeArguments: normalizePathArguments,
      description:
        "Read UTF-8 text or a local image (PNG, JPEG, WebP, GIF, BMP). Images are sent as attachments, resized to at most 2000 pixels per edge; animations use the first frame. Omit offset/limit for images. Text reads return complete lines within a 25 KiB model budget, including next_offset. For LineTooLong, read character slices with bash/Python.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          offset: { type: "integer", description: "First line to read (default 1)", default: 1 },
          limit: {
            type: "integer",
            description:
              "Maximum lines to read (default 1000, maximum 2000; a page is about 50 KiB with a 25 KiB model preview)",
            default: 1000,
          },
        },
        required: ["path"],
      },
      handler: args => {
        const [resolved, err] = resolveScopedPath("read_file", args.path, true);
        if (err) return err;
        return readFile(
          resolved!,
          args.offset ?? 1,
          args.limit ?? 1000,
          args._cancellation_token as CancellationToken | undefined,
          {
            captureImage: options?.captureImage,
            imageInput: imageInput(),
          },
        );
      },
    }),
    new ToolSpec({
      name: "write_file",
      isAsync: true,
      parallel: false,
      normalizeArguments: normalizeMutationArguments,
      description:
        "Atomically create or fully overwrite a UTF-8 text file. Use for new files or complete rewrites.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
      handler: async args => {
        const [resolved, err] = resolveScopedPath("write_file", args.path);
        if (err) return err;
        return await mutationQueue.run(resolved!, () => writeFile(resolved!, args.content as string), {
          toolName: "write_file",
          cancellationToken: args._cancellation_token as CancellationToken | undefined,
        });
      },
    }),
    new ToolSpec({
      name: "edit_file",
      isAsync: true,
      parallel: false,
      normalizeArguments: normalizeMutationArguments,
      description: "Atomically replace one unique, exact text block in the current UTF-8 file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          old_str: {
            type: "string",
            description: "Text block to replace. Include surrounding context to make it unique.",
          },
          new_str: { type: "string", description: "Replacement text block for old_str." },
        },
        required: ["path", "old_str", "new_str"],
      },
      handler: async args => {
        const [resolved, err] = resolveScopedPath("edit_file", args.path);
        if (err) return err;
        return await mutationQueue.run(
          resolved!,
          () => editFile(resolved!, args.old_str as string, args.new_str as string),
          {
            toolName: "edit_file",
            cancellationToken: args._cancellation_token as CancellationToken | undefined,
          },
        );
      },
    }),
    new ToolSpec({
      name: "glob",
      isAsync: true,
      parallel: true,
      normalizeArguments: normalizePathArguments,
      description:
        "Fast glob-pattern file lookup that returns paths and file sizes. Use it to locate candidate files before reading their contents.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern such as **/*.py or src/**/*.ts.",
          },
          path: {
            type: "string",
            description: "Directory to search. Defaults to the current directory.",
            default: ".",
          },
          max_results: {
            type: "integer",
            description: "Maximum number of files returned. Default 1000.",
            default: 1000,
          },
        },
        required: ["pattern"],
      },
      handler: async args => {
        const [resolved, err] = resolveScopedPath("glob", args.path ?? ".");
        if (err) return err;
        return await globFiles(
          args.pattern as string,
          resolved!,
          args.max_results ?? 1000,
          args._cancellation_token as CancellationToken | undefined,
        );
      },
    }),
    new ToolSpec({
      name: "grep",
      isAsync: true,
      parallel: true,
      normalizeArguments: normalizePathArguments,
      description:
        "Search file contents with rg; returns matching files, line numbers, and text. Reports truncation when the result cap is hit.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression to search for (rg syntax)",
          },
          path: {
            type: "string",
            description: "Root directory to search (defaults to the current directory)",
            default: ".",
          },
          glob: {
            type: "string",
            description: "File glob pattern (e.g. **/*.py, src/*.ts). Defaults to **/*.",
            default: "**/*",
          },
          max_results: {
            type: "integer",
            description: "Maximum number of matches returned. Default 1000.",
            default: 1000,
          },
        },
        required: ["pattern"],
      },
      handler: async args => {
        const [resolved, err] = resolveScopedPath("grep", args.path ?? ".");
        if (err) return err;
        return await grepFiles(
          args.pattern as string,
          resolved!,
          (args.glob as string | undefined) ?? "**/*",
          args.max_results ?? 1000,
          args._cancellation_token as CancellationToken | undefined,
        );
      },
    }),
  ];
}
