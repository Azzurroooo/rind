import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_DIRECTORY_ENTRIES = 500;
const MAX_TEXT_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_FILE_BYTES = 6 * 1024 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const FILE_MIME_TYPES: Record<string, string> = {
  ...IMAGE_MIME_TYPES,
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

export interface ProjectFileNode {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export interface ProjectFileListing {
  path: string;
  entries: ProjectFileNode[];
  truncated: boolean;
}

export interface ProjectFilePreview {
  path: string;
  name: string;
  kind: "text" | "image" | "unsupported";
  size: number;
  content?: string;
  dataUrl?: string;
  mimeType?: string;
  truncated?: boolean;
  message?: string;
}

export async function listProjectFiles(
  root: string,
  requestedPath: unknown,
): Promise<ProjectFileListing> {
  const { path, absolutePath } = await resolveProjectPath(root, requestedPath, true);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const visible = entries
    .filter((entry) => entry.name !== ".git")
    .sort(
      (left, right) =>
        Number(right.isDirectory()) - Number(left.isDirectory()) ||
        left.name.localeCompare(right.name),
    );
  return {
    path,
    truncated: visible.length > MAX_DIRECTORY_ENTRIES,
    entries: visible.slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({
      name: entry.name,
      path: path ? `${path}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
    })),
  };
}

export async function previewProjectFile(
  root: string,
  requestedPath: unknown,
): Promise<ProjectFilePreview> {
  const { path, absolutePath } = await resolveProjectPath(root, requestedPath, false);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("Only files can be previewed.");
  const mimeType = IMAGE_MIME_TYPES[extname(absolutePath).toLocaleLowerCase()];
  if (mimeType) return previewImage(path, absolutePath, fileStat.size, mimeType);
  return previewText(path, absolutePath, fileStat.size);
}

async function previewImage(
  path: string,
  absolutePath: string,
  size: number,
  mimeType: string,
): Promise<ProjectFilePreview> {
  if (size > MAX_IMAGE_BYTES) {
    return {
      path,
      name: basename(path),
      kind: "unsupported",
      size,
      message: "Image is larger than 5 MB.",
    };
  }
  const handle = await open(absolutePath, "r");
  try {
    const content = Buffer.alloc(size);
    await handle.read(content, 0, size, 0);
    return {
      path,
      name: basename(path),
      kind: "image",
      size,
      mimeType,
      dataUrl: `data:${mimeType};base64,${content.toString("base64")}`,
    };
  } finally {
    await handle.close();
  }
}

async function previewText(
  path: string,
  absolutePath: string,
  size: number,
): Promise<ProjectFilePreview> {
  const length = Math.min(size, MAX_TEXT_BYTES + 1);
  const handle = await open(absolutePath, "r");
  let content: Buffer;
  try {
    content = Buffer.alloc(length);
    const { bytesRead } = await handle.read(content, 0, length, 0);
    content = content.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (content.includes(0)) {
    return {
      path,
      name: basename(path),
      kind: "unsupported",
      size,
      message: "Binary files cannot be previewed.",
    };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      content.subarray(0, MAX_TEXT_BYTES),
      { stream: content.length > MAX_TEXT_BYTES },
    );
    return {
      path,
      name: basename(path),
      kind: "text",
      size,
      content: text,
      truncated: size > MAX_TEXT_BYTES,
    };
  } catch {
    return {
      path,
      name: basename(path),
      kind: "unsupported",
      size,
      message: "Only UTF-8 text files can be previewed.",
    };
  }
}

async function resolveProjectPath(
  root: string,
  requestedPath: unknown,
  directory: boolean,
): Promise<{ path: string; absolutePath: string }> {
  if (typeof requestedPath !== "string") throw new Error("File path must be a string.");
  const path = normalizeRelativePath(requestedPath);
  const canonicalRoot = await realpath(root);
  const requestedAbsolutePath = resolve(canonicalRoot, path);
  assertWithinRoot(canonicalRoot, requestedAbsolutePath, "File path cannot leave the active project.");
  const absolutePath = await realpath(requestedAbsolutePath);
  assertWithinRoot(canonicalRoot, absolutePath, "File path cannot leave the active project.");
  const fileStat = await stat(absolutePath);
  if (directory && !fileStat.isDirectory()) throw new Error("Path is not a directory.");
  if (!directory && !fileStat.isFile()) throw new Error("Path is not a file.");
  return { path, absolutePath };
}

function normalizeRelativePath(value: string): string {
  const path = value.trim();
  if (isAbsolute(path)) throw new Error("File path must be relative to the active project.");
  if (path.split(/[\\/]+/).some((part) => part === "..")) {
    throw new Error("File path cannot leave the active project.");
  }
  const escapedSep = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return path.replace(/[\\/]+/g, sep).replace(new RegExp(`^${escapedSep}+`), "");
}

function assertWithinRoot(root: string, target: string, message: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(message);
}

async function writeWorkspaceUpload(
  workspace: string,
  params: Record<string, unknown> = {},
): Promise<{ path: string; size: number }> {
  const root = await realpath(workspace);
  const path = String(params.path || "").replaceAll("\\", "/");
  if (isAbsolute(path) || path.includes(":") || path.split("/").includes("..") || path.includes("\0")) {
    throw new Error("Use a relative workspace path.");
  }
  const target = resolve(root, path);
  assertWithinRoot(root, target, "Path is outside this session's workspace.");
  if (!path.startsWith("uploads/") || path.endsWith("/")) {
    throw new Error("Only uploads/ can be written remotely.");
  }
  const encoded = params.content_base64;
  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
    encoded.length % 4 !== 0
  ) {
    throw new Error("Invalid upload or file exceeds 6 MB.");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.toString("base64") !== encoded) {
    throw new Error("Invalid upload encoding.");
  }
  let parent = root;
  for (const segment of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    const next = resolve(parent, segment);
    try {
      await mkdir(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    parent = await realpath(next);
    assertWithinRoot(root, parent, "Path is outside this session's workspace.");
  }
  const handle = await open(resolve(parent, relative(dirname(target), target)), "wx", 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  return { path, size: data.length };
}

/** Remote files follow the selected session, not the Worker's startup folder. */
export async function workspaceFileRequest(
  workspace: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  if (method === "file/write") {
    return writeWorkspaceUpload(workspace, params);
  }
  const root = await realpath(workspace);
  const path = String(params.path || "").replaceAll("\\", "/");
  if (isAbsolute(path) || path.includes(":") || path.split("/").includes("..") || path.includes("\0")) {
    throw new Error("Use a relative workspace path.");
  }
  const target = resolve(root, path);
  assertWithinRoot(root, target, "Path is outside this session's workspace.");
  const resolved = await realpath(target);
  assertWithinRoot(root, resolved, "Path is outside this session's workspace.");
  if (method === "file/list") {
    const entries = await readdir(resolved, { withFileTypes: true });
    return {
      entries: entries
        .filter((entry) => !entry.isSymbolicLink())
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
    };
  }
  const info = await stat(resolved);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) {
    throw new Error("Preview requires a file of 6 MB or smaller.");
  }
  const handle = await open(resolved, "r");
  try {
    const data = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1));
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > MAX_FILE_BYTES) throw new Error("File exceeds 6 MB.");
    return {
      content_base64: data.subarray(0, bytesRead).toString("base64"),
      mime: FILE_MIME_TYPES[extname(path).toLowerCase()] || "text/plain",
      size: bytesRead,
    };
  } finally {
    await handle.close();
  }
}
