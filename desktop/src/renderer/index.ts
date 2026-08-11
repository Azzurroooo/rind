import "./style.css"

import type {
  DesktopFileListing,
  DesktopFilePreview,
  DesktopProject,
  DesktopSessionSummary,
  DesktopSettings,
  RuntimeEvent,
  RuntimeMethod,
  RuntimeSnapshot,
} from "../preload/types"
import {
  addUserMessage,
  clipLine,
  conversationFromReplay,
  createConversation,
  formatDuration,
  reduceEvent,
  relativeTime,
  type ConversationState,
  type Entry,
  type PlanEntry,
  type ToolEntry,
} from "./timeline-model"

type AppState = {
  runtime: RuntimeSnapshot
  settings: DesktopSettings
  settingsOpen: boolean
  settingsSaving: boolean
  settingsAutoOpened: boolean
  sessionId: string
  model: string
  models: string[]
  projects: DesktopProject[]
  activeProjectPath: string
  sessionPages: Record<string, DesktopSessionSummary[]>
  sessionTotals: Record<string, number>
  sidebarOpen: boolean
  sidebarWidth: number
  filesOpen: boolean
  fileTreeWidth: number
  filePreviewWidth: number
  expandedProjects: Set<string>
  expandedDirectories: Set<string>
  fileListings: Record<string, DesktopFileListing>
  filePreview?: DesktopFilePreview
  drafts: Record<string, string>
  createDraftWhenReady: boolean
  conversation: ConversationState
  expandedTools: Set<string>
  notice: string
  bootstrapped: boolean
}

const root = document.querySelector<HTMLElement>("#app")
if (!root) throw new Error("Renderer root is missing.")
const appRoot: HTMLElement = root

const state: AppState = {
  runtime: { status: "stopped" },
  settings: { model: "", baseUrl: "", reasoningEffort: "", hasApiKey: false },
  settingsOpen: false,
  settingsSaving: false,
  settingsAutoOpened: false,
  sessionId: "",
  model: "",
  models: [],
  projects: [],
  activeProjectPath: "",
  sessionPages: {},
  sessionTotals: {},
  sidebarOpen: true,
  sidebarWidth: 248,
  filesOpen: false,
  fileTreeWidth: 240,
  filePreviewWidth: 420,
  expandedProjects: new Set(),
  expandedDirectories: new Set([""]),
  fileListings: {},
  drafts: {},
  createDraftWhenReady: false,
  conversation: createConversation(),
  expandedTools: new Set(),
  notice: "Add a project to begin.",
  bootstrapped: false,
}

appRoot.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="identity">
        <span class="brand">Rind</span>
        <span id="connection" class="connection"><span class="status-pip"></span><span id="connection-text">Stopped</span></span>
      </div>
      <div class="workspace">
        <span id="workspace-path" class="workspace-path">No project selected</span>
        <button id="add-project" type="button" class="ghost-button">Add project</button>
        <button id="open-settings" type="button" class="ghost-button">Settings</button>
      </div>
    </header>
    <main class="layout">
      <aside id="sidebar" class="sidebar" aria-label="Projects and sessions">
        <div id="sidebar-resize-handle" class="sidebar-resize-handle" role="separator" aria-label="Resize projects sidebar" aria-orientation="vertical"></div>
        <div class="sidebar-actions">
          <button id="new-session" type="button" class="primary-button" title="Start a new chat in the active project">New chat</button>
        </div>
        <div class="sidebar-heading"><span>Projects</span><button id="sidebar-add-project" type="button" class="ghost-button" title="Add project">Add</button></div>
        <div id="project-list" class="project-list"></div>
      </aside>
      <section class="conversation">
        <div class="conversation-head">
          <div class="conversation-title"><strong id="session-title">New session</strong><span id="session-id" class="subtle"></span></div>
          <div class="conversation-actions"><button id="toggle-sidebar" type="button" class="ghost-button" title="Toggle projects sidebar" aria-label="Toggle projects sidebar">Projects</button><button id="toggle-files" type="button" class="ghost-button" title="Browse active project files">Files</button><button id="compact" type="button" class="ghost-button" title="Compact context now">Compact</button></div>
        </div>
        <div id="notice" class="notice" role="status" hidden><span id="notice-text"></span><button id="retry" type="button" class="ghost-button" hidden>Restart runtime</button></div>
        <div class="stream-wrap">
          <div id="message-stream" class="message-stream" aria-live="polite"></div>
          <button id="jump-latest" type="button" class="jump-latest" hidden>Jump to latest</button>
        </div>
        <form id="composer" class="composer">
          <textarea id="prompt" rows="2" placeholder="Message Rind — Enter to send, Shift+Enter for a new line" aria-label="Message Rind"></textarea>
          <div class="composer-footer">
            <label class="model-control" title="Active model"><select id="model-select" aria-label="Model"></select></label>
            <label class="project-control" title="Active project"><select id="project-select" aria-label="Active project"></select></label>
            <span id="context-meter" class="context-meter" hidden></span>
            <span class="composer-spacer"></span>
            <button id="steer" type="button" class="ghost-button" title="Steer the running turn with this message">Steer</button>
            <button id="interrupt" type="button" class="ghost-button danger" title="Stop the running turn (Esc)">Stop</button>
            <button id="send" type="submit" class="primary-button">Send</button>
          </div>
        </form>
      </section>
      <aside id="file-panel" class="file-panel" aria-label="Project files">
        <div id="file-resize-handle" class="file-resize-handle" role="separator" aria-label="Resize file panel" aria-orientation="vertical"></div>
        <div class="file-panel-head"><strong>Files</strong><button id="close-files" type="button" class="ghost-button" title="Close files">Close</button></div>
        <div class="file-workspace">
          <section id="file-preview" class="file-preview"><p class="subtle">Select a file to preview.</p></section>
          <div id="file-preview-resize-handle" class="file-preview-resize-handle" role="separator" aria-label="Resize file preview" aria-orientation="vertical"></div>
          <div id="file-tree" class="file-tree"></div>
        </div>
      </aside>
    </main>
    <dialog id="settings-dialog" class="settings-dialog">
      <form id="settings-form" method="dialog">
        <div class="settings-heading"><strong>Runtime settings</strong><button id="close-settings" type="button" class="ghost-button" title="Close settings">Close</button></div>
        <label>API key<input id="settings-api-key" type="password" autocomplete="new-password" placeholder="Leave blank to keep the current key" /></label>
        <p id="settings-key-status" class="subtle"></p>
        <label>Base URL<input id="settings-base-url" type="url" placeholder="https://api.openai.com/v1" /></label>
        <label>Model<input id="settings-model" type="text" placeholder="Default model" /></label>
        <label>Reasoning effort<input id="settings-reasoning" type="text" placeholder="high" /></label>
        <div class="settings-actions"><button id="cancel-settings" type="button" class="ghost-button">Cancel</button><button id="save-settings" type="submit" class="primary-button">Save</button></div>
      </form>
    </dialog>
  </div>
`

const connection = requiredElement("connection")
const connectionText = requiredElement("connection-text")
const projectSelect = requiredElement<HTMLSelectElement>("project-select")
const workspacePath = requiredElement("workspace-path")
const projectList = requiredElement("project-list")
const sessionTitle = requiredElement("session-title")
const sessionIdLabel = requiredElement("session-id")
const modelSelect = requiredElement<HTMLSelectElement>("model-select")
const messageStream = requiredElement("message-stream")
const jumpLatest = requiredElement<HTMLButtonElement>("jump-latest")
const notice = requiredElement("notice")
const noticeText = requiredElement("notice-text")
const retry = requiredElement<HTMLButtonElement>("retry")
const contextMeter = requiredElement("context-meter")
const prompt = requiredElement<HTMLTextAreaElement>("prompt")
const send = requiredElement<HTMLButtonElement>("send")
const steer = requiredElement<HTMLButtonElement>("steer")
const interrupt = requiredElement<HTMLButtonElement>("interrupt")
const sidebar = requiredElement("sidebar")
const sidebarResizeHandle = requiredElement("sidebar-resize-handle")
const filePanel = requiredElement("file-panel")
const fileResizeHandle = requiredElement("file-resize-handle")
const filePreviewResizeHandle = requiredElement("file-preview-resize-handle")
const fileTree = requiredElement("file-tree")
const filePreview = requiredElement("file-preview")
const filesToggle = requiredElement<HTMLButtonElement>("toggle-files")
const newSessionButton = requiredElement<HTMLButtonElement>("new-session")
const sidebarToggle = requiredElement<HTMLButtonElement>("toggle-sidebar")
const settingsDialog = requiredElement<HTMLDialogElement>("settings-dialog")
const settingsForm = requiredElement<HTMLFormElement>("settings-form")
const settingsApiKey = requiredElement<HTMLInputElement>("settings-api-key")
const settingsBaseUrl = requiredElement<HTMLInputElement>("settings-base-url")
const settingsModel = requiredElement<HTMLInputElement>("settings-model")
const settingsReasoning = requiredElement<HTMLInputElement>("settings-reasoning")
const settingsKeyStatus = requiredElement("settings-key-status")
const saveSettingsButton = requiredElement<HTMLButtonElement>("save-settings")

let workingTimer: ReturnType<typeof setInterval> | undefined
let lastRenderedEntries = 0
let resizeStart: { target: "sidebar" | "files" | "preview"; pointerId: number; x: number; width: number; lastWidth: number; wideFiles: boolean } | undefined

function requiredElement<T extends HTMLElement = HTMLElement>(id: string) {
  const element = document.getElementById(id) as T | null
  if (!element) throw new Error(`Missing ${id}.`)
  return element
}

function render() {
  const { runtime, conversation } = state
  const wideFiles = usesWideFileLayout()
  const filesWidth = state.filesOpen
    ? state.filePreview && wideFiles ? state.fileTreeWidth + state.filePreviewWidth + 8 : state.fileTreeWidth
    : 0
  connectionText.textContent = runtime.status === "ready" ? "Connected" : titleCase(runtime.status)
  connection.className = `connection connection-${runtime.status}`
  appRoot.classList.toggle("sidebar-open", state.sidebarOpen)
  appRoot.classList.toggle("files-open", state.filesOpen)
  appRoot.classList.toggle("files-wide", wideFiles)
  appRoot.classList.toggle("file-preview-open", Boolean(state.filePreview))
  appRoot.style.setProperty("--sidebar-panel-width", `${state.sidebarOpen ? state.sidebarWidth : 0}px`)
  appRoot.style.setProperty("--files-panel-width", `${filesWidth}px`)
  appRoot.style.setProperty("--file-tree-width", `${state.fileTreeWidth}px`)
  appRoot.style.setProperty("--file-preview-width", `${state.filePreviewWidth}px`)
  sidebar.setAttribute("aria-hidden", String(!state.sidebarOpen))
  sidebar.inert = !state.sidebarOpen
  filePanel.setAttribute("aria-hidden", String(!state.filesOpen))
  filePanel.inert = !state.filesOpen
  newSessionButton.title = activeProject()?.available ? `Start a new chat in ${activeProject()?.name}` : "Choose a project for a new chat"
  sidebarToggle.textContent = state.sidebarOpen ? "Hide projects" : "Projects"
  sidebarToggle.title = state.sidebarOpen ? "Hide projects sidebar" : "Show projects sidebar"
  workspacePath.textContent = activeProject()?.path || "No project selected"
  workspacePath.title = activeProject()?.path || ""
  const current = allSessions().find((item) => item.id === state.sessionId)
  sessionTitle.textContent = current?.title || (state.sessionId ? "Session" : "New session")
  sessionIdLabel.textContent = state.sessionId || ""
  noticeText.textContent = state.notice || runtime.message || ""
  retry.hidden = !runtime.workspace || (runtime.status !== "error" && runtime.status !== "stopped")
  notice.hidden = !noticeText.textContent && retry.hidden
  renderProjectControl()
  renderProjects()
  renderModels()
  renderStream()
  renderComposer()
  renderFiles()
  renderSettings()
  syncWorkingTimer()
}

function renderSettings() {
  if (state.settingsOpen && !settingsDialog.open) settingsDialog.showModal()
  if (!state.settingsOpen && settingsDialog.open) settingsDialog.close()
  settingsKeyStatus.textContent = state.settings.hasApiKey ? "An API key is available." : "No API key is configured."
  saveSettingsButton.disabled = state.settingsSaving
  saveSettingsButton.textContent = state.settingsSaving ? "Saving..." : "Save"
}

function activeProject() {
  return state.projects.find((project) => project.path === state.activeProjectPath)
}

function projectSessions(project: DesktopProject) {
  return state.sessionPages[project.path] || project.sessions
}

function allSessions() {
  return state.projects.flatMap(projectSessions)
}

function renderProjectControl() {
  projectSelect.replaceChildren()
  if (!state.projects.length) {
    const option = new Option("No project selected", "")
    option.disabled = true
    option.selected = true
    projectSelect.add(option)
    projectSelect.disabled = true
    return
  }
  for (const project of state.projects) {
    const option = new Option(project.available ? project.name : `${project.name} (missing)`, project.path)
    option.disabled = !project.available
    option.selected = project.path === state.activeProjectPath
    projectSelect.add(option)
  }
  projectSelect.disabled = Boolean(state.conversation.activeTurnId)
  projectSelect.value = state.activeProjectPath
}

function renderProjects() {
  projectList.replaceChildren()
  if (!state.projects.length) {
    projectList.innerHTML = `<div class="sidebar-empty"><strong>No projects</strong><span>Add a folder to start a chat.</span></div>`
    return
  }
  for (const project of state.projects) {
    const expanded = state.expandedProjects.has(project.path) || project.path === state.activeProjectPath
    const sessions = projectSessions(project)
    const total = state.sessionTotals[project.path] ?? project.totalSessions
    const projectNode = document.createElement("section")
    projectNode.className = `project-item${project.path === state.activeProjectPath ? " selected" : ""}${expanded ? " expanded" : ""}`
    projectNode.innerHTML = `
      <div class="project-row">
        <button type="button" class="project-trigger" data-project-path="${escapeAttribute(project.path)}" title="${escapeAttribute(project.path)}">
          <span class="project-name">${escapeHtml(project.name)}</span>
          <span class="project-path">${escapeHtml(project.path)}</span>
        </button>
        <button type="button" class="project-remove ghost-button" data-remove-project="${escapeAttribute(project.path)}" title="Remove project from Desktop">Remove</button>
      </div>
      ${project.available ? "" : `<p class="project-missing">Folder is unavailable.</p>`}
      ${expanded ? `<div class="project-sessions">${sessions.map(renderProjectSession).join("")}${sessions.length < total ? `<button type="button" class="show-more ghost-button" data-show-more="${escapeAttribute(project.path)}">View more sessions</button>` : ""}</div>` : ""}
    `
    projectList.append(projectNode)
  }
}

function renderProjectSession(item: DesktopSessionSummary) {
  const when = item.updatedAt ? relativeTime(item.updatedAt) : ""
  return `
    <button type="button" class="session-item${item.id === state.sessionId ? " selected" : ""}" data-session-id="${escapeAttribute(item.id)}">
      <span class="session-item-title">${escapeHtml(item.title || "Untitled")}</span>
      <small>${escapeHtml(clipLine(item.preview || "", 48))}</small>
      <small class="session-item-meta">${escapeHtml(when)}</small>
    </button>
  `
}

function renderFiles() {
  const project = activeProject()
  filesToggle.disabled = !project?.available
  filesToggle.textContent = state.filesOpen ? "Hide files" : "Files"
  if (!state.filesOpen || !project?.available) return
  fileTree.innerHTML = renderDirectory("")
  const preview = state.filePreview
  if (!preview) {
    filePreview.innerHTML = ""
  } else if (preview.kind === "text") {
    filePreview.innerHTML = `<div class="file-preview-head"><button type="button" class="ghost-button" data-close-preview title="Back to files">Back</button><strong>${escapeHtml(preview.name)}</strong><small>${formatFileSize(preview.size)}${preview.truncated ? " · truncated" : ""}</small></div><pre><code>${escapeHtml(preview.content || "")}</code></pre>`
  } else if (preview.kind === "image") {
    filePreview.innerHTML = `<div class="file-preview-head"><button type="button" class="ghost-button" data-close-preview title="Back to files">Back</button><strong>${escapeHtml(preview.name)}</strong><small>${formatFileSize(preview.size)}</small></div><img src="${escapeAttribute(preview.dataUrl || "")}" alt="${escapeAttribute(preview.name)}" />`
  } else {
    filePreview.innerHTML = `<div class="file-preview-head"><button type="button" class="ghost-button" data-close-preview title="Back to files">Back</button><strong>${escapeHtml(preview.name)}</strong><small>${formatFileSize(preview.size)}</small></div><p class="subtle">${escapeHtml(preview.message || "This file cannot be previewed.")}</p>`
  }
}

function renderDirectory(path: string, depth = 0): string {
  const listing = state.fileListings[path]
  if (!listing) return path ? "" : `<p class="subtle">Loading files…</p>`
  const rows = listing.entries.map((entry) => {
    if (entry.kind === "file") {
      return `<button type="button" class="file-row${state.filePreview?.path === entry.path ? " selected" : ""}" data-preview-file="${escapeAttribute(entry.path)}" style="--file-indent:${depth * 14}px">${escapeHtml(entry.name)}</button>`
    }
    const expanded = state.expandedDirectories.has(entry.path)
    return `<div class="file-directory"><button type="button" class="file-row directory" data-toggle-directory="${escapeAttribute(entry.path)}" style="--file-indent:${depth * 14}px">${expanded ? "Hide" : "Show"} ${escapeHtml(entry.name)}</button>${expanded ? renderDirectory(entry.path, depth + 1) : ""}</div>`
  })
  const warning = listing.truncated ? `<p class="file-truncated">Only the first 500 items are shown.</p>` : ""
  return `<div class="file-branch">${rows.join("")}${warning}</div>`
}

function renderModels() {
  const previous = modelSelect.value
  modelSelect.replaceChildren()
  const choices = state.models.length ? state.models : state.model ? [state.model] : []
  for (const model of choices) {
    const option = document.createElement("option")
    option.value = model
    option.textContent = model
    option.selected = model === state.model
    modelSelect.append(option)
  }
  if (previous && choices.includes(previous)) modelSelect.value = previous
  modelSelect.disabled = state.runtime.status !== "ready" || !choices.length || Boolean(state.conversation.activeTurnId)
}

function renderStream() {
  const stickToBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
  const { conversation } = state
  if (!conversation.entries.length && !conversation.question) {
    messageStream.innerHTML = state.runtime.status === "ready"
      ? `<div class="stream-empty"><p>No messages yet.</p><p class="subtle">Ask Rind to inspect, change, or explain something in this workspace.</p></div>`
      : ""
  } else {
    messageStream.innerHTML = conversation.entries.map(renderEntry).join("") + renderQuestion() + renderWorking()
  }
  if (stickToBottom) {
    messageStream.scrollTop = messageStream.scrollHeight
    jumpLatest.hidden = true
  } else if (conversation.entries.length > lastRenderedEntries) {
    jumpLatest.hidden = false
  }
  lastRenderedEntries = conversation.entries.length
}

function renderEntry(entry: Entry): string {
  switch (entry.kind) {
    case "user":
      return `<article class="turn-user"><div class="user-bubble">${renderMarkdown(entry.content)}</div></article>`
    case "assistant":
      return `<article class="turn-assistant">${renderMarkdown(entry.content)}</article>`
    case "tool":
      return renderTool(entry)
    case "plan":
      return renderPlan(entry)
    case "file":
      return `<div class="ledger-row ledger-file"><span class="status-pip pip-done"></span><span class="ledger-verb">Edited</span><code class="ledger-arg">${escapeHtml(entry.filePath)}</code></div>`
    case "error":
      return `<div class="stream-card card-error"><div class="card-label">${escapeHtml(entry.source)}</div><div class="card-body">${escapeHtml(entry.content)}</div></div>`
    case "notice":
      return `<div class="stream-card card-notice"><div class="card-label">${escapeHtml(entry.label)}</div><div class="card-body">${escapeHtml(entry.content)}</div></div>`
  }
}

function renderTool(tool: ToolEntry): string {
  const open = state.expandedTools.has(tool.id)
  const pip = tool.status === "running" || tool.status === "pending"
    ? "pip-running"
    : tool.status === "error" ? "pip-error" : "pip-done"
  const duration = formatDuration(tool.durationMs)
  const body = renderToolDetails(tool)
  return `
    <div class="ledger-row${open ? " open" : ""}" data-tool-id="${escapeAttribute(tool.id)}">
      <button type="button" class="ledger-trigger" data-toggle-tool="${escapeAttribute(tool.id)}" ${body ? "" : "disabled"}>
        <span class="status-pip ${pip}"></span>
        <span class="ledger-verb">${escapeHtml(tool.toolName)}</span>
        ${tool.argsPreview ? `<code class="ledger-arg">${escapeHtml(tool.argsPreview)}</code>` : ""}
        ${tool.errorType ? `<span class="ledger-error">${escapeHtml(tool.errorType)}</span>` : ""}
        ${duration ? `<span class="ledger-duration">${duration}</span>` : ""}
        ${body ? `<span class="ledger-chevron" aria-hidden="true"></span>` : ""}
      </button>
      ${open && body ? body : ""}
    </div>
  `
}

function renderToolDetails(tool: ToolEntry): string {
  const inputs = Object.entries(tool.arguments).map(([key, value]) => `
    <div class="tool-detail-row"><span>${escapeHtml(key)}</span>${renderToolValue(value)}</div>
  `).join("")
  const result = tool.result
  const outcome = result?.ok === false
    ? `<section class="tool-detail-section tool-detail-error"><strong>${escapeHtml(result.error || "Tool failed")}</strong>${result.errorType ? `<small>${escapeHtml(result.errorType)}</small>` : ""}</section>`
    : result?.ok === true && result.data !== undefined
      ? `<section class="tool-detail-section"><span>Result</span>${renderToolValue(result.data)}</section>`
      : ""
  const meta = result && Object.keys(result.meta).length
    ? `<section class="tool-detail-section"><span>Details</span>${renderToolValue(result.meta)}</section>`
    : ""
  const fallback = !result || result.ok === null
    ? (tool.output ? `<pre class="ledger-output"><code>${escapeHtml(tool.output)}</code></pre>` : "")
    : ""
  const error = !result?.error && tool.errorType
    ? `<section class="tool-detail-section tool-detail-error"><strong>${escapeHtml(tool.errorType)}</strong></section>`
    : ""
  const content = inputs || outcome || meta || fallback || error
  return content ? `<div class="tool-details">${inputs ? `<section class="tool-detail-section"><span>Input</span>${inputs}</section>` : ""}${outcome}${error}${meta}${fallback}</div>` : ""
}

function renderToolValue(value: unknown): string {
  if (value === null || value === undefined) return `<code class="tool-detail-value">None</code>`
  if (typeof value === "string") return `<code class="tool-detail-value">${escapeHtml(value)}</code>`
  if (typeof value === "number" || typeof value === "boolean") return `<code class="tool-detail-value">${escapeHtml(String(value))}</code>`
  if (Array.isArray(value)) return `<span class="tool-detail-value">${value.map(renderToolValue).join("")}</span>`
  return `<span class="tool-detail-value">${Object.entries(asRecord(value)).map(([key, item]) => `<span class="tool-detail-row"><span>${escapeHtml(key)}</span>${renderToolValue(item)}</span>`).join("")}</span>`
}

function renderPlan(plan: PlanEntry): string {
  const pip = plan.status === "error" ? "pip-error" : plan.status === "running" || plan.status === "pending" ? "pip-running" : "pip-done"
  const duration = formatDuration(plan.durationMs)
  return `
    <article class="plan-card${plan.status === "error" ? " plan-error" : ""}">
      <div class="plan-card-head"><span class="status-pip ${pip}"></span><strong>Plan</strong>${duration ? `<span>${escapeHtml(duration)}</span>` : ""}</div>
      <ol class="plan-steps">${plan.steps.map((step) => `<li class="plan-step plan-${escapeAttribute(step.status)}"><span aria-hidden="true"></span><span>${escapeHtml(step.step)}</span></li>`).join("")}</ol>
      ${plan.error ? `<p class="plan-error-text">${escapeHtml(plan.error)}</p>` : ""}
    </article>
  `
}

function renderQuestion(): string {
  const question = state.conversation.question
  if (!question) return ""
  return `
    <div class="stream-card card-question">
      <div class="card-label">Rind asks</div>
      <div class="question-text">${escapeHtml(question.question)}</div>
      <div class="question-options">${question.options.map((option) => `
        <button type="button" class="question-option${option === question.recommended ? " recommended" : ""}" data-answer="${escapeAttribute(option)}">${escapeHtml(option)}</button>
      `).join("")}</div>
      <form id="question-form" class="question-form">
        <input id="question-answer" aria-label="Your answer" autocomplete="off" placeholder="Type your own answer" />
        <button type="submit" class="primary-button">Answer</button>
      </form>
    </div>
  `
}

function renderWorking(): string {
  const { conversation } = state
  if (!conversation.activeTurnId) return ""
  const elapsed = conversation.turnStartedAt ? Math.max(0, Math.round((Date.now() - conversation.turnStartedAt) / 1000)) : 0
  return `<div class="working"><span class="status-pip pip-running"></span><span id="working-label">Working… ${elapsed}s</span></div>`
}

function syncWorkingTimer() {
  const active = Boolean(state.conversation.activeTurnId)
  if (active && !workingTimer) {
    workingTimer = setInterval(() => {
      const label = document.getElementById("working-label")
      const started = state.conversation.turnStartedAt
      if (label && started) label.textContent = `Working… ${Math.max(0, Math.round((Date.now() - started) / 1000))}s`
    }, 1000)
  }
  if (!active && workingTimer) {
    clearInterval(workingTimer)
    workingTimer = undefined
  }
}

function renderComposer() {
  const ready = state.runtime.status === "ready" && activeProject()?.available === true
  const active = Boolean(state.conversation.activeTurnId)
  prompt.disabled = !ready
  send.disabled = !ready
  send.textContent = active ? "Queue" : "Send"
  send.title = active ? "Queue as follow-up for the running turn" : "Send message"
  steer.disabled = !ready || !active
  interrupt.disabled = !ready || !active
  const percent = state.conversation.contextUsagePercent
  contextMeter.hidden = percent === null
  contextMeter.textContent = percent === null ? "" : `${Math.round(percent * 100)}% ctx`
  contextMeter.classList.toggle("context-hot", percent !== null && percent >= 0.8)
}

function renderMarkdown(value: string): string {
  const chunks = value.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g)
  const parts: string[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    if (index % 3 === 0) {
      parts.push(renderInline(chunks[index]))
    } else if (index % 3 === 2) {
      const language = chunks[index - 1]
      const code = chunks[index]
      parts.push(`<pre><div class="code-head"><span>${escapeHtml(language || "code")}</span><button class="copy-code" type="button" data-copy="${escapeAttribute(code)}">Copy</button></div><code>${escapeHtml(code)}</code></pre>`)
    }
  }
  return parts.join("")
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, "<br>")
}

function titleCase(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character)
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/\n/g, "&#10;")
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

async function request(method: RuntimeMethod, params: Record<string, unknown> = {}) {
  try {
    return await window.api.runtime.request(method, params)
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
    render()
    throw error
  }
}

function runAction(action: () => Promise<unknown>) {
  void action().catch((error) => {
    state.notice = error instanceof Error ? error.message : String(error)
    render()
  })
}

async function loadSessions() {
  applyOverview(await window.api.projects.get())
}

function applyOverview(overview: Awaited<ReturnType<typeof window.api.projects.get>>) {
  const nextPages: Record<string, DesktopSessionSummary[]> = {}
  const nextTotals: Record<string, number> = {}
  for (const project of overview.projects) {
    nextPages[project.path] = mergeSessions(project.sessions, state.sessionPages[project.path] || [])
    nextTotals[project.path] = project.totalSessions
  }
  state.projects = overview.projects
  state.activeProjectPath = overview.activeProjectPath
  state.sidebarOpen = overview.sidebarOpen
  state.sidebarWidth = overview.sidebarWidth
  state.filesOpen = overview.filesOpen
  state.fileTreeWidth = overview.fileTreeWidth
  state.filePreviewWidth = overview.filePreviewWidth
  state.sessionPages = nextPages
  state.sessionTotals = nextTotals
  if (state.activeProjectPath) state.expandedProjects.add(state.activeProjectPath)
}

function mergeSessions(primary: DesktopSessionSummary[], secondary: DesktopSessionSummary[]) {
  const sessions = new Map<string, DesktopSessionSummary>()
  for (const session of [...primary, ...secondary]) sessions.set(session.id, session)
  return [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

async function loadReplay() {
  const result = asRecord(await request("session.replay"))
  const messages = Array.isArray(result.messages) ? result.messages : []
  state.conversation = conversationFromReplay(messages)
  state.expandedTools = new Set()
  const turnState = asRecord(result.turn_state)
  if (turnState.status === "running" && typeof turnState.turn_id === "string") {
    state.conversation = { ...state.conversation, activeTurnId: turnState.turn_id, turnStartedAt: Date.now() }
  }
}

async function loadModels() {
  try {
    const result = asRecord(await request("models.list"))
    state.models = Array.isArray(result.models) ? result.models.filter((model): model is string => typeof model === "string") : []
    state.model = typeof result.current_model === "string" ? result.current_model : state.model
  } catch {
    state.models = state.model ? [state.model] : []
  }
}

async function loadSettings() {
  try {
    state.settings = await window.api.settings.get()
    if (!state.settings.hasApiKey && !state.settingsAutoOpened) {
      state.settingsAutoOpened = true
      state.notice = "Configure the shared ~/.rind/settings.json before using the runtime."
      openSettings()
    } else {
      render()
    }
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
    render()
  }
}

async function refreshSession() {
  await Promise.all([loadSessions(), loadReplay(), loadModels()])
  state.notice = ""
  render()
}

async function bootstrap(result: unknown) {
  const initialize = asRecord(result)
  state.sessionId = typeof initialize.session_id === "string" ? initialize.session_id : state.sessionId
  state.model = typeof initialize.model === "string" ? initialize.model : state.model
  await refreshSession()
  if (state.filesOpen && activeProject()?.available) await loadDirectory("")
  if (state.createDraftWhenReady) {
    state.createDraftWhenReady = false
    await createSession()
  }
}

function handleRuntimeEvent(envelope: RuntimeEvent) {
  if (envelope.sessionId && envelope.sessionId !== state.sessionId) {
    state.sessionId = envelope.sessionId
    runAction(loadSessions)
  }
  state.conversation = reduceEvent(state.conversation, envelope)
  if (envelope.type === "turn_completed" || envelope.type === "turn_failed" || envelope.type === "turn_cancelled") {
    runAction(async () => { await loadSessions(); render() })
  }
  render()
}

function autoGrowPrompt() {
  const style = window.getComputedStyle(prompt)
  const lineHeight = Number.parseFloat(style.lineHeight) || 21
  const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  const minimum = lineHeight * 2 + verticalPadding
  const maximum = lineHeight * 7 + verticalPadding
  prompt.style.height = "auto"
  prompt.style.height = `${Math.max(minimum, Math.min(prompt.scrollHeight, maximum))}px`
  prompt.style.overflowY = prompt.scrollHeight > maximum ? "auto" : "hidden"
}

requiredElement<HTMLFormElement>("composer").addEventListener("submit", (event) => { event.preventDefault(); runAction(sendPrompt) })

prompt.addEventListener("input", () => {
  if (state.activeProjectPath) state.drafts[state.activeProjectPath] = prompt.value
  autoGrowPrompt()
})
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    runAction(sendPrompt)
  }
})
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.conversation.activeTurnId && !state.settingsOpen) {
    runAction(() => request("turn.interrupt"))
  }
})

async function sendPrompt() {
  const input = prompt.value.trim()
  if (!input) return
  if (!state.activeProjectPath) {
    state.notice = "Choose a project before sending a message."
    render()
    return
  }
  prompt.value = ""
  state.drafts[state.activeProjectPath] = ""
  autoGrowPrompt()
  if (input.startsWith("/")) {
    runAction(() => runSlash(input))
    return
  }
  const active = Boolean(state.conversation.activeTurnId)
  state.conversation = addUserMessage(state.conversation, input)
  render()
  const result = asRecord(await request(active ? "turn.follow_up" : "turn.start", { input }))
  if (typeof result.session_id === "string" && result.session_id) {
    state.sessionId = result.session_id
    await loadSessions()
  }
  render()
}

async function runSlash(input: string) {
  const result = asRecord(await request("slash.execute", { input }))
  const text = asRecordText(result.text)
  if (text) {
    state.conversation = {
      ...state.conversation,
      entries: [...state.conversation.entries, { kind: "notice", id: `slash-${Date.now()}`, label: input, content: text }],
    }
  }
  const prefill = typeof result.input_prefill === "string" ? result.input_prefill : ""
  if (prefill) {
    prompt.value = prefill
    autoGrowPrompt()
    prompt.focus()
  }
  const followUp = typeof result.run_turn_input === "string" ? result.run_turn_input.trim() : ""
  if (followUp) {
    state.conversation = addUserMessage(state.conversation, followUp)
    const turn = asRecord(await request("turn.start", { input: followUp }))
    if (typeof turn.session_id === "string" && turn.session_id) state.sessionId = turn.session_id
  }
  render()
}

function asRecordText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

steer.addEventListener("click", () => {
  const input = prompt.value.trim()
  if (!input) return
  prompt.value = ""
  if (state.activeProjectPath) state.drafts[state.activeProjectPath] = ""
  autoGrowPrompt()
  runAction(() => request("turn.steer", { input }))
})
interrupt.addEventListener("click", () => runAction(() => request("turn.interrupt")))
retry.addEventListener("click", () => runAction(window.api.runtime.restart))
jumpLatest.addEventListener("click", () => {
  messageStream.scrollTop = messageStream.scrollHeight
  jumpLatest.hidden = true
})
messageStream.addEventListener("scroll", () => {
  const nearBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
  if (nearBottom) jumpLatest.hidden = true
})
requiredElement("add-project").addEventListener("click", () => runAction(addProject))
requiredElement("sidebar-add-project").addEventListener("click", () => runAction(addProject))
requiredElement("open-settings").addEventListener("click", () => openSettings())
requiredElement("new-session").addEventListener("click", () => runAction(startNewChat))
sidebarToggle.addEventListener("click", () => runAction(toggleSidebar))
requiredElement("close-files").addEventListener("click", () => runAction(() => setFilesOpen(false)))
filesToggle.addEventListener("click", () => runAction(() => setFilesOpen(!state.filesOpen)))
requiredElement("compact").addEventListener("click", () => runAction(() => request("compact")))
modelSelect.addEventListener("change", () => {
  const model = modelSelect.value
  if (!model) return
  runAction(async () => {
    await request("model.set", { model })
    state.model = model
    render()
  })
})
settingsForm.addEventListener("submit", (event) => { event.preventDefault(); runAction(saveSettings) })
requiredElement("close-settings").addEventListener("click", () => { state.settingsOpen = false; render() })
requiredElement("cancel-settings").addEventListener("click", () => { state.settingsOpen = false; render() })
settingsDialog.addEventListener("cancel", () => { state.settingsOpen = false; render() })
projectSelect.addEventListener("change", () => {
  if (projectSelect.value) runAction(() => selectProject(projectSelect.value))
})
projectList.addEventListener("click", (event) => {
  const target = event.target as HTMLElement
  const projectPath = target.closest<HTMLButtonElement>("[data-project-path]")?.dataset.projectPath
  if (projectPath) {
    runAction(() => selectProject(projectPath))
    return
  }
  const removeProjectPath = target.closest<HTMLButtonElement>("[data-remove-project]")?.dataset.removeProject
  if (removeProjectPath) {
    runAction(() => removeProject(removeProjectPath))
    return
  }
  const moreProjectPath = target.closest<HTMLButtonElement>("[data-show-more]")?.dataset.showMore
  if (moreProjectPath) {
    runAction(() => loadMoreSessions(moreProjectPath))
    return
  }
  const sessionButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-session-id]")
  const nextSessionId = sessionButton?.dataset.sessionId
  if (nextSessionId) runAction(() => switchSession(nextSessionId))
})
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
startResize(filePreviewResizeHandle, "preview")
messageStream.addEventListener("click", (event) => {
  const target = event.target as HTMLElement
  const toggle = target.closest<HTMLButtonElement>("[data-toggle-tool]")
  if (toggle?.dataset.toggleTool) {
    const id = toggle.dataset.toggleTool
    const next = new Set(state.expandedTools)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    state.expandedTools = next
    render()
    return
  }
  const copy = target.closest<HTMLButtonElement>(".copy-code")
  if (copy?.dataset.copy) {
    runAction(() => navigator.clipboard.writeText(copy.dataset.copy || ""))
    return
  }
  const answer = target.closest<HTMLButtonElement>("[data-answer]")?.dataset.answer
  if (answer) runAction(() => answerQuestion(answer))
})
messageStream.addEventListener("submit", (event) => {
  event.preventDefault()
  if ((event.target as HTMLElement).id !== "question-form") return
  const input = requiredElement<HTMLInputElement>("question-answer").value.trim()
  if (input) runAction(() => answerQuestion(input))
})

function openSettings() {
  state.settingsOpen = true
  settingsApiKey.value = ""
  settingsBaseUrl.value = state.settings.baseUrl
  settingsModel.value = state.settings.model
  settingsReasoning.value = state.settings.reasoningEffort
  render()
}

function resetProjectView() {
  state.sessionId = ""
  state.conversation = createConversation()
  state.expandedTools = new Set()
  state.expandedDirectories = new Set([""])
  state.fileListings = {}
  state.filePreview = undefined
  lastRenderedEntries = 0
}

function restoreProjectDraft() {
  prompt.value = state.drafts[state.activeProjectPath] || ""
  autoGrowPrompt()
}

async function addProject(createDraft = false) {
  const overview = await window.api.projects.add()
  if (!overview) return
  applyOverview(overview)
  resetProjectView()
  state.createDraftWhenReady = createDraft
  restoreProjectDraft()
  state.notice = createDraft ? "Project added. Preparing a new chat..." : "Project added."
  render()
  if (state.filesOpen) await loadDirectory("")
}

async function selectProject(path: string) {
  if (path === state.activeProjectPath) {
    state.expandedProjects.add(path)
    render()
    return
  }
  if (state.conversation.activeTurnId) {
    state.notice = "Stop the active turn before changing projects."
    render()
    return
  }
  if (state.activeProjectPath) state.drafts[state.activeProjectPath] = prompt.value
  const overview = await window.api.projects.select(path)
  applyOverview(overview)
  resetProjectView()
  restoreProjectDraft()
  state.notice = "Switching project..."
  render()
  if (state.filesOpen) await loadDirectory("")
}

async function removeProject(path: string) {
  const project = state.projects.find((item) => item.path === path)
  if (!project) return
  if (state.conversation.activeTurnId && path === state.activeProjectPath) {
    state.notice = "Stop the active turn before removing its project."
    render()
    return
  }
  if (!window.confirm(`Remove ${project.name} from Rind Desktop? Its folder and sessions will be kept.`)) return
  const wasActive = path === state.activeProjectPath
  const overview = await window.api.projects.remove(path)
  applyOverview(overview)
  delete state.drafts[path]
  if (wasActive) {
    resetProjectView()
    restoreProjectDraft()
    if (!activeProject()?.available && state.filesOpen) {
      applyOverview(await window.api.projects.updateLayout({ filesOpen: false }))
    }
  }
  state.notice = "Project removed from Desktop."
  render()
  if (state.filesOpen && activeProject()?.available) await loadDirectory("")
}

async function startNewChat() {
  const project = activeProject()
  if (!project?.available) {
    await addProject(true)
    return
  }
  if (state.conversation.activeTurnId) {
    state.notice = "Stop the active turn before starting a new chat."
    render()
    return
  }
  if (state.runtime.status !== "ready") {
    state.createDraftWhenReady = true
    state.notice = "The new chat will open when the runtime is ready."
    render()
    return
  }
  await createSession()
}

async function toggleSidebar() {
  applyOverview(await window.api.projects.updateLayout({ sidebarOpen: !state.sidebarOpen }))
  render()
}

async function setFilesOpen(open: boolean) {
  if (open && !activeProject()?.available) {
    state.notice = "Choose an available project before browsing files."
    render()
    return
  }
  applyOverview(await window.api.projects.updateLayout({ filesOpen: open }))
  render()
  if (open) await loadDirectory("")
}

async function loadMoreSessions(path: string) {
  const loaded = state.sessionPages[path] || []
  const result = await window.api.projects.sessions(path, loaded.length, 20)
  state.sessionPages[path] = mergeSessions(loaded, result.sessions)
  state.sessionTotals[path] = result.total
  render()
}

async function loadDirectory(path: string) {
  const listing = await window.api.files.list(path)
  state.fileListings = { ...state.fileListings, [path]: listing }
  render()
}

async function toggleDirectory(path: string) {
  const expanded = new Set(state.expandedDirectories)
  if (expanded.has(path)) {
    expanded.delete(path)
  } else {
    expanded.add(path)
    if (!state.fileListings[path]) await loadDirectory(path)
  }
  state.expandedDirectories = expanded
  render()
}

async function previewFile(path: string) {
  state.filePreview = await window.api.files.preview(path)
  render()
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

async function createSession() {
  if (!activeProject()?.available || state.runtime.status !== "ready") return
  const result = asRecord(await request("session.new"))
  state.sessionId = String(result.session_id || "")
  state.model = String(result.model || state.model)
  state.conversation = createConversation()
  state.expandedTools = new Set()
  await refreshSession()
}

function usesWideFileLayout() {
  if (!state.filesOpen || !state.filePreview || window.innerWidth < 1180) return false
  const sidebarWidth = state.sidebarOpen ? state.sidebarWidth : 0
  return window.innerWidth - sidebarWidth - state.fileTreeWidth - state.filePreviewWidth - 8 >= 440
}

function startResize(handle: HTMLElement, target: "sidebar" | "files" | "preview") {
  handle.addEventListener("pointerdown", (event) => {
    if ((target === "sidebar" && !state.sidebarOpen) || (target !== "sidebar" && !state.filesOpen)) return
    if (target === "preview" && !usesWideFileLayout()) return
    const width = target === "sidebar" ? state.sidebarWidth : target === "files" ? (usesWideFileLayout() ? state.filePreviewWidth + state.fileTreeWidth : state.fileTreeWidth) : state.filePreviewWidth
    resizeStart = { target, pointerId: event.pointerId, x: event.clientX, width, lastWidth: width, wideFiles: usesWideFileLayout() }
    handle.setPointerCapture(event.pointerId)
    document.body.classList.add("resizing-panel")
    event.preventDefault()
  })
  handle.addEventListener("pointermove", (event) => {
    if (!resizeStart || resizeStart.target !== target || resizeStart.pointerId !== event.pointerId) return
    const delta = target === "sidebar" || target === "preview" ? event.clientX - resizeStart.x : resizeStart.x - event.clientX
    const width = Math.round(resizeStart.width + delta)
    resizeStart.lastWidth = width
    if (target === "sidebar") state.sidebarWidth = Math.max(0, Math.min(420, width))
    else if (target === "preview") state.filePreviewWidth = Math.max(0, Math.min(760, width))
    else if (resizeStart.wideFiles) state.filePreviewWidth = Math.max(320, Math.min(760, width - state.fileTreeWidth))
    else state.fileTreeWidth = Math.max(0, Math.min(420, width))
    render()
  })
  handle.addEventListener("pointerup", (event) => finishResize(handle, event))
  handle.addEventListener("lostpointercapture", () => { resizeStart = undefined; document.body.classList.remove("resizing-panel") })
}

function finishResize(handle: HTMLElement, event: PointerEvent) {
  if (!resizeStart || resizeStart.pointerId !== event.pointerId) return
  const { target, wideFiles, lastWidth } = resizeStart
  handle.releasePointerCapture(event.pointerId)
  resizeStart = undefined
  document.body.classList.remove("resizing-panel")
  runAction(async () => {
    if (target === "sidebar") {
      const sidebarOpen = state.sidebarWidth >= 160
      state.sidebarWidth = Math.max(180, state.sidebarWidth || 248)
      applyOverview(await window.api.projects.updateLayout({ sidebarOpen, sidebarWidth: state.sidebarWidth }))
    } else if (target === "preview") {
      state.filePreviewWidth = Math.max(320, state.filePreviewWidth || 420)
      applyOverview(await window.api.projects.updateLayout({ filePreviewWidth: state.filePreviewWidth }))
    } else {
      const requestedPreviewWidth = wideFiles ? lastWidth - state.fileTreeWidth : 0
      const currentWidth = wideFiles ? requestedPreviewWidth + state.fileTreeWidth : state.fileTreeWidth
      const filesOpen = wideFiles && requestedPreviewWidth < 160 ? true : currentWidth >= 160
      if (wideFiles && requestedPreviewWidth < 160) {
        state.filePreview = undefined
        state.filePreviewWidth = 420
      } else if (wideFiles) state.filePreviewWidth = Math.max(320, state.filePreviewWidth || 420)
      else state.fileTreeWidth = Math.max(180, state.fileTreeWidth || 240)
      applyOverview(await window.api.projects.updateLayout({ filesOpen, fileTreeWidth: state.fileTreeWidth, filePreviewWidth: state.filePreviewWidth }))
    }
    render()
  })
}

window.addEventListener("resize", () => render())

async function switchSession(nextSessionId: string) {
  if (nextSessionId === state.sessionId || state.conversation.activeTurnId) return
  const project = activeProject()
  if (!project || !projectSessions(project).some((session) => session.id === nextSessionId)) return
  const result = asRecord(await request("session.switch", { session_id: nextSessionId }))
  state.sessionId = String(result.session_id || nextSessionId)
  state.model = String(result.model || state.model)
  state.expandedTools = new Set()
  await refreshSession()
}

async function answerQuestion(answer: string) {
  const question = state.conversation.question
  if (!question) return
  state.conversation = { ...state.conversation, question: undefined }
  render()
  await request("user_question.respond", { tool_call_id: question.toolCallId, answer })
}

async function saveSettings() {
  const apiKey = settingsApiKey.value.trim()
  if (!state.settings.hasApiKey && !apiKey) {
    state.notice = "Enter an API key to start the runtime."
    render()
    settingsApiKey.focus()
    return
  }
  state.settingsSaving = true
  state.notice = "Saving settings and restarting the runtime..."
  render()
  try {
    state.settings = await window.api.settings.save({
      ...(apiKey ? { apiKey } : {}),
      model: settingsModel.value.trim(),
      baseUrl: settingsBaseUrl.value.trim(),
      reasoningEffort: settingsReasoning.value.trim(),
    })
    state.settingsOpen = false
    state.settingsAutoOpened = true
    state.notice = "Settings saved."
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    state.settingsSaving = false
    render()
  }
}

const unsubscribeStatus = window.api.runtime.subscribe((snapshot) => {
  state.runtime = snapshot
  if (snapshot.status === "starting") {
    resetProjectView()
    state.bootstrapped = false
    state.notice = "Starting runtime..."
  }
  if (snapshot.status === "error") {
    state.notice = snapshot.message || "Runtime is unavailable."
    if (!state.settingsAutoOpened && snapshot.message?.includes("Configuration error")) {
      state.settingsAutoOpened = true
      openSettings()
      return
    }
  }
  render()
  if (snapshot.status === "ready" && !state.bootstrapped) {
    state.bootstrapped = true
    void window.api.runtime.initialize().then(bootstrap).catch(() => { state.bootstrapped = false; render() })
  }
})
const unsubscribeEvents = window.api.runtime.subscribeEvents(handleRuntimeEvent)
window.addEventListener("beforeunload", () => { unsubscribeStatus(); unsubscribeEvents() }, { once: true })
if (state.runtime.status !== "stopped") {
  state.bootstrapped = true
  void window.api.runtime.initialize().then(bootstrap).catch(() => { state.bootstrapped = false; render() })
}
runAction(async () => {
  await loadSessions()
  render()
  if (state.filesOpen && activeProject()?.available) await loadDirectory("")
})
void loadSettings()
