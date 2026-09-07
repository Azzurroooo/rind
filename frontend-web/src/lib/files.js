// File helpers shared by the Composer uploader (file/write) and the read-only
// workspace file tree (file/list + file/read). Pure logic only — the protocol
// calls themselves stay in App.jsx via runtimeClient.

export const FILE_LIMIT_BYTES = 8 * 1024 * 1024; // worker rejects file/read|write above this

// Attachments land in the uploads/ subtree (the only place file/write allows).
export function uploadTargetPath(fileName, date = new Date()) {
  const stamp = uploadTimestamp(date);
  return `uploads/web/${stamp}-${sanitizeFileName(fileName)}`;
}

export function uploadTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function sanitizeFileName(value) {
  const raw = String(value || "file").replace(/\\/g, "/").split("/").pop() || "file";
  const dot = raw.lastIndexOf(".");
  const base = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+/, "").replace(/-+$/, "") || "file";
  const ext = dot > 0 ? raw.slice(dot).replace(/[^\w.]/g, "") : "";
  return `${base.slice(0, 60)}${ext.slice(0, 16)}`;
}

// Reads a Blob into the base64 payload file/write expects (no data: prefix).
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file || typeof file.arrayBuffer !== "function") {
      reject(new Error("not a file"));
      return;
    }
    file
      .arrayBuffer()
      .then((buffer) => resolve(arrayBufferToBase64(buffer)))
      .catch(reject);
  });
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function decodeBase64ToText(value) {
  const bytes = base64ToBytes(value);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function base64ToDataUrl(base64, mime = "application/octet-stream") {
  return `data:${mime || "application/octet-stream"};base64,${String(base64 || "")}`;
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function isImageMime(mime) {
  return String(mime || "").startsWith("image/");
}

export function isTextMime(mime) {
  const clean = String(mime || "").toLowerCase();
  if (clean.startsWith("text/")) return true;
  return ["application/json", "application/yaml", "application/xml", "application/javascript", "application/typescript", "application/x-python"].includes(clean);
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// Send composition: each uploaded chip appends one path reference line.
export function composeMessageWithAttachments(text, paths) {
  const base = String(text || "").replace(/\s+$/, "");
  const clean = (Array.isArray(paths) ? paths : []).map((path) => String(path || "").trim()).filter(Boolean);
  if (!clean.length) return base;
  return `${base ? `${base}\n` : ""}${clean.map((path) => `附件：${path}`).join("\n")}`;
}
