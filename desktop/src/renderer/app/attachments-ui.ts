import { FILE_LIMIT_BYTES, fileToBase64, formatBytes, isImageMime, uploadTargetPath } from "../attachments.ts"
import { attachmentChips } from "./dom.ts"
import { asRecord, asRecordText, escapeAttribute, escapeHtml } from "./html.ts"
import { chipFileBacklog, state, uploadPromises, vars } from "./state.ts"
import { type AttachmentChip } from "./types.ts"



// ---------- attachments (B4) ----------

export function attachmentsFor(projectPath: string) {
  return state.attachments[projectPath] || []
}

export function renderAttachments() {
  const chips = attachmentsFor(state.chatProjectPath)
  attachmentChips.hidden = !chips.length
  const existing = new Map<string, HTMLElement>()
  for (const node of attachmentChips.querySelectorAll<HTMLElement>("[data-chip-id]")) {
    if (node.dataset.chipId) existing.set(node.dataset.chipId, node)
  }
  for (const [index, chip] of chips.entries()) {
    let item = existing.get(chip.id)
    if (!item) {
      item = document.createElement("div")
      item.className = "attachment-chip"
      item.dataset.chipId = chip.id
      attachmentChips.append(item)
    }
    const extension = chip.name.includes(".") ? chip.name.split(".").pop()?.toUpperCase() : chip.name.toUpperCase()
    item.className = `attachment-chip chip-${chip.status}`
    item.innerHTML = `
      ${chip.previewUrl ? `<img class="attachment-thumb" src="${escapeAttribute(chip.previewUrl)}" alt="" aria-hidden="true" />` : `<span class="attachment-thumb attachment-thumb-file" aria-hidden="true">${escapeHtml((extension || "FILE").slice(0, 4))}</span>`}
      <span class="attachment-meta">
        <span class="attachment-name" title="${escapeAttribute(chip.name)}">${escapeHtml(chip.name)}</span>
        <small class="attachment-size">${formatBytes(chip.size)}${chip.status === "uploading" ? " · uploading…" : chip.status === "failed" ? ` · ${escapeHtml(chip.error || "Upload failed")}` : ""}</small>
      </span>
      ${chip.status === "failed" ? `<button type="button" class="ghost-button chip-retry" data-chip-retry="${escapeAttribute(chip.id)}" title="Retry upload">Retry</button>` : chip.status === "ok" ? `<span class="status-pip pip-done" title="Uploaded"></span>` : `<span class="send-spinner chip-spinner" aria-hidden="true"></span>`}
      <button type="button" class="ghost-button chip-delete" data-chip-delete="${escapeAttribute(chip.id)}" title="Remove attachment" aria-label="Remove attachment ${escapeAttribute(chip.name)}">✕</button>
    `
    if (attachmentChips.children[index] !== item) attachmentChips.append(item)
    existing.delete(chip.id)
  }
  for (const stale of existing.values()) stale.remove()
}

export function addAttachmentFiles(files: File[]) {
  const projectPath = state.chatProjectPath
  if (!projectPath) return
  for (const file of files) {
    const chip: AttachmentChip = {
      id: `chip-${++vars.attachmentSequence}`,
      name: file.name || "pasted-image",
      size: file.size,
      mime: file.type || "application/octet-stream",
      previewUrl: isImageMime(file.type) && file.size <= FILE_LIMIT_BYTES ? URL.createObjectURL(file) : "",
      status: "uploading",
      path: "",
      error: "",
    }
    if (file.size > FILE_LIMIT_BYTES) {
      chip.status = "failed"
      chip.error = `Larger than the ${formatBytes(FILE_LIMIT_BYTES)} limit`
    } else {
      chipFileBacklog.set(chip.id, file)
    }
    state.attachments[projectPath] = [...state.attachments[projectPath] || [], chip]
    if (chip.status === "uploading") startAttachmentUpload(projectPath, chip.id, file)
  }
  renderAttachments()
}

export function startAttachmentUpload(projectPath: string, chipId: string, file: File) {
  const upload = (async () => {
    try {
      const base64 = await fileToBase64(file)
      const path = uploadTargetPath(file.name || "pasted-image", new Date())
      const result = asRecord(await window.api.workspaceFiles.write(projectPath, path, base64))
      const chip = attachmentsFor(projectPath).find((item) => item.id === chipId)
      if (!chip) return
      chip.status = "ok"
      chip.path = asRecordText(result.path) || path
    } catch (error) {
      const chip = attachmentsFor(projectPath).find((item) => item.id === chipId)
      if (!chip) return
      chip.status = "failed"
      chip.error = error instanceof Error ? error.message : String(error)
    } finally {
      uploadPromises.delete(chipId)
      if (projectPath === state.chatProjectPath) renderAttachments()
    }
  })()
  uploadPromises.set(chipId, upload)
}

export function retryAttachment(chipId: string) {
  const projectPath = state.chatProjectPath
  const chip = attachmentsFor(projectPath).find((item) => item.id === chipId)
  if (!chip || chip.status !== "failed") return
  const entry = chipFileBacklog.get(chipId)
  if (!entry) {
    chip.status = "failed"
    chip.error = "The original file is no longer available. Remove and re-attach it."
    renderAttachments()
    return
  }
  chip.status = "uploading"
  chip.error = ""
  renderAttachments()
  startAttachmentUpload(projectPath, chipId, entry)
}

export function removeAttachment(chipId: string) {
  const list = state.attachments[state.chatProjectPath] || []
  state.attachments[state.chatProjectPath] = list.filter((item) => item.id !== chipId)
  chipFileBacklog.delete(chipId)
  renderAttachments()
}

export async function waitForAttachments() {
  while (uploadPromises.size) {
    await Promise.all([...uploadPromises.values()])
  }
}
