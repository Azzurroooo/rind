import { sameProjectPath as samePath } from "../project-selection.ts"
import { highlightFile } from "../syntax-highlight.ts"
import { projectRelativePath } from "../tool-display.ts"
import { filePreview, fileResizeHandle, filesToggle, fileTree, sidebarResizeHandle } from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { showToast } from "./overlays.ts"
import { runAction } from "./runtime.ts"
import { applyOverview, viewedProject } from "./sessions.ts"
import { render, startResize } from "./shell.ts"
import { state } from "./state.ts"



export function renderFiles() {
  const project = viewedProject()
  filesToggle.disabled = !project?.available
  const filesLabel = state.filesOpen ? "Hide project files" : "Browse active project files"
  filesToggle.dataset.tooltip = filesLabel
  filesToggle.setAttribute("aria-label", filesLabel)
  filesToggle.setAttribute("aria-expanded", String(state.filesOpen))
  if (!state.filesOpen || !project?.available) return
  fileTree.innerHTML = renderDirectory("")
  const preview = state.filePreview
  if (!preview) {
    filePreview.innerHTML = ""
  } else if (preview.kind === "text") {
    const highlighted = highlightFile(preview.name, preview.content || "")
    filePreview.innerHTML = `<div class="file-preview-head"><button type="button" class="ghost-button" data-close-preview title="Back to files">Back</button><strong>${escapeHtml(preview.name)}</strong><small>${escapeHtml(highlighted.language)} · ${formatFileSize(preview.size)}${preview.truncated ? " · truncated" : ""}</small></div><pre><code class="hljs language-${escapeAttribute(highlighted.language)}">${highlighted.html}</code></pre>`
  } else if (preview.kind === "image") {
    filePreview.innerHTML = `<div class="file-preview-head"><button type="button" class="ghost-button" data-close-preview title="Back to files">Back</button><strong>${escapeHtml(preview.name)}</strong><small>${formatFileSize(preview.size)}</small></div><img src="${escapeAttribute(preview.dataUrl || "")}" alt="${escapeAttribute(preview.name)}" />`
  } else {
    filePreview.innerHTML = `<div class="file-preview-head"><button type="button" class="ghost-button" data-close-preview title="Back to files">Back</button><strong>${escapeHtml(preview.name)}</strong><small>${formatFileSize(preview.size)}</small></div><p class="subtle">${escapeHtml(preview.message || "This file cannot be previewed.")}</p>`
  }
}

export function renderDirectory(path: string, depth = 0): string {
  const listing = state.fileListings[path]
  if (!listing) return path ? "" : `<p class="subtle">Loading files…</p>`
  const rows = listing.entries.map((entry) => {
    if (entry.kind === "file") {
      return `<button type="button" class="file-row${state.filePreview?.path === entry.path ? " selected" : ""}" data-preview-file="${escapeAttribute(entry.path)}" style="--file-indent:${depth * 14}px">${escapeHtml(entry.name)}</button>`
    }
    const expanded = state.expandedDirectories.has(entry.path)
    const action = expanded ? "Collapse" : "Expand"
    return `<div class="file-directory${expanded ? " expanded" : ""}"><button type="button" class="file-row directory" data-toggle-directory="${escapeAttribute(entry.path)}" aria-expanded="${String(expanded)}" aria-label="${escapeAttribute(`${action} ${entry.name}`)}" style="--file-indent:${depth * 14}px"><span class="file-chevron" aria-hidden="true"></span><span>${escapeHtml(entry.name)}</span></button>${expanded ? renderDirectory(entry.path, depth + 1) : ""}</div>`
  })
  const warning = listing.truncated ? `<p class="file-truncated">Only the first 500 items are shown.</p>` : ""
  return `<div class="file-branch">${rows.join("")}${warning}</div>`
}

export async function setFilesOpen(open: boolean) {
  if (open && !viewedProject()?.available) {
    state.notice = "Choose an available project before browsing files."
    render()
    return
  }
  applyOverview(await window.api.projects.updateLayout({ filesOpen: open }))
  render()
  if (open) await loadDirectory("")
}

export async function loadDirectory(path: string) {
  const project = viewedProject()
  if (!project) return
  const projectPath = project.path
  const listing = await window.api.files.list(projectPath, path)
  if (!samePath(viewedProject()?.path || "", projectPath)) return
  state.fileListings = { ...state.fileListings, [path]: listing }
  render()
}

export async function toggleDirectory(path: string) {
  const projectPath = viewedProject()?.path || ""
  if (!projectPath) return
  const expanded = new Set(state.expandedDirectories)
  if (expanded.has(path)) {
    expanded.delete(path)
  } else {
    expanded.add(path)
    if (!state.fileListings[path]) await loadDirectory(path)
  }
  if (!samePath(viewedProject()?.path || "", projectPath)) return
  state.expandedDirectories = expanded
  render()
}

export async function previewFile(path: string) {
  const project = viewedProject()
  if (!project) return
  const projectPath = project.path
  const preview = await window.api.files.preview(projectPath, path)
  if (!samePath(viewedProject()?.path || "", projectPath)) return
  state.filePreview = preview
  render()
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function bindFilesPanelEvents(): void {
  fileTree.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    const directoryPath = target.closest<HTMLButtonElement>("[data-toggle-directory]")?.dataset.toggleDirectory
    if (directoryPath !== undefined) {
      runAction(() => toggleDirectory(directoryPath))
      return
    }
    const filePath = target.closest<HTMLButtonElement>("[data-preview-file]")?.dataset.previewFile
    if (filePath) runAction(() => previewFile(filePath))
  })

  filePreview.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-close-preview]")) {
      state.filePreview = undefined
      render()
    }
  })

  startResize(sidebarResizeHandle, "sidebar")

  startResize(fileResizeHandle, "files")
}

/** Opens a path from a read_file row in the Files tab (spec section 5.3). */
export async function openToolFile(path: string) {
  const project = viewedProject()
  const relative = project ? projectRelativePath(path, project.path) : undefined
  if (!project?.available || !relative) {
    showToast(project?.available ? "That file is outside this project." : "Choose an available project to open files.")
    return
  }
  if (!state.filesOpen) await setFilesOpen(true)
  await previewFile(relative)
}
