import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const maxDirectoryEntries = 500;
const maxTextBytes = 1_000_000;
const maxImageBytes = 5_000_000;
const MAX_FILE_BYTES = 6 * 1024 * 1024;

const imageMimeTypes = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const mime = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

export async function listProjectFiles(root, requestedPath) {
  const { path, absolutePath } = await resolveProjectPath(root, requestedPath, true);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const visible = entries
    .filter((entry) => entry.name !== ".git")
    .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
  return {
    path,
    truncated: visible.length > maxDirectoryEntries,
    entries: visible.slice(0, maxDirectoryEntries).map((entry) => ({
      name: entry.name,
      path: joinRelativePath(path, entry.name),
      kind: entry.isDirectory() ? "directory" : "file",
    })),
  };
}

export async function previewProjectFile(root, requestedPath) {
  const { path, absolutePath } = await resolveProjectPath(root, requestedPath, false);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("Only files can be previewed.");
  const mimeType = imageMimeTypes[extname(absolutePath).toLocaleLowerCase()];
  if (mimeType) return previewImage(path, absolutePath, fileStat.size, mimeType);
  return previewText(path, absolutePath, fileStat.size);
}

async function previewImage(path, absolutePath, size, mimeType) {
  if (size > maxImageBytes) {
    return { path, name: basename(path), kind: "unsupported", size, message: "Image is larger than 5 MB." };
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

async function previewText(path, absolutePath, size) {
  const length = Math.min(size, maxTextBytes + 1);
  const handle = await open(absolutePath, "r");
  let content;
  try {
    content = Buffer.alloc(length);
    const { bytesRead } = await handle.read(content, 0, length, 0);
    content = content.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (content.includes(0)) {
    return { path, name: basename(path), kind: "unsupported", size, message: "Binary files cannot be previewed." };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, maxTextBytes));
    return { path, name: basename(path), kind: "text", size, content: text, truncated: size > maxTextBytes };
  } catch {
    return { path, name: basename(path), kind: "unsupported", size, message: "Only UTF-8 text files can be previewed." };
  }
}

async function resolveProjectPath(root, requestedPath, directory) {
  if (typeof requestedPath !== "string") throw new Error("File path must be a string.");
  const path = normalizeRelativePath(requestedPath);
  const canonicalRoot = await realpath(root);
  const requestedAbsolutePath = resolve(canonicalRoot, path);
  assertWithinRoot(canonicalRoot, requestedAbsolutePath);
  const absolutePath = await realpath(requestedAbsolutePath);
  assertWithinRoot(canonicalRoot, absolutePath);
  const fileStat = await stat(absolutePath);
  if (directory && !fileStat.isDirectory()) throw new Error("Path is not a directory.");
  if (!directory && !fileStat.isFile()) throw new Error("Path is not a file.");
  return { path, absolutePath };
}

function normalizeRelativePath(value) {
  const path = value.trim();
  if (isAbsolute(path)) throw new Error("File path must be relative to the active project.");
  if (path.split(/[\\/]+/).some((part) => part === "..")) throw new Error("File path cannot leave the active project.");
  return path.replace(/[\\/]+/g, sep).replace(new RegExp(`^${escapeRegExp(sep)}+`), "");
}

function assertWithinRoot(root, target) {
  const path = relative(root, target);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error("File path cannot leave the active project.");
}

function joinRelativePath(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inside(root, target) {
  const path = relative(root, target);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("Path is outside this session's workspace.");
  }
}

export async function writeWorkspaceUpload(workspace, params = {}) {
  const root = await realpath(workspace);
  const path = String(params.path || "").replaceAll("\\", "/");
  if (isAbsolute(path) || path.includes(":") || path.split("/").includes("..") || path.includes("\0")) {
    throw new Error("Use a relative workspace path.");
  }
  const target = resolve(root, path);
  inside(root, target);
  if (!path.startsWith("uploads/") || path.endsWith("/")) {
    throw new Error("Only uploads/ can be written remotely.");
  }
  const encoded = params.content_base64;
  if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || encoded.length % 4 !== 0) {
    throw new Error("Invalid upload or file exceeds 6 MB.");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.toString("base64") !== encoded) {
    throw new Error("Invalid upload encoding.");
  }
  // Resolve each existing ancestor before creating anything through it.
  let parent = root;
  for (const segment of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    const next = resolve(parent, segment);
    try {
      await mkdir(next);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    parent = await realpath(next);
    inside(root, parent);
  }
  // Exclusive creation also refuses symlink targets and accidental overwrite.
  const handle = await open(resolve(parent, relative(dirname(target), target)), "wx", 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  return { path, size: data.length };
}

/** Remote files follow the selected session, not the Worker's startup folder. */
export async function workspaceFileRequest(workspace, method, params = {}) {
  if (method === "file/write") {
    return writeWorkspaceUpload(workspace, params);
  }
  const root = await realpath(workspace);
  const path = String(params.path || "").replaceAll("\\", "/");
  if (isAbsolute(path) || path.includes(":") || path.split("/").includes("..") || path.includes("\0")) {
    throw new Error("Use a relative workspace path.");
  }
  const target = resolve(root, path);
  inside(root, target);
  const resolved = await realpath(target);
  inside(root, resolved);
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
      mime: mime[extname(path).toLowerCase()] || "text/plain",
      size: bytesRead,
    };
  } finally {
    await handle.close();
  }
}
