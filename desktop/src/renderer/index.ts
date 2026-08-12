import "./style.css"
import brandMarkUrl from "./assets/brand-mark.svg"

import {
  composerRegionMarkup,
  dismissPlanError,
  renderComposer,
  renderPlanDock,
  type PlanDockPresentation,
} from "./composer-region"

import type {
  DesktopFileListing,
  DesktopFilePreview,
  DesktopProject,
  DesktopRecentSession,
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
  fileMutationPreview,
  formatDuration,
  reduceEvent,
  relativeTime,
  type ConversationState,
  type Entry,
  type ToolEntry,
} from "./timeline-model"
import { renderMarkdown } from "./markdown"
import { highlightFile } from "./syntax-highlight"

type AppState = {
  runtime: RuntimeSnapshot
  settings: DesktopSettings
  settingsOpen: boolean
  settingsSaving: boolean
  settingsAutoOpened: boolean
  runtimeWorkers: Record<string, RuntimeSnapshot>
  runtimeSessionIds: Record<string, string>
  runtimeTurnPending: Record<string, boolean>
  runtimeStarting: Record<string, boolean>
  viewedSessionId: string
  viewedProjectPath: string
  chatProjectPath: string
  viewedRuntimeId: string
  draftRuntimeIds: Record<string, string>
  conversationCache: Record<string, ConversationState>
  model: string
  models: string[]
  projects: DesktopProject[]
  recentSessions: DesktopRecentSession[]
  pendingRecentSessionIds: Set<string>
  sessionPages: Record<string, DesktopSessionSummary[]>
  sessionTotals: Record<string, number>
  sidebarOpen: boolean
  sidebarWidth: number
  filesOpen: boolean
  filePanelWidth: number
  expandedProjects: Set<string>
  expandedDirectories: Set<string>
  fileListings: Record<string, DesktopFileListing>
  filePreview?: DesktopFilePreview
  drafts: Record<string, string>
  conversation: ConversationState
  expandedTools: Set<string>
  revealedTools: Set<string>
  planDock: PlanDockPresentation
  composerMenuOpen: boolean
  notice: string
}

const root = document.querySelector<HTMLElement>("#app")
if (!root) throw new Error("Renderer root is missing.")
const appRoot: HTMLElement = root
document.body.dataset.platform = window.api.platform

const state: AppState = {
  runtime: { status: "stopped" },
  settings: { model: "", baseUrl: "", reasoningEffort: "", hasApiKey: false },
  settingsOpen: false,
  settingsSaving: false,
  settingsAutoOpened: false,
  runtimeWorkers: {},
  runtimeSessionIds: {},
  runtimeTurnPending: {},
  runtimeStarting: {},
  viewedSessionId: "",
  viewedProjectPath: "",
  chatProjectPath: "",
  viewedRuntimeId: "",
  draftRuntimeIds: {},
  conversationCache: {},
  model: "",
  models: [],
  projects: [],
  recentSessions: [],
  pendingRecentSessionIds: new Set(),
  sessionPages: {},
  sessionTotals: {},
  sidebarOpen: true,
  sidebarWidth: 248,
  filesOpen: false,
  filePanelWidth: 480,
  expandedProjects: new Set(),
  expandedDirectories: new Set([""]),
  fileListings: {},
  drafts: {},
  conversation: createConversation(),
  expandedTools: new Set(),
  revealedTools: new Set(),
  planDock: { collapsed: false, displayedPlanId: "", dismissedPlanErrors: new Set() },
  composerMenuOpen: false,
  notice: "",
}

appRoot.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="identity">
        <div class="brand-group">
          <img class="brand-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" />
          <span class="brand">Rind</span>
        </div>
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
        <div class="sidebar-body">
          <section id="recent-sessions" class="recent-sessions" hidden>
            <div class="sidebar-heading"><span>Recent</span></div>
            <div id="recent-list" class="recent-list"></div>
          </section>
          <div class="sidebar-heading"><span>Projects</span><button id="sidebar-add-project" type="button" class="ghost-button" title="Add project">Add</button></div>
          <div id="project-list" class="project-list"></div>
        </div>
      </aside>
      <section class="conversation">
        <div class="conversation-head">
          <div class="conversation-title"><strong id="session-title">New session</strong><span id="session-id" class="subtle"></span></div>
          <div class="conversation-actions"><button id="toggle-sidebar" type="button" class="ghost-button" title="Toggle projects sidebar" aria-label="Toggle projects sidebar">Projects</button><button id="toggle-files" type="button" class="ghost-button" title="Browse active project files">Files</button></div>
        </div>
        <div id="notice" class="notice" role="status" hidden><span id="notice-text"></span><button id="retry" type="button" class="ghost-button" hidden>Retry</button></div>
        <div class="stream-wrap">
          <div id="message-stream" class="message-stream" aria-live="polite"></div>
          <button id="jump-latest" type="button" class="jump-latest" hidden>Jump to latest</button>
        </div>
        ${composerRegionMarkup()}
      </section>
      <aside id="file-panel" class="file-panel" aria-label="Project files">
        <div id="file-resize-handle" class="file-resize-handle" role="separator" aria-label="Resize file panel" aria-orientation="vertical"></div>
        <div class="file-panel-head"><strong>Files</strong><button id="close-files" type="button" class="ghost-button" title="Close files">Close</button></div>
        <div class="file-workspace">
          <section id="file-preview" class="file-preview"><p class="subtle">Select a file to preview.</p></section>
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
const recentSessions = requiredElement("recent-sessions")
const recentList = requiredElement("recent-list")
const sessionTitle = requiredElement("session-title")
const sessionIdLabel = requiredElement("session-id")
const modelSelect = requiredElement<HTMLSelectElement>("model-select")
const messageStream = requiredElement("message-stream")
const jumpLatest = requiredElement<HTMLButtonElement>("jump-latest")
const planDockShell = requiredElement("plan-dock-shell")
const planDock = requiredElement("plan-dock")
const notice = requiredElement("notice")
const noticeText = requiredElement("notice-text")
const retry = requiredElement<HTMLButtonElement>("retry")
const contextMeter = requiredElement("context-meter")
const prompt = requiredElement<HTMLTextAreaElement>("prompt")
const send = requiredElement<HTMLButtonElement>("send")
const steer = requiredElement<HTMLButtonElement>("steer")
const interrupt = requiredElement<HTMLButtonElement>("interrupt")
const composerMenuTrigger = requiredElement<HTMLButtonElement>("composer-menu-trigger")
const composerMenu = requiredElement("composer-menu")
const compactContext = requiredElement<HTMLButtonElement>("compact-context")
const sidebar = requiredElement("sidebar")
const sidebarResizeHandle = requiredElement("sidebar-resize-handle")
const filePanel = requiredElement("file-panel")
const fileResizeHandle = requiredElement("file-resize-handle")
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
let toolPinSequence = 0
let renderFrame: number | undefined
let renderTimer: ReturnType<typeof setTimeout> | undefined
let toolAnimationUntil = 0
const toolOpenRequests = new Map<string, number>()
let resizeStart: { target: "sidebar" | "files"; pointerId: number; x: number; width: number; lastWidth: number } | undefined

function requiredElement<T extends HTMLElement = HTMLElement>(id: string) {
  const element = document.getElementById(id) as T | null
  if (!element) throw new Error(`Missing ${id}.`)
  return element
}

function render() {
  const runtime = currentRuntimeSnapshot()
  const runtimeId = currentRuntimeId()
  state.runtime = runtime
  const { conversation } = state
  const wideFiles = usesWideFileLayout()
  const filesWidth = state.filesOpen ? state.filePanelWidth : 0
  connectionText.textContent = runtimeStatusLabel(runtime.status)
  connection.className = `connection connection-${runtime.status}`
  connection.hidden = Boolean(state.runtimeStarting[runtimeId])
  appRoot.classList.toggle("sidebar-open", state.sidebarOpen)
  appRoot.classList.toggle("files-open", state.filesOpen)
  appRoot.classList.toggle("files-wide", wideFiles)
  appRoot.classList.toggle("file-preview-open", Boolean(state.filePreview))
  appRoot.style.setProperty("--sidebar-panel-width", `${state.sidebarOpen ? state.sidebarWidth : 0}px`)
  appRoot.style.setProperty("--files-panel-width", `${filesWidth}px`)
  sidebar.setAttribute("aria-hidden", String(!state.sidebarOpen))
  sidebar.inert = !state.sidebarOpen
  filePanel.setAttribute("aria-hidden", String(!state.filesOpen))
  filePanel.inert = !state.filesOpen
  newSessionButton.title = chatProject()?.available ? `Start a new chat in ${chatProject()?.name}` : "Choose a project for a new chat"
  sidebarToggle.textContent = state.sidebarOpen ? "Hide projects" : "Projects"
  sidebarToggle.title = state.sidebarOpen ? "Hide projects sidebar" : "Show projects sidebar"
  workspacePath.textContent = viewedProject()?.path || "No project selected"
  workspacePath.title = viewedProject()?.path || ""
  const current = knownSessions().find((item) => item.id === state.viewedSessionId)
  sessionTitle.textContent = current?.title || (state.viewedSessionId ? "Session" : "New session")
  sessionIdLabel.textContent = state.viewedSessionId || ""
  noticeText.textContent = state.notice || runtime.message || ""
  retry.hidden = !currentRuntimeId() || runtime.status !== "error"
  notice.hidden = !noticeText.textContent && retry.hidden
  renderProjectControl()
  renderRecentSessions()
  renderProjects()
  renderModels()
  renderPlanDock(
    { shell: planDockShell, dock: planDock },
    state.conversation,
    state.viewedSessionId,
    state.planDock,
  )
  renderStream()
  renderComposer(
    { prompt, send, steer, interrupt, menuTrigger: composerMenuTrigger, menu: composerMenu, compactContext, contextMeter },
    {
      ready: chatProject()?.available === true && state.settings.hasApiKey,
      active: runtimeTurnActive(),
      readOnly: false,
      starting: Boolean(state.runtimeStarting[runtimeId]),
      controllingTurn: Boolean(runtimeConversation().activeTurnId),
      runtimeSessionId: state.viewedSessionId,
      composerMenuOpen: state.composerMenuOpen,
      contextUsagePercent: state.conversation.contextUsagePercent,
    },
  )
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
  return viewedProject()
}

function viewedProject() {
  return projectForPath(state.viewedProjectPath)
}

function chatProject() {
  return projectForPath(state.chatProjectPath)
}

function projectForPath(path: string) {
  return state.projects.find((project) => samePath(project.path, path))
}

function samePath(left: string, right: string) {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  const normalizedLeft = normalize(left)
  const normalizedRight = normalize(right)
  const isWindowsPath = /^[A-Za-z]:\//.test(normalizedLeft) || normalizedLeft.startsWith("//")
  return isWindowsPath ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase() : normalizedLeft === normalizedRight
}

function runtimeIdForSession(sessionId: string) {
  return Object.entries(state.runtimeSessionIds).find(([, id]) => id === sessionId)?.[0] || sessionId
}

function currentRuntimeId() {
  if (state.viewedRuntimeId) return state.viewedRuntimeId
  if (state.viewedSessionId) return runtimeIdForSession(state.viewedSessionId)
  const projectPath = state.chatProjectPath || state.viewedProjectPath
  return state.draftRuntimeIds[projectPath] || `draft:${projectPath}`
}

function currentRuntimeSnapshot() {
  return state.runtimeWorkers[currentRuntimeId()] || { status: "stopped" as const }
}

function projectSessions(project: DesktopProject) {
  return state.sessionPages[project.path] || project.sessions
}

function allSessions() {
  return state.projects.flatMap(projectSessions)
}

function knownSessions() {
  const sessions = new Map<string, DesktopSessionSummary>()
  for (const session of [...state.recentSessions, ...allSessions()]) sessions.set(session.id, session)
  return [...sessions.values()]
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
    option.selected = samePath(project.path, state.chatProjectPath)
    projectSelect.add(option)
  }
  projectSelect.disabled = false
  projectSelect.value = state.chatProjectPath
}

function renderProjects() {
  projectList.replaceChildren()
  if (!state.projects.length) {
    projectList.innerHTML = `<div class="sidebar-empty"><strong>No projects</strong><span>Add a folder to start a chat.</span></div>`
    return
  }
  for (const project of state.projects) {
    const expanded = state.expandedProjects.has(project.path)
    const sessions = projectSessions(project)
    const total = state.sessionTotals[project.path] ?? project.totalSessions
    const projectNode = document.createElement("section")
    projectNode.className = `project-item${samePath(project.path, state.viewedProjectPath) ? " selected" : ""}${expanded ? " expanded" : ""}`
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
  const running = runtimeTurnActive(runtimeIdForSession(item.id))
  return `
    <button type="button" class="session-item${item.id === state.viewedSessionId ? " selected" : ""}${running ? " running" : ""}" data-session-id="${escapeAttribute(item.id)}" data-session-project="${escapeAttribute(item.workspaceRoot)}">
      <span class="session-item-title">${running ? `<span class="status-pip pip-running"></span>` : ""}<span class="session-item-title-text">${escapeHtml(item.title || "Untitled")}</span></span>
      <small>${escapeHtml(clipLine(item.preview || "", 48))}</small>
      <small class="session-item-meta">${escapeHtml(when)}</small>
    </button>
  `
}

function renderRecentSessions() {
  if (!state.recentSessions.length) {
    recentSessions.hidden = true
    recentList.replaceChildren()
    return
  }
  const items = [...state.recentSessions].sort((left, right) => {
    const leftRunning = runtimeTurnActive(runtimeIdForSession(left.id))
    const rightRunning = runtimeTurnActive(runtimeIdForSession(right.id))
    return Number(rightRunning) - Number(leftRunning) || right.lastInteractedAt.localeCompare(left.lastInteractedAt)
  })
  recentSessions.hidden = false
  recentList.innerHTML = items.map(renderRecentSession).join("")
}

function renderRecentSession(item: DesktopRecentSession) {
  const running = runtimeTurnActive(runtimeIdForSession(item.id))
  const when = item.lastInteractedAt ? relativeTime(item.lastInteractedAt) : ""
  return `
    <button type="button" class="session-item${item.id === state.viewedSessionId ? " selected" : ""}${running ? " running" : ""}" data-session-id="${escapeAttribute(item.id)}" title="${escapeAttribute(item.title || "Untitled")}">
      <span class="session-item-title">${running ? `<span class="status-pip pip-running"></span>` : ""}<span class="session-item-title-text">${escapeHtml(item.title || "Untitled")}</span></span>
      <small>${escapeHtml(clipLine(item.preview || "", 48))}</small>
      <small class="session-item-meta">${escapeHtml(when)}</small>
    </button>
  `
}

function renderFiles() {
  const project = viewedProject()
  filesToggle.disabled = !project?.available
  filesToggle.textContent = state.filesOpen ? "Hide files" : "Files"
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

function renderDirectory(path: string, depth = 0): string {
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
  modelSelect.disabled = currentRuntimeSnapshot().status !== "ready" || !choices.length || runtimeTurnActive()
}

function renderStream() {
  const stickToBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
  const { conversation } = state
  const entries = conversation.entries
  const previousDetails = new Map<string, HTMLElement>()
  for (const row of messageStream.querySelectorAll<HTMLElement>("[data-tool-id]")) {
    const id = row.dataset.toolId
    const detail = row.querySelector<HTMLElement>(".tool-detail-shell")
    if (id && detail) previousDetails.set(id, detail)
  }
  if (!entries.length && !conversation.question) {
    const ready = state.runtime.status === "ready"
    messageStream.innerHTML = `<div class="stream-empty"><img class="stream-empty-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" /><p>No messages yet</p><p class="subtle">${ready ? "Ask Rind to inspect, change, or explain something in this workspace." : "Pick a project and start a runtime to begin."}</p></div>`
  } else {
    messageStream.innerHTML = entries.map(renderEntry).join("") + renderQuestion() + renderWorking()
  }
  for (const row of messageStream.querySelectorAll<HTMLElement>("[data-tool-id]")) {
    const id = row.dataset.toolId
    const nextDetail = row.querySelector<HTMLElement>(".tool-detail-shell")
    const previousDetail = id ? previousDetails.get(id) : undefined
    if (!nextDetail || !previousDetail) continue
    const nextClip = nextDetail.querySelector<HTMLElement>(".tool-detail-clip")
    const previousClip = previousDetail.querySelector<HTMLElement>(".tool-detail-clip")
    if (nextClip && previousClip) previousClip.innerHTML = nextClip.innerHTML
    previousDetail.setAttribute("aria-hidden", nextDetail.getAttribute("aria-hidden") || "true")
    nextDetail.replaceWith(previousDetail)
  }
  if (stickToBottom) {
    messageStream.scrollTop = messageStream.scrollHeight
    jumpLatest.hidden = true
  } else if (entries.length > lastRenderedEntries) {
    jumpLatest.hidden = false
  }
  lastRenderedEntries = entries.length
}

function renderEntry(entry: Entry): string {
  switch (entry.kind) {
    case "user":
      return `<article class="turn-user"><div class="user-bubble">${renderMarkdown(entry.content)}</div></article>`
    case "assistant":
      return `<article class="turn-assistant">${renderMarkdown(entry.content)}</article>`
    case "tool":
      return renderTool(entry)
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
  const revealed = open || state.revealedTools.has(tool.id)
  const pip = tool.status === "running" || tool.status === "pending"
    ? "pip-running"
    : tool.status === "error" ? "pip-error" : "pip-done"
  const duration = formatDuration(tool.durationMs)
  const diff = fileMutationPreview(tool.toolName, tool.arguments)
  const body = renderToolDetails(tool, Boolean(diff))
  return `
    <div class="ledger-row tool-${tool.status}${open ? " open" : ""}" data-tool-id="${escapeAttribute(tool.id)}">
      <button type="button" class="ledger-trigger" data-toggle-tool="${escapeAttribute(tool.id)}" aria-expanded="${body ? String(open) : "false"}" ${body ? "" : "disabled"}>
        <span class="status-pip ${pip}"></span>
        <span class="ledger-verb">${escapeHtml(tool.toolName)}</span>
        ${tool.argsPreview ? `<code class="ledger-arg">${escapeHtml(tool.argsPreview)}</code>` : ""}
        ${tool.errorType ? `<span class="ledger-error">${escapeHtml(tool.errorType)}</span>` : ""}
        ${duration ? `<span class="ledger-duration">${duration}</span>` : ""}
        ${body ? `<span class="ledger-chevron" aria-hidden="true"></span>` : ""}
      </button>
      ${diff ? renderFileMutationPreview(diff) : ""}
      ${body && revealed ? `<div class="tool-detail-shell" aria-hidden="${String(!open)}"><div class="tool-detail-clip">${body}</div></div>` : ""}
    </div>
  `
}

function renderToolDetails(tool: ToolEntry, hasMutationPreview: boolean): string {
  const inputs = Object.entries(tool.arguments).filter(([key]) => !hasMutationPreview || !["file_path", "content", "old_str", "new_str", "expected_sha256"].includes(key)).map(([key, value]) => `
    <div class="tool-detail-row"><span>${escapeHtml(key)}</span>${renderToolValue(value)}</div>
  `).join("")
  const result = tool.result
  const outcome = result?.ok === false
    ? `<section class="tool-detail-section tool-detail-error"><strong>${escapeHtml(result.error || "Tool failed")}</strong>${result.errorType ? `<small>${escapeHtml(result.errorType)}</small>` : ""}</section>`
    : result?.ok === true && result.data !== undefined
      ? `<section class="tool-detail-section"><span>Result</span>${renderToolValue(result.data)}</section>`
      : ""
  const resultMeta = hasMutationPreview ? Object.fromEntries(Object.entries(result?.meta || {}).filter(([key]) => key !== "files")) : result?.meta
  const meta = resultMeta && Object.keys(resultMeta).length
    ? `<section class="tool-detail-section"><span>Details</span>${renderToolValue(resultMeta)}</section>`
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

function renderFileMutationPreview(diff: ReturnType<typeof fileMutationPreview>): string {
  if (!diff) return ""
  const removed = diff.removed.filter((line) => line !== "…").length
  const added = diff.added.filter((line) => line !== "…").length
  const capped = diff.removed.includes("…") || diff.added.includes("…")
  const rows = [
    ...diff.removed.map((line) => `<div class="file-diff-line file-diff-removed"><span>-</span><code>${escapeHtml(line || " ")}</code></div>`),
    ...diff.added.map((line) => `<div class="file-diff-line file-diff-added"><span>+</span><code>${escapeHtml(line || " ")}</code></div>`),
  ].join("")
  return `
    <section class="file-diff-preview" aria-label="File change preview">
      <div class="file-diff-head">
        <span class="file-diff-label">Changed</span>
        ${diff.filePath ? `<code class="file-diff-path">${escapeHtml(diff.filePath)}</code>` : ""}
        <span class="file-diff-stats">${added ? `<span class="file-diff-added-count">+${added}</span>` : ""}${removed ? `<span class="file-diff-removed-count">-${removed}</span>` : ""}${capped ? `<span class="file-diff-capped">Capped</span>` : ""}</span>
      </div>
      <div class="file-diff-lines">${rows || `<div class="file-diff-empty">Empty file</div>`}</div>
    </section>
  `
}

function renderToolValue(value: unknown): string {
  if (value === null || value === undefined) return `<code class="tool-detail-value">None</code>`
  if (typeof value === "string") return `<code class="tool-detail-value">${escapeHtml(value)}</code>`
  if (typeof value === "number" || typeof value === "boolean") return `<code class="tool-detail-value">${escapeHtml(String(value))}</code>`
  if (Array.isArray(value)) return `<span class="tool-detail-value">${value.map(renderToolValue).join("")}</span>`
  return `<span class="tool-detail-value">${Object.entries(asRecord(value)).map(([key, item]) => `<span class="tool-detail-row"><span>${escapeHtml(key)}</span>${renderToolValue(item)}</span>`).join("")}</span>`
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

function runtimeStatusLabel(status: RuntimeSnapshot["status"]) {
  if (status === "starting") return "Preparing"
  if (status === "ready") return "Ready"
  if (status === "error") return "Needs attention"
  return "Idle"
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

function conversationFor(sessionId: string) {
  return sessionId === state.viewedSessionId
    ? state.conversation
    : state.conversationCache[sessionId] || createConversation()
}

function runtimeConversation() {
  return conversationFor(state.viewedSessionId)
}

function runtimeTurnActive(runtimeId = currentRuntimeId()) {
  const sessionId = state.runtimeSessionIds[runtimeId]
  return Boolean(state.runtimeTurnPending[runtimeId] || (sessionId && conversationFor(sessionId).activeTurnId))
}

function setConversationFor(sessionId: string, conversation: ConversationState) {
  if (sessionId === state.viewedSessionId) {
    state.conversation = conversation
    return
  }
  state.conversationCache = { ...state.conversationCache, [sessionId]: conversation }
}

function resetConversationPresentation() {
  state.expandedTools = new Set()
  state.revealedTools = new Set()
  toolOpenRequests.clear()
  toolAnimationUntil = 0
  state.planDock.collapsed = false
  state.planDock.displayedPlanId = ""
  dismissPlanError(state.conversation, state.viewedSessionId, state.planDock)
  lastRenderedEntries = 0
}

function adoptRuntimeSession(runtimeId: string, sessionId: string) {
  if (!runtimeId || !sessionId) return
  state.runtimeSessionIds[runtimeId] = sessionId
  if (!state.viewedSessionId) {
    state.viewedSessionId = sessionId
    state.viewedRuntimeId = runtimeId
  }
}

async function request(method: RuntimeMethod, params: Record<string, unknown> = {}, runtimeId = currentRuntimeId()) {
  try {
    return await window.api.runtime.request(runtimeId, method, params)
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
    render()
    throw error
  }
}

async function ensureRuntime(runtimeId: string, workspace: string, sessionId?: string) {
  const current = state.runtimeWorkers[runtimeId]
  if (current?.status === "ready") return runtimeId
  state.runtimeStarting[runtimeId] = true
  render()
  try {
    if (!current || current.status === "stopped" || current.status === "error") {
      state.runtimeWorkers[runtimeId] = await window.api.runtime.start(runtimeId, workspace, sessionId)
      render()
    }
    await window.api.runtime.initialize(runtimeId)
    state.runtimeWorkers[runtimeId] = { ...state.runtimeWorkers[runtimeId], status: "ready", runtimeId, workspace, sessionId }
    return runtimeId
  } finally {
    state.runtimeStarting[runtimeId] = false
    render()
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
  await flushRecentSessions()
}

function applyOverview(overview: Awaited<ReturnType<typeof window.api.projects.get>>) {
  const nextPages: Record<string, DesktopSessionSummary[]> = {}
  const nextTotals: Record<string, number> = {}
  for (const project of overview.projects) {
    nextPages[project.path] = mergeSessions(project.sessions, state.sessionPages[project.path] || [])
    nextTotals[project.path] = project.totalSessions
  }
  state.projects = overview.projects
  state.recentSessions = overview.recentSessions
  state.chatProjectPath = projectForPath(state.chatProjectPath)?.path || overview.activeProjectPath
  state.viewedProjectPath = projectForPath(state.viewedProjectPath)?.path || state.chatProjectPath
  state.sidebarOpen = overview.sidebarOpen
  state.sidebarWidth = overview.sidebarWidth
  state.filesOpen = overview.filesOpen
  state.filePanelWidth = overview.filePanelWidth
  state.sessionPages = nextPages
  state.sessionTotals = nextTotals
}

function mergeSessions(primary: DesktopSessionSummary[], secondary: DesktopSessionSummary[]) {
  const sessions = new Map<string, DesktopSessionSummary>()
  for (const session of [...primary, ...secondary]) sessions.set(session.id, session)
  return [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

async function loadReplay(sessionId = state.viewedSessionId) {
  if (!sessionId) return
  const result = await window.api.sessions.replay(sessionId)
  const messages = Array.isArray(result.messages) ? result.messages : []
  let conversation = conversationFromReplay(messages)
  const runtimeId = runtimeIdForSession(sessionId)
  if (runtimeTurnActive(runtimeId)) conversation = { ...conversation, ...conversationFor(sessionId), activeTurnId: conversationFor(sessionId).activeTurnId }
  setConversationFor(sessionId, conversation)
  if (sessionId === state.viewedSessionId) resetConversationPresentation()
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
    if (!state.model) state.model = state.settings.model
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
  await Promise.all([loadSessions(), state.viewedSessionId ? loadReplay() : Promise.resolve(), loadModels()])
  state.notice = ""
  render()
}

async function bootstrap(result: unknown) {
  const initialize = asRecord(result)
  const runtimeId = state.viewedRuntimeId || currentRuntimeId()
  const sessionId = typeof initialize.session_id === "string" ? initialize.session_id : state.runtimeSessionIds[runtimeId] || ""
  adoptRuntimeSession(runtimeId, sessionId)
  state.model = typeof initialize.model === "string" ? initialize.model : state.model
  await refreshSession()
  if (state.filesOpen && viewedProject()?.available) await loadDirectory("")
}

function handleRuntimeEvent(envelope: RuntimeEvent) {
  const runtimeId = envelope.runtimeId
  if (envelope.type === "turn_started" || envelope.type === "turn_completed" || envelope.type === "turn_failed" || envelope.type === "turn_cancelled") {
    state.runtimeTurnPending[runtimeId] = false
  }
  if (envelope.sessionId) {
    adoptRuntimeSession(runtimeId, envelope.sessionId)
    runAction(loadSessions)
    if (envelope.type === "turn_started") runAction(() => recordRecentSession(envelope.sessionId))
  }
  const sessionId = envelope.sessionId || state.runtimeSessionIds[runtimeId] || ""
  if (sessionId) setConversationFor(sessionId, reduceEvent(conversationFor(sessionId), envelope))
  if (envelope.type === "turn_completed" || envelope.type === "turn_failed" || envelope.type === "turn_cancelled") {
    runAction(async () => {
      await loadSessions()
      if (sessionId === state.viewedSessionId) render()
      else renderRecentSessions()
    })
  }
  if (sessionId === state.viewedSessionId) scheduleRender()
  else render()
}

function scheduleRender() {
  const animationDelay = toolAnimationUntil - performance.now()
  if (animationDelay > 0) {
    if (renderTimer === undefined) {
      renderTimer = setTimeout(() => {
        renderTimer = undefined
        scheduleRender()
      }, animationDelay)
    }
    return
  }
  if (renderFrame !== undefined) return
  renderFrame = requestAnimationFrame(() => {
    renderFrame = undefined
    render()
  })
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
  if (state.chatProjectPath) state.drafts[state.chatProjectPath] = prompt.value
  autoGrowPrompt()
})
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    runAction(sendPrompt)
  }
})
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.composerMenuOpen) {
    state.composerMenuOpen = false
    render()
    prompt.focus()
    return
  }
  if (event.key === "Escape" && runtimeTurnActive() && !state.settingsOpen) {
    runAction(() => request("turn.interrupt"))
  }
})
document.addEventListener("pointerdown", (event) => {
  if (state.composerMenuOpen && !(event.target as HTMLElement).closest(".composer-menu-wrap")) {
    state.composerMenuOpen = false
    render()
  }
})

async function sendPrompt() {
  const input = prompt.value.trim()
  if (!input) return
  const project = chatProject()
  if (!project?.available) {
    state.notice = "Choose a project before sending a message."
    render()
    return
  }
  prompt.value = ""
  state.drafts[state.chatProjectPath] = ""
  autoGrowPrompt()
  if (input.startsWith("/")) {
    runAction(() => runSlash(input))
    return
  }
  const runtimeId = currentRuntimeId()
  await ensureRuntime(runtimeId, project.path, state.viewedSessionId || undefined)
  state.viewedRuntimeId = runtimeId
  const active = runtimeTurnActive(runtimeId)
  state.conversation = addUserMessage(state.conversation, input)
  render()
  const result = active
    ? asRecord(await request("turn.follow_up", { input }, runtimeId))
    : await startTurn(input, runtimeId)
  if (typeof result.session_id === "string" && result.session_id) {
    adoptRuntimeSession(runtimeId, result.session_id)
    state.viewedSessionId = result.session_id
    state.viewedProjectPath = project.path
    await loadSessions()
    await recordRecentSession(result.session_id)
  }
  render()
}

async function startTurn(input: string, runtimeId = currentRuntimeId()) {
  state.runtimeTurnPending[runtimeId] = true
  render()
  try {
    return asRecord(await request("turn.start", { input }, runtimeId))
  } finally {
    state.runtimeTurnPending[runtimeId] = false
    render()
  }
}

async function runSlash(input: string) {
  const project = chatProject()
  if (!project?.available) {
    state.notice = "Choose a project before running a command."
    render()
    return
  }
  const runtimeId = currentRuntimeId()
  await ensureRuntime(runtimeId, project.path, state.viewedSessionId || undefined)
  state.viewedRuntimeId = runtimeId
  await loadModels()
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
    const turn = await startTurn(followUp, runtimeId)
    if (typeof turn.session_id === "string" && turn.session_id) {
      adoptRuntimeSession(runtimeId, turn.session_id)
      await loadSessions()
      await recordRecentSession(turn.session_id)
    }
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
  if (state.chatProjectPath) state.drafts[state.chatProjectPath] = ""
  autoGrowPrompt()
  runAction(() => request("turn.steer", { input }))
})
interrupt.addEventListener("click", () => runAction(() => request("turn.interrupt")))
retry.addEventListener("click", () => runAction(async () => {
  const project = chatProject()
  const runtimeId = currentRuntimeId()
  if (!project?.available) return
  await ensureRuntime(runtimeId, project.path, state.viewedSessionId || undefined)
  state.notice = ""
  render()
}))
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
composerMenuTrigger.addEventListener("click", () => {
  state.composerMenuOpen = !state.composerMenuOpen
  render()
})
compactContext.addEventListener("click", () => {
  state.composerMenuOpen = false
  render()
  runAction(async () => {
    await request("compact")
    prompt.focus()
  })
})
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
  if (projectSelect.value) runAction(() => selectChatProject(projectSelect.value))
})
projectList.addEventListener("click", (event) => {
  const target = event.target as HTMLElement
  const projectPath = target.closest<HTMLButtonElement>("[data-project-path]")?.dataset.projectPath
  if (projectPath) {
    runAction(() => toggleProject(projectPath))
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
recentList.addEventListener("click", (event) => {
  const nextSessionId = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-session-id]")?.dataset.sessionId
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
planDock.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest("[data-toggle-plan]")) return
  state.planDock.collapsed = !state.planDock.collapsed
  planDockShell.classList.toggle("collapsed", state.planDock.collapsed)
  const trigger = planDock.querySelector<HTMLButtonElement>("[data-toggle-plan]")
  trigger?.setAttribute("aria-expanded", String(!state.planDock.collapsed))
  planDock.querySelector<HTMLElement>(".plan-dock-body")?.setAttribute("aria-hidden", String(state.planDock.collapsed))
})
messageStream.addEventListener("click", (event) => {
  const target = event.target as HTMLElement
  const toggle = target.closest<HTMLButtonElement>("[data-toggle-tool]")
  if (toggle?.dataset.toggleTool) {
    const id = toggle.dataset.toggleTool
    const headerOffset = toolHeaderOffset(id)
    if (state.expandedTools.has(id)) {
      toolOpenRequests.set(id, (toolOpenRequests.get(id) || 0) + 1)
      toolAnimationUntil = performance.now() + 380
      const next = new Set(state.expandedTools)
      next.delete(id)
      state.expandedTools = next
      setToolExpanded(id, false)
      keepToolHeaderVisible(id, headerOffset)
      return
    }
    const requestId = (toolOpenRequests.get(id) || 0) + 1
    toolOpenRequests.set(id, requestId)
    toolAnimationUntil = performance.now() + 380
    state.revealedTools.add(id)
    render()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!state.revealedTools.has(id) || toolOpenRequests.get(id) !== requestId) return
        const next = new Set(state.expandedTools)
        next.add(id)
        state.expandedTools = next
        setToolExpanded(id, true)
        keepToolHeaderVisible(id, headerOffset)
      })
    })
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

function toolHeaderOffset(id: string) {
  const trigger = findToolTrigger(id)
  if (!trigger) return 12
  const stream = messageStream.getBoundingClientRect()
  const header = trigger.getBoundingClientRect()
  const offset = header.top - stream.top
  return offset >= 8 && header.bottom <= stream.bottom - 8 ? offset : 12
}

function keepToolHeaderVisible(id: string, targetOffset: number) {
  const sequence = ++toolPinSequence
  const pin = () => {
    if (sequence !== toolPinSequence) return
    const trigger = findToolTrigger(id)
    if (!trigger) return
    const currentOffset = trigger.getBoundingClientRect().top - messageStream.getBoundingClientRect().top
    messageStream.scrollTop += currentOffset - targetOffset
  }
  requestAnimationFrame(pin)
  window.setTimeout(pin, 160)
  window.setTimeout(pin, 300)
}

function findToolTrigger(id: string) {
  return [...messageStream.querySelectorAll<HTMLButtonElement>("[data-toggle-tool]")]
    .find((button) => button.dataset.toggleTool === id)
}

async function recordRecentSession(sessionId: string) {
  if (!sessionId) return
  state.pendingRecentSessionIds.add(sessionId)
  await flushRecentSessions()
}

async function flushRecentSessions() {
  for (const sessionId of state.pendingRecentSessionIds) {
    const overview = await window.api.projects.markRecent(sessionId)
    applyOverview(overview)
    if (overview.recentSessions.some((session) => session.id === sessionId)) state.pendingRecentSessionIds.delete(sessionId)
  }
}

function setToolExpanded(id: string, expanded: boolean) {
  const trigger = findToolTrigger(id)
  const row = trigger?.closest<HTMLElement>("[data-tool-id]")
  if (!row) return
  row.classList.toggle("open", expanded)
  trigger?.setAttribute("aria-expanded", String(expanded))
  row.querySelector<HTMLElement>(".tool-detail-shell")?.setAttribute("aria-hidden", String(!expanded))
}

function openSettings() {
  state.settingsOpen = true
  settingsApiKey.value = ""
  settingsBaseUrl.value = state.settings.baseUrl
  settingsModel.value = state.settings.model
  settingsReasoning.value = state.settings.reasoningEffort
  render()
}

function resetProjectView() {
  state.viewedSessionId = ""
  state.viewedRuntimeId = ""
  state.conversationCache = {}
  state.conversation = createConversation()
  resetConversationPresentation()
  state.expandedDirectories = new Set([""])
  state.fileListings = {}
  state.filePreview = undefined
  lastRenderedEntries = 0
}

function restoreProjectDraft() {
  prompt.value = state.drafts[state.chatProjectPath] || ""
  autoGrowPrompt()
}

async function addProject(createDraft = false) {
  const overview = await window.api.projects.add()
  if (!overview) return
  applyOverview(overview)
  resetProjectView()
  state.chatProjectPath = overview.activeProjectPath
  state.viewedProjectPath = overview.activeProjectPath
  if (createDraft) {
    state.filesOpen = false
    state.filePreview = undefined
    state.fileListings = {}
    applyOverview(await window.api.projects.updateLayout({ filesOpen: false }))
  }
  restoreProjectDraft()
  state.notice = ""
  render()
  if (state.filesOpen) await loadDirectory("")
}

async function toggleProject(path: string) {
  const project = state.projects.find((item) => item.path === path)
  if (!project) return
  if (state.expandedProjects.has(path)) state.expandedProjects.delete(path)
  else state.expandedProjects.add(path)
  state.notice = ""
  render()
}

async function removeProject(path: string) {
  const project = state.projects.find((item) => item.path === path)
  if (!project) return
  if (!window.confirm(`Remove ${project.name} from Rind Desktop? Its folder and sessions will be kept.`)) return
  const overview = await window.api.projects.remove(path)
  applyOverview(overview)
  delete state.drafts[path]
  if (samePath(path, state.viewedProjectPath)) {
    state.viewedProjectPath = overview.activeProjectPath
    state.chatProjectPath = overview.activeProjectPath
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
  const project = chatProject()
  if (!project?.available) {
    await addProject(true)
    return
  }
  state.viewedSessionId = ""
  state.viewedRuntimeId = ""
  state.filesOpen = false
  state.filePreview = undefined
  state.fileListings = {}
  state.draftRuntimeIds[state.chatProjectPath] = createRuntimeId("draft")
  state.conversation = createConversation()
  resetConversationPresentation()
  restoreProjectDraft()
  state.notice = ""
  applyOverview(await window.api.projects.updateLayout({ filesOpen: false }))
  render()
}

async function toggleSidebar() {
  applyOverview(await window.api.projects.updateLayout({ sidebarOpen: !state.sidebarOpen }))
  render()
}

async function setFilesOpen(open: boolean) {
  if (open && !viewedProject()?.available) {
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
  const project = viewedProject()
  if (!project) return
  const listing = await window.api.files.list(project.path, path)
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
  const project = viewedProject()
  if (!project) return
  state.filePreview = await window.api.files.preview(project.path, path)
  render()
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function usesWideFileLayout() {
  if (!state.filesOpen || !state.filePreview || window.innerWidth < 1180) return false
  const sidebarWidth = state.sidebarOpen ? state.sidebarWidth : 0
  return state.filePanelWidth >= 520 && window.innerWidth - sidebarWidth - state.filePanelWidth >= 440
}

function startResize(handle: HTMLElement, target: "sidebar" | "files") {
  handle.addEventListener("pointerdown", (event) => {
    if ((target === "sidebar" && !state.sidebarOpen) || (target !== "sidebar" && !state.filesOpen)) return
    const width = target === "sidebar" ? state.sidebarWidth : state.filePanelWidth
    resizeStart = { target, pointerId: event.pointerId, x: event.clientX, width, lastWidth: width }
    handle.setPointerCapture(event.pointerId)
    document.body.classList.add("resizing-panel")
    event.preventDefault()
  })
  handle.addEventListener("pointermove", (event) => {
    if (!resizeStart || resizeStart.target !== target || resizeStart.pointerId !== event.pointerId) return
    const delta = target === "sidebar" ? event.clientX - resizeStart.x : resizeStart.x - event.clientX
    const width = Math.round(resizeStart.width + delta)
    resizeStart.lastWidth = width
    if (target === "sidebar") state.sidebarWidth = Math.max(0, Math.min(420, width))
    else state.filePanelWidth = Math.max(0, Math.min(900, width))
    render()
  })
  handle.addEventListener("pointerup", (event) => finishResize(handle, event))
  handle.addEventListener("lostpointercapture", () => { resizeStart = undefined; document.body.classList.remove("resizing-panel") })
}

function finishResize(handle: HTMLElement, event: PointerEvent) {
  if (!resizeStart || resizeStart.pointerId !== event.pointerId) return
  const { target, lastWidth } = resizeStart
  handle.releasePointerCapture(event.pointerId)
  resizeStart = undefined
  document.body.classList.remove("resizing-panel")
  runAction(async () => {
    if (target === "sidebar") {
      const sidebarOpen = state.sidebarWidth >= 160
      state.sidebarWidth = Math.max(180, state.sidebarWidth || 248)
      applyOverview(await window.api.projects.updateLayout({ sidebarOpen, sidebarWidth: state.sidebarWidth }))
    } else {
      const filesOpen = lastWidth >= 240
      state.filePanelWidth = Math.max(280, state.filePanelWidth || 480)
      applyOverview(await window.api.projects.updateLayout({ filesOpen, filePanelWidth: state.filePanelWidth }))
    }
    render()
  })
}

window.addEventListener("resize", () => render())

async function switchSession(nextSessionId: string) {
  const session = knownSessions().find((item) => item.id === nextSessionId)
  if (!session) return
  const project = projectForPath(session.workspaceRoot)
  if (!project) return
  const runtimeId = runtimeIdForSession(nextSessionId)
  showCachedSession(nextSessionId)
  state.viewedSessionId = nextSessionId
  state.viewedProjectPath = project.path
  state.chatProjectPath = project.path
  state.viewedRuntimeId = state.runtimeWorkers[runtimeId] ? runtimeId : ""
  state.expandedDirectories = new Set([""])
  state.fileListings = {}
  state.filePreview = undefined
  applyOverview(await window.api.projects.select(project.path))
  render()
  if (!state.conversationCache[nextSessionId] || state.conversation.entries.length === 0) await loadReplay(nextSessionId)
  if (state.filesOpen && viewedProject()?.available) await loadDirectory("")
  render()
}

async function selectChatProject(path: string) {
  const project = state.projects.find((item) => item.path === path)
  if (!project) return
  if (state.chatProjectPath) state.drafts[state.chatProjectPath] = prompt.value
  state.chatProjectPath = project.path
  state.viewedProjectPath = project.path
  state.viewedSessionId = ""
  state.viewedRuntimeId = ""
  state.draftRuntimeIds[path] = createRuntimeId("draft")
  state.conversation = createConversation()
  state.expandedDirectories = new Set([""])
  state.fileListings = {}
  state.filePreview = undefined
  resetConversationPresentation()
  restoreProjectDraft()
  applyOverview(await window.api.projects.select(path))
  if (state.filesOpen && project.available) await loadDirectory("")
  render()
}

function showCachedSession(sessionId: string) {
  if (sessionId === state.viewedSessionId) return
  const cache = { ...state.conversationCache, [state.viewedSessionId]: state.conversation }
  state.viewedSessionId = sessionId
  state.conversation = cache[sessionId] || createConversation()
  state.conversationCache = cache
  resetConversationPresentation()
}

function createRuntimeId(prefix: string) {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

async function answerQuestion(answer: string) {
  const runtimeId = currentRuntimeId()
  if (!runtimeTurnActive(runtimeId)) return
  const question = state.conversation.question
  if (!question) return
  state.conversation = { ...state.conversation, question: undefined }
  render()
  await request("user_question.respond", { tool_call_id: question.toolCallId, answer }, runtimeId)
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
  state.notice = "Saving settings..."
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
  const runtimeId = snapshot.runtimeId || ""
  if (!runtimeId) return
  state.runtimeWorkers[runtimeId] = snapshot
  if (snapshot.sessionId) adoptRuntimeSession(runtimeId, snapshot.sessionId)
  if (snapshot.status !== "ready") state.runtimeTurnPending[runtimeId] = false
  if (snapshot.status === "error") {
    state.notice = snapshot.message || "Runtime is unavailable."
    if (!state.settingsAutoOpened && snapshot.message?.includes("Configuration error")) {
      state.settingsAutoOpened = true
      openSettings()
      return
    }
  }
  render()
})
const unsubscribeEvents = window.api.runtime.subscribeEvents(handleRuntimeEvent)
window.addEventListener("beforeunload", () => { unsubscribeStatus(); unsubscribeEvents() }, { once: true })
runAction(async () => {
  await loadSessions()
  render()
  if (state.filesOpen && viewedProject()?.available) await loadDirectory("")
})
void loadSettings()
