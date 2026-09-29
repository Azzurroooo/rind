import { mkdir, open, readdir, realpath, stat } from "node:fs/promises"
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"

const MAX_FILE_BYTES = 6 * 1024 * 1024
const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown" }

function inside(root: string, target: string) {
  const path = relative(root, target)
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) throw new Error("Path is outside this session's workspace.")
}

/** Gateway files follow the selected session, not the Worker's startup folder. */
export async function workspaceFileRequest(workspace: string, method: string, params: Record<string, unknown>) {
  const root = await realpath(workspace)
  const path = String(params.path || "").replaceAll("\\", "/")
  if (isAbsolute(path) || path.includes(":") || path.split("/").includes("..") || path.includes("\0")) throw new Error("Use a relative workspace path.")
  const target = resolve(root, path)
  inside(root, target)
  if (method === "file/write") {
    if (!path.startsWith("uploads/") || path.endsWith("/")) throw new Error("Only uploads/ can be written remotely.")
    const encoded = params.content_base64
    if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || encoded.length % 4 !== 0) throw new Error("Invalid upload or file exceeds 6 MB.")
    const data = Buffer.from(encoded, "base64")
    if (data.toString("base64") !== encoded) throw new Error("Invalid upload encoding.")
    // Resolve each existing ancestor before creating anything through it.
    let parent = root
    for (const segment of relative(root, dirname(target)).split(sep).filter(Boolean)) {
      const next = resolve(parent, segment)
      try { await mkdir(next) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      parent = await realpath(next); inside(root, parent)
    }
    // Exclusive creation also refuses symlink targets and accidental overwrite.
    const handle = await open(resolve(parent, relative(dirname(target), target)), "wx", 0o600)
    try { await handle.writeFile(data) } finally { await handle.close() }
    return { path, size: data.length }
  }
  const resolved = await realpath(target)
  inside(root, resolved)
  if (method === "file/list") {
    const entries = await readdir(resolved, { withFileTypes: true })
    return { entries: entries.filter((entry) => !entry.isSymbolicLink()).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)) }
  }
  const info = await stat(resolved)
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Preview requires a file of 6 MB or smaller.")
  const handle = await open(resolved, "r")
  try {
    const data = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1))
    const { bytesRead } = await handle.read(data, 0, data.length, 0)
    if (bytesRead > MAX_FILE_BYTES) throw new Error("File exceeds 6 MB.")
    return { content_base64: data.subarray(0, bytesRead).toString("base64"), mime: mime[extname(path).toLowerCase()] || "text/plain", size: bytesRead }
  } finally { await handle.close() }
}
