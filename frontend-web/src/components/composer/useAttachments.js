import { useCallback, useEffect, useRef, useState } from "react";

// Uploads go through file/write as base64; 6 MB of raw bytes keeps the encoded
// payload under the worker's 8 MB file limit.
export const UPLOAD_LIMIT_BYTES = 6 * 1024 * 1024;
const NOTICE_MS = 4000;
let nextChipId = 1;

// Attachment chips for the composer (spec section 6): idle -> uploading ->
// ok | failed. Uploads never block typing or sending; `take()` hands the
// uploaded paths to a send and keeps still-uploading chips for the next one.
export function useAttachments(onUpload) {
  const [chips, setChips] = useState([]);
  const [notice, setNotice] = useState("");
  const chipsRef = useRef(chips);
  const noticeTimer = useRef(null);
  chipsRef.current = chips;

  useEffect(() => () => {
    window.clearTimeout(noticeTimer.current);
    chipsRef.current.forEach(revokePreview);
  }, []);

  const flash = useCallback((message) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), NOTICE_MS);
  }, []);

  const patchChip = useCallback((id, patch) => {
    setChips((current) => current.map((chip) => (chip.id === id ? { ...chip, ...patch } : chip)));
  }, []);

  const removeChip = useCallback((chip) => {
    setChips((current) => current.filter((item) => item.id !== chip.id));
    revokePreview(chip);
  }, []);

  const startUpload = useCallback((chip) => {
    if (!onUpload) return;
    patchChip(chip.id, { status: "uploading", error: "" });
    Promise.resolve()
      .then(() => onUpload(chip.file))
      .then((path) => patchChip(chip.id, { status: "ok", path: String(path || ""), error: "" }))
      .catch((error) => patchChip(chip.id, { status: "failed", error: error instanceof Error ? error.message : String(error || "Upload failed") }));
  }, [onUpload, patchChip]);

  const addFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList || []);
    const files = incoming.filter((file) => file && (file.size == null || file.size <= UPLOAD_LIMIT_BYTES));
    if (files.length !== incoming.length) flash("Files must be 6 MB or smaller. Larger files were skipped.");
    if (!files.length) return;
    const created = files.map((file) => ({
      id: `chip-${nextChipId++}`,
      file,
      name: file.name || "pasted-image",
      size: file.size || 0,
      mime: file.type || "",
      previewUrl: previewUrlFor(file),
      status: onUpload ? "uploading" : "failed",
      path: "",
      error: onUpload ? "" : "Upload unavailable",
    }));
    setChips((current) => [...current, ...created]);
    created.filter((chip) => chip.status === "uploading").forEach(startUpload);
  }, [flash, onUpload, startUpload]);

  // Returns the uploaded paths and drops their chips.
  const take = useCallback(() => {
    const current = chipsRef.current;
    const delivered = current.filter((chip) => chip.status === "ok" && chip.path);
    const uploading = current.filter((chip) => chip.status === "uploading").length;
    const ids = new Set(delivered.map((chip) => chip.id));
    delivered.forEach(revokePreview);
    setChips((next) => next.filter((chip) => !ids.has(chip.id)));
    if (uploading) {
      flash(uploading === 1 ? "1 attachment still uploading; not sent with this message" : `${uploading} attachments still uploading; not sent with this message`);
    }
    return delivered.map((chip) => chip.path);
  }, [flash]);

  const ready = chips.some((chip) => chip.status === "ok" && chip.path);
  return { chips, notice, ready, addFiles, removeChip, startUpload, take };
}

function revokePreview(chip) {
  if (chip?.previewUrl) URL.revokeObjectURL?.(chip.previewUrl);
}

function previewUrlFor(file) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "";
  try {
    return file.type?.startsWith("image/") ? URL.createObjectURL(file) : "";
  } catch {
    return "";
  }
}
