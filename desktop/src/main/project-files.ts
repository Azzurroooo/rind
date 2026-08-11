import { open, readdir, realpath, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path"

import type { DesktopFileListing, DesktopFilePreview } from "../preload/types"

const maxDirectoryEntries = 500
const maxTextBytes = 1_000_000
const maxImageBytes = 5_000_000
const imageMimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

export async function listProjectFiles(root: string, requestedPath: unknown): Promise<DesktopFileListing> {
  const { path, absolutePath } = await resolveProjectPath(root, requestedPath, true)
  const entries = await readdir(absolutePath, { withFileTypes: true })
  const visible = entries
    .filter((entry) => entry.name !== ".git")
    .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
  return {
    path,
    truncated: visible.length > maxDirectoryEntries,
    entries: visible.slice(0, maxDirectoryEntries).map((entry) => ({
      name: entry.name,
      path: joinRelativePath(path, entry.name),
      kind: entry.isDirectory() ? "directory" : "file",
    })),
  }
}

export async function previewProjectFile(root: string, requestedPath: unknown): Promise<DesktopFilePreview> {
  const { path, absolutePath } = await resolveProjectPath(root, requestedPath, false)
  const fileStat = await stat(absolutePath)
  if (!fileStat.isFile()) throw new Error("Only files can be previewed.")
  const mimeType = imageMimeTypes[extname(absolutePath).toLocaleLowerCase()]
  if (mimeType) return previewImage(path, absolutePath, fileStat.size, mimeType)
  return previewText(path, absolutePath, fileStat.size)
}

async function previewImage(path: string, absolutePath: string, size: number, mimeType: string): Promise<DesktopFilePreview> {
  if (size > maxImageBytes) {
    return { path, name: basename(path), kind: "unsupported", size, message: "Image is larger than 5 MB." }
  }
  const handle = await open(absolutePath, "r")
  try {
    const content = Buffer.alloc(size)
    await handle.read(content, 0, size, 0)
    return { path, name: basename(path), kind: "image", size, mimeType, dataUrl: `data:${mimeType};base64,${content.toString("base64")}` }
  } finally {
    await handle.close()
  }
}

async function previewText(path: string, absolutePath: string, size: number): Promise<DesktopFilePreview> {
  const length = Math.min(size, maxTextBytes + 1)
  const handle = await open(absolutePath, "r")
  let content: Buffer
  try {
    content = Buffer.alloc(length)
    const { bytesRead } = await handle.read(content, 0, length, 0)
    content = content.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  if (content.includes(0)) return { path, name: basename(path), kind: "unsupported", size, message: "Binary files cannot be previewed." }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, maxTextBytes))
    return { path, name: basename(path), kind: "text", size, content: text, truncated: size > maxTextBytes }
  } catch {
    return { path, name: basename(path), kind: "unsupported", size, message: "Only UTF-8 text files can be previewed." }
  }
}

async function resolveProjectPath(root: string, requestedPath: unknown, directory: boolean) {
  if (typeof requestedPath !== "string") throw new Error("File path must be a string.")
  const path = normalizeRelativePath(requestedPath)
  const canonicalRoot = await realpath(root)
  const requestedAbsolutePath = resolve(canonicalRoot, path)
  assertWithinRoot(canonicalRoot, requestedAbsolutePath)
  const absolutePath = await realpath(requestedAbsolutePath)
  assertWithinRoot(canonicalRoot, absolutePath)
  const fileStat = await stat(absolutePath)
  if (directory && !fileStat.isDirectory()) throw new Error("Path is not a directory.")
  if (!directory && !fileStat.isFile()) throw new Error("Path is not a file.")
  return { path, absolutePath }
}

function normalizeRelativePath(value: string) {
  const path = value.trim()
  if (isAbsolute(path)) throw new Error("File path must be relative to the active project.")
  if (path.split(/[\\/]+/).some((part) => part === "..")) throw new Error("File path cannot leave the active project.")
  return path.replace(/[\\/]+/g, sep).replace(new RegExp(`^${escapeRegExp(sep)}+`), "")
}

function assertWithinRoot(root: string, target: string) {
  const path = relative(root, target)
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return
  throw new Error("File path cannot leave the active project.")
}

function joinRelativePath(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
