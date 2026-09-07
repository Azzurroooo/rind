// Attachment helpers for the composer uploader (file/write into the uploads/
// subtree), ported from frontend-web/src/lib/files.js. Pure logic only — the
// protocol call lives in the preload API (window.api.workspaceFiles.write).

export const FILE_LIMIT_BYTES = 8 * 1024 * 1024 // worker rejects file/read|write above this

// Attachments land in the uploads/ subtree (the only place file/write allows).
export function uploadTargetPath(fileName: string, date = new Date(), surface = "desktop") {
  const stamp = uploadTimestamp(date)
  return `uploads/${surface}/${stamp}-${sanitizeFileName(fileName)}`
}

export function uploadTimestamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function sanitizeFileName(value: string) {
  const raw = String(value || "file").replace(/\\/g, "/").split("/").pop() || "file"
  const dot = raw.lastIndexOf(".")
  const base = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+/, "").replace(/-+$/, "") || "file"
  const ext = dot > 0 ? raw.slice(dot).replace(/[^\w.]/g, "") : ""
  return `${base.slice(0, 60)}${ext.slice(0, 16)}`
}

// Reads a Blob into the base64 payload file/write expects (no data: prefix).
export function fileToBase64(file: Blob): Promise<string> {
  return file.arrayBuffer().then((buffer) => arrayBufferToBase64(buffer))
}

export function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk) as unknown as number[])
  }
  return btoa(binary)
}

export function base64ToDataUrl(base64: string, mime = "application/octet-stream") {
  return `data:${mime || "application/octet-stream"};base64,${String(base64 || "")}`
}

export function isImageMime(mime: string) {
  return String(mime || "").startsWith("image/")
}

export function formatBytes(value: number) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

// Send composition: each uploaded chip appends one path reference line.
export function composeMessageWithAttachments(text: string, paths: string[]) {
  const base = String(text || "").replace(/\s+$/, "")
  const clean = (Array.isArray(paths) ? paths : []).map((path) => String(path || "").trim()).filter(Boolean)
  if (!clean.length) return base
  return `${base ? `${base}\n` : ""}${clean.map((path) => `附件：${path}`).join("\n")}`
}
