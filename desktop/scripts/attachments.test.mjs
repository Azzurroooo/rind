import assert from "node:assert/strict"
import test from "node:test"

import {
  FILE_LIMIT_BYTES,
  arrayBufferToBase64,
  base64ToDataUrl,
  composeMessageWithAttachments,
  formatBytes,
  isImageMime,
  sanitizeFileName,
  uploadTargetPath,
  uploadTimestamp,
} from "../src/renderer/attachments.ts"

test("sanitizeFileName strips paths and unsafe characters", () => {
  assert.equal(sanitizeFileName("report.pdf"), "report.pdf")
  assert.equal(sanitizeFileName("..\\..\\evil name!!.png"), "evil-name.png")
  assert.equal(sanitizeFileName("/etc/passwd"), "passwd")
  assert.equal(sanitizeFileName("no extension"), "no-extension")
  assert.equal(sanitizeFileName(""), "file")
  // Dot-only names degrade to a bare base plus the residual dot (web parity).
  assert.equal(sanitizeFileName("..."), "file.")
})

test("sanitizeFileName bounds base and extension length", () => {
  const long = `${"a".repeat(100)}.txt`
  const cleaned = sanitizeFileName(long)
  assert.ok(cleaned.length <= 76)
  assert.ok(cleaned.endsWith(".txt"))
})

test("uploadTargetPath builds uploads/desktop/<ts>-<name>", () => {
  const path = uploadTargetPath("Screen Shot 1.png", new Date(2026, 8, 7, 12, 34, 56))
  assert.equal(path, "uploads/desktop/20260907-123456-Screen-Shot-1.png")
  assert.match(uploadTargetPath("x.bin"), /^uploads\/desktop\/\d{8}-\d{6}-x\.bin$/)
})

test("uploadTimestamp zero-pads every component", () => {
  assert.equal(uploadTimestamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405")
})

test("arrayBufferToBase64 encodes bytes without padding surprises", () => {
  const bytes = new TextEncoder().encode("hello")
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  assert.equal(arrayBufferToBase64(buffer), btoa("hello"))
  assert.equal(base64ToDataUrl("aGk=", "text/plain"), "data:text/plain;base64,aGk=")
})

test("formatBytes renders human sizes", () => {
  assert.equal(formatBytes(512), "512 B")
  assert.equal(formatBytes(2048), "2.0 KiB")
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MiB")
  assert.equal(formatBytes(Number.NaN), "")
})

test("attachment limits and send composition", () => {
  assert.equal(FILE_LIMIT_BYTES, 8 * 1024 * 1024)
  assert.equal(isImageMime("image/png"), true)
  assert.equal(isImageMime("application/pdf"), false)
  assert.equal(composeMessageWithAttachments("Look at this", ["uploads/desktop/a.png"]), "Look at this\n附件：uploads/desktop/a.png")
  assert.equal(composeMessageWithAttachments("", ["uploads/desktop/a.png", "uploads/desktop/b.pdf"]), "附件：uploads/desktop/a.png\n附件：uploads/desktop/b.pdf")
  assert.equal(composeMessageWithAttachments("plain", []), "plain")
})
