import "./style.css"
import brandMarkUrl from "./assets/brand-mark.svg"
import workingMarkUrl from "./assets/working-mark.svg"
import { PanelLeft, PanelRight, Settings, renderIcon } from "./icons"

import {
  composerRegionMarkup,
  dismissPlanError,
  renderComposer,
  renderPlanDock,
  syncPendingInputDock,
  type PendingInput,
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
import { runtimeMethods, sessionScopedMethods, turnScopedMethods } from "../preload/types"
import {
  addUserMessage,
  addCommandResult,
  clipLine,
  conversationFromLiveTurn,
  conversationFromReplay,
  createConversation,
  fileMutationPreview,
  formatDuration,
  mergeLiveConversation,
  mergeReplayConversation,
  reduceEvent,
  relativeTime,
  type ConversationState,
  type Entry,
  type ToolEntry,
} from "./timeline-model"
import { renderMarkdown } from "./markdown"
import { highlightFile } from "./syntax-highlight"
import { renderCommandResult } from "./command-results"
import { executeLocalSlashCommand } from "./local-slash-commands"
import { modelChoices, modelSelectionTarget } from "./composer-select"
import {
  commandPrefill,
  desktopSlashCommandNotice,
  fallbackSlashCommands,
  isExactSlashCommand,
  parseSlashCommands,
  revealSlashCommandOption,
  slashCommandMenu as buildSlashCommandMenu,
  type SlashCommand,
} from "./slash-commands"
import {
  defaultNewChatProjectPath,
  projectForPath as findProjectForPath,
  sameProjectPath as samePath,
  workingDirectorySelectionEnabled,
} from "./project-selection"
import { projectListStructureKey, recentListStructureKey } from "./sidebar-rendering"
import {
  canConfirmQuestion,
  createQuestionSelection,
  questionAnswer,
  selectQuestionOption,
  updateQuestionInput,
  type QuestionSelection,
} from "./question-state"

type AppState = {
  runtime: RuntimeSnapshot
  settings: DesktopSettings
  settingsOpen: boolean
  settingsSaving: boolean
  settingsAutoOpened: boolean
  runtimeTurnPending: Record<string, boolean>
  activeTurnIds: Record<string, string>
  pendingInputs: Record<string, PendingInput[]>
  viewedSessionId: string
  viewedProjectPath: string
  chatProjectPath: string
  conversationCache: Record<string, ConversationState>
  sessionModels: Record<string, string>
  model: string
  models: string[]
  projects: DesktopProject[]
  recentSessions: DesktopRecentSession[]
  fallbackProjectPath: string
  pendingRecentSessionIds: Set<string>
  sessionPages: Record<string, DesktopSessionSummary[]>
  sessionTotals: Record<string, number>
  sidebarOpen: boolean
  sidebarWidth: number
  filesOpen: boolean
  filePanelWidth: number
  expandedProjects: Set<string>
  projectMenuPath: string
  expandedDirectories: Set<string>
  fileListings: Record<string, DesktopFileListing>
  filePreview?: DesktopFilePreview
  drafts: Record<string, string>
  conversation: ConversationState
  questionSelection?: QuestionSelection
  expandedTools: Set<string>
  revealedTools: Set<string>
  planDock: PlanDockPresentation
  composerMenuOpen: boolean
  compacting: boolean
  slashCommandPending: boolean
  slashCommandInput: string
  slashCommands: SlashCommand[]
  slashMenuOpen: boolean
  slashMenuActiveIndex: number
  modelMenuOpen: boolean
  modelMenuLoading: boolean
  modelChanging: boolean
  projectMenuOpen: boolean
  notice: string
}

const root = document.querySelector<HTMLElement>("#app")
if (!root) throw new Error("Renderer root is missing.")
const appRoot: HTMLElement = root
document.body.dataset.platform = window.api.platform
const appVersion = await window.api.version()

const state: AppState = {
  runtime: { status: "stopped" },
  settings: { model: "", baseUrl: "", reasoningEffort: "", hasApiKey: false },
  settingsOpen: false,
  settingsSaving: false,
  settingsAutoOpened: false,
  runtimeTurnPending: {},
  activeTurnIds: {},
  pendingInputs: {},
  viewedSessionId: "",
  viewedProjectPath: "",
  chatProjectPath: "",
  conversationCache: {},
  sessionModels: {},
  model: "",
  models: [],
  projects: [],
  recentSessions: [],
  fallbackProjectPath: "",
  pendingRecentSessionIds: new Set(),
  sessionPages: {},
  sessionTotals: {},
  sidebarOpen: true,
  sidebarWidth: 248,
  filesOpen: false,
  filePanelWidth: 480,
  expandedProjects: new Set(),
  projectMenuPath: "",
  expandedDirectories: new Set([""]),
  fileListings: {},
  drafts: {},
  conversation: createConversation(),
  questionSelection: undefined,
  expandedTools: new Set(),
  revealedTools: new Set(),
  planDock: { collapsed: false, sessionId: "", dismissedPlanErrors: new Set() },
  composerMenuOpen: false,
  compacting: false,
  slashCommandPending: false,
  slashCommandInput: "",
  slashCommands: fallbackSlashCommands,
  slashMenuOpen: false,
  slashMenuActiveIndex: 0,
  modelMenuOpen: false,
  modelMenuLoading: false,
  modelChanging: false,
  projectMenuOpen: false,
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
      <div class="topbar-actions">
        <span class="app-version" aria-label="Rind version">v${escapeHtml(appVersion)}</span>
        <button id="toggle-sidebar" type="button" class="ghost-button" title="Toggle projects sidebar" aria-label="Toggle projects sidebar" aria-expanded="true">${renderIcon(PanelLeft)}</button>
        <button id="toggle-files" type="button" class="ghost-button" title="Browse active project files" aria-label="Browse active project files" aria-expanded="false">${renderIcon(PanelRight)}</button>
        <button id="open-settings" type="button" class="ghost-button" title="Open settings" aria-label="Open settings">${renderIcon(Settings)}</button>
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
        <div class="conversation-head"><div class="conversation-title"><strong id="session-title">New session</strong><span id="session-id" class="subtle"></span></div></div>
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
const projectMenuTrigger = requiredElement<HTMLButtonElement>("project-menu-trigger")
const projectMenuLabel = requiredElement("project-menu-label")
const projectMenu = requiredElement("project-menu")
const projectList = requiredElement("project-list")
const recentSessions = requiredElement("recent-sessions")
const recentList = requiredElement("recent-list")
const sessionTitle = requiredElement("session-title")
const sessionIdLabel = requiredElement("session-id")
const modelMenuTrigger = requiredElement<HTMLButtonElement>("model-menu-trigger")
const modelMenuLabel = requiredElement("model-menu-label")
const modelMenu = requiredElement("model-menu")
const messageStream = requiredElement("message-stream")
const jumpLatest = requiredElement<HTMLButtonElement>("jump-latest")
const planDockShell = requiredElement("plan-dock-shell")
const planDock = requiredElement("plan-dock")
const pendingInputDock = requiredElement("pending-input-dock")
const notice = requiredElement("notice")
const noticeText = requiredElement("notice-text")
const retry = requiredElement<HTMLButtonElement>("retry")
const contextMeter = requiredElement("context-meter")
const prompt = requiredElement<HTMLTextAreaElement>("prompt")
const send = requiredElement<HTMLButtonElement>("send")
const interrupt = requiredElement<HTMLButtonElement>("interrupt")
const composerMenuTrigger = requiredElement<HTMLButtonElement>("composer-menu-trigger")
const composerMenu = requiredElement("composer-menu")
const compactContext = requiredElement<HTMLButtonElement>("compact-context")
const slashCommandMenu = requiredElement("slash-command-menu")
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
let renderedProjectListStructureKey = ""
let renderedRecentListStructureKey = ""
let modelMenuRequestId = 0
let lastRuntimeSequence = 0
const replayRequests = new Map<string, Promise<void>>()
let overviewVersion = 0
let recentFlushPromise: Promise<void> | undefined

function requiredElement<T extends HTMLElement = HTMLElement>(id: string) {
  const element = document.getElementById(id) as T | null
  if (!element) throw new Error(`Missing ${id}.`)
  return element
}

function render() {
  const runtime = currentRuntimeSnapshot()
  state.runtime = runtime
  const { conversation } = state
  const wideFiles = usesWideFileLayout()
  const filesWidth = state.filesOpen ? state.filePanelWidth : 0
  connectionText.textContent = runtimeStatusLabel(runtime.status)
  connection.className = `connection connection-${runtime.status}`
  connection.hidden = runtime.status === "starting"
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
  const sidebarLabel = state.sidebarOpen ? "Hide projects sidebar" : "Show projects sidebar"
  sidebarToggle.title = sidebarLabel
  sidebarToggle.setAttribute("aria-label", sidebarLabel)
  sidebarToggle.setAttribute("aria-expanded", String(state.sidebarOpen))
  const current = knownSessions().find((item) => item.id === state.viewedSessionId)
  sessionTitle.textContent = current?.title || (state.viewedSessionId ? "Session" : "New session")
  sessionIdLabel.textContent = state.viewedSessionId || ""
  noticeText.textContent = state.notice || runtime.message || ""
  retry.hidden = runtime.status !== "error"
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
  syncPendingInputDock(
    pendingInputDock,
    state.pendingInputs[state.viewedSessionId] || [],
    (inputId) => runAction(() => promoteFollowUp(inputId), state.viewedSessionId),
    (inputId) => runAction(() => recallPendingInput(inputId), state.viewedSessionId),
  )
  renderStream()
  renderComposer(
    { prompt, send, interrupt, menuTrigger: composerMenuTrigger, menu: composerMenu, compactContext, slashCommandMenu, contextMeter },
    {
      ready: chatProject()?.available === true && state.settings.hasApiKey,
      active: runtimeTurnActive(),
      readOnly: false,
      starting: runtime.status === "starting",
      controllingTurn: Boolean(activeTurnIdFor(state.viewedSessionId)),
      runtimeSessionId: state.viewedSessionId,
      composerMenuOpen: state.composerMenuOpen,
      compacting: state.compacting,
      slashCommandPending: state.slashCommandPending,
      slashCommandInput: state.slashCommandInput,
      contextUsagePercent: state.conversation.contextUsagePercent,
    },
  )
  renderSlashCommandMenu()
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
  return findProjectForPath(state.projects, path)
}

function currentRuntimeSnapshot() {
  return state.runtime
}

function sessionTurnActive(sessionId: string) {
  return Boolean(sessionId && (state.runtimeTurnPending[sessionId] || activeTurnIdFor(sessionId)))
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
  const active = chatProject()
  const canOpen = workingDirectorySelectionEnabled(state.projects.length, state.viewedSessionId)
  if (!canOpen) state.projectMenuOpen = false
  projectMenuLabel.textContent = active?.available ? active.name : active ? `${active.name} (missing)` : "Working directory"
  projectMenuTrigger.title = state.viewedSessionId
    ? `Session working directory: ${active?.path || "Unavailable"}`
    : active?.path || "Choose working directory"
  projectMenuTrigger.disabled = !canOpen
  projectMenuTrigger.setAttribute("aria-expanded", String(state.projectMenuOpen))
  projectMenu.hidden = !state.projectMenuOpen
  if (!state.projectMenuOpen) {
    projectMenu.replaceChildren()
    return
  }
  if (!state.projects.length) {
    projectMenu.innerHTML = `<p class="composer-select-empty">No working directories</p>`
    return
  }
  projectMenu.innerHTML = state.projects.map((project) => {
    const selected = samePath(project.path, state.chatProjectPath)
    return `<button type="button" class="composer-select-option${selected ? " selected" : ""}" role="option" aria-selected="${String(selected)}" data-project-choice="${escapeAttribute(project.path)}"${project.available ? "" : " disabled"}><span class="composer-select-option-main">${escapeHtml(project.name)}</span><span class="composer-select-option-detail">${escapeHtml(project.available ? project.path : "Folder is unavailable")}</span></button>`
  }).join("")
}

function renderProjects() {
  const structureKey = projectListStructureKey({
    projects: state.projects,
    recentSessions: state.recentSessions,
    sessionPages: state.sessionPages,
    sessionTotals: state.sessionTotals,
    expandedProjects: state.expandedProjects,
    projectMenuPath: state.projectMenuPath,
  })
  if (structureKey === renderedProjectListStructureKey) {
    syncSidebarSelection()
    syncSidebarRunningState()
    return
  }
  renderedProjectListStructureKey = structureKey
  projectList.replaceChildren()
  if (!state.projects.length) {
    projectList.innerHTML = `<div class="sidebar-empty"><strong>No projects</strong><span>Add a folder to start a chat.</span></div>`
    syncSidebarSelection()
    syncSidebarRunningState()
    return
  }
  for (const project of state.projects) {
    const expanded = state.expandedProjects.has(project.path)
    const menuOpen = samePath(project.path, state.projectMenuPath)
    const sessions = projectSessions(project)
    const total = state.sessionTotals[project.path] ?? project.totalSessions
    const projectNode = document.createElement("section")
    projectNode.className = `project-item${expanded ? " expanded" : ""}`
    projectNode.innerHTML = `
      <div class="project-row">
        <button type="button" class="project-trigger" data-project-path="${escapeAttribute(project.path)}" title="${escapeAttribute(project.path)}">
          <span class="project-name">${escapeHtml(project.name)}</span>
          <span class="project-path">${escapeHtml(project.path)}</span>
        </button>
        <div class="project-menu-wrap">
          <button type="button" class="project-menu-trigger ghost-button" data-project-menu="${escapeAttribute(project.path)}" title="Project actions" aria-label="Project actions for ${escapeAttribute(project.name)}" aria-haspopup="menu" aria-expanded="${String(menuOpen)}"><svg class="project-menu-icon" viewBox="0 0 16 16" focusable="false" aria-hidden="true"><circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" /></svg></button>
          ${menuOpen ? `<div class="project-menu" role="menu"><button type="button" data-remove-project="${escapeAttribute(project.path)}" role="menuitem">Remove</button></div>` : ""}
        </div>
      </div>
      ${project.available ? "" : `<p class="project-missing">Folder is unavailable.</p>`}
      ${expanded ? `<div class="project-sessions">${sessions.map(renderProjectSession).join("")}${sessions.length < total ? `<button type="button" class="show-more ghost-button" data-show-more="${escapeAttribute(project.path)}">View more sessions</button>` : ""}</div>` : ""}
    `
    projectList.append(projectNode)
  }
  syncSidebarSelection()
  syncSidebarRunningState()
}

function renderProjectSession(item: DesktopSessionSummary) {
  const when = item.updatedAt ? relativeTime(item.updatedAt) : ""
  const running = sessionTurnActive(item.id)
  return `
    <button type="button" class="session-item${running ? " running" : ""}" data-session-id="${escapeAttribute(item.id)}" data-session-project="${escapeAttribute(item.workspaceRoot)}">
      <span class="session-item-title">${running ? `<span class="status-pip pip-running"></span>` : ""}<span class="session-item-title-text">${escapeHtml(item.title || "Untitled")}</span></span>
      <small>${escapeHtml(clipLine(item.preview || "", 48))}</small>
      <small class="session-item-meta">${escapeHtml(when)}</small>
    </button>
  `
}

function renderRecentSessions() {
  const structureKey = recentListStructureKey({
    projects: state.projects,
    recentSessions: state.recentSessions,
    sessionPages: state.sessionPages,
    sessionTotals: state.sessionTotals,
    expandedProjects: state.expandedProjects,
    projectMenuPath: state.projectMenuPath,
  })
  if (structureKey === renderedRecentListStructureKey) {
    syncSidebarSelection()
    syncSidebarRunningState()
    return
  }
  renderedRecentListStructureKey = structureKey
  if (!state.recentSessions.length) {
    recentSessions.hidden = true
    recentList.replaceChildren()
    syncSidebarSelection()
    syncSidebarRunningState()
    return
  }
  const items = [...state.recentSessions].sort((left, right) => right.lastInteractedAt.localeCompare(left.lastInteractedAt))
  recentSessions.hidden = false
  recentList.innerHTML = items.map(renderRecentSession).join("")
  syncSidebarSelection()
  syncSidebarRunningState()
}

function renderRecentSession(item: DesktopRecentSession) {
  const running = sessionTurnActive(item.id)
  const when = item.lastInteractedAt ? relativeTime(item.lastInteractedAt) : ""
  return `
    <button type="button" class="session-item${running ? " running" : ""}" data-session-id="${escapeAttribute(item.id)}" title="${escapeAttribute(item.title || "Untitled")}">
      <span class="session-item-title">${running ? `<span class="status-pip pip-running"></span>` : ""}<span class="session-item-title-text">${escapeHtml(item.title || "Untitled")}</span></span>
      <small>${escapeHtml(clipLine(item.preview || "", 48))}</small>
      <small class="session-item-meta">${escapeHtml(when)}</small>
    </button>
  `
}

function syncSidebarSelection() {
  const selectedId = state.viewedSessionId
  for (const button of sidebar.querySelectorAll<HTMLButtonElement>("[data-session-id]")) {
    const selected = button.dataset.sessionId === selectedId
    button.classList.toggle("selected", selected)
    if (selected) button.setAttribute("aria-current", "page")
    else button.removeAttribute("aria-current")
  }
}

function renderFiles() {
  const project = viewedProject()
  filesToggle.disabled = !project?.available
  const filesLabel = state.filesOpen ? "Hide project files" : "Browse active project files"
  filesToggle.title = filesLabel
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
  const activeModel = displayedModel()
  const choices = modelChoices(state.models, activeModel)
  const canOpen = canOpenModelMenu()
  if (!canOpen) closeModelMenu()
  modelMenuLabel.textContent = activeModel || (state.modelMenuLoading ? "Loading models..." : "Model")
  modelMenuTrigger.title = activeModel ? `Choose model: ${activeModel}` : "Choose model"
  modelMenuTrigger.disabled = !canOpen
  modelMenuTrigger.setAttribute("aria-expanded", String(state.modelMenuOpen))
  modelMenuTrigger.setAttribute("aria-busy", String(state.modelMenuLoading || state.modelChanging))
  modelMenu.hidden = !state.modelMenuOpen
  if (!state.modelMenuOpen) {
    modelMenu.replaceChildren()
    return
  }
  if (state.modelMenuLoading) {
    modelMenu.innerHTML = `<p class="composer-select-empty">Loading models...</p>`
    return
  }
  if (!choices.length) {
    modelMenu.innerHTML = `<p class="composer-select-empty">No models available</p>`
    return
  }
  modelMenu.innerHTML = choices.map((model) => {
    const selected = model === activeModel
    return `<button type="button" class="composer-select-option composer-model-option${selected ? " selected" : ""}" role="option" aria-selected="${String(selected)}" data-model-choice="${escapeAttribute(model)}"${state.modelChanging ? " disabled" : ""}><span class="composer-select-option-main">${escapeHtml(model)}</span></button>`
  }).join("")
}

function displayedModel() {
  if (state.viewedSessionId) return state.model
  return currentRuntimeSnapshot().status === "ready" ? state.model || state.settings.model : state.settings.model
}

function canOpenModelMenu() {
  const target = modelSelectionTargetForState()
  return Boolean(state.settings.hasApiKey && target !== "unavailable" && !state.modelChanging)
}

function syncSidebarRunningState() {
  for (const button of sidebar.querySelectorAll<HTMLButtonElement>("[data-session-id]")) {
    const running = sessionTurnActive(button.dataset.sessionId || "")
    button.classList.toggle("running", running)
    const title = button.querySelector<HTMLElement>(".session-item-title")
    if (!title) continue
    const pip = title.querySelector<HTMLElement>(".status-pip")
    if (running && !pip) {
      title.insertAdjacentHTML("afterbegin", `<span class="status-pip pip-running"></span>`)
    } else if (!running && pip) {
      pip.remove()
    }
  }
}

function modelSelectionTargetForState() {
  if (!state.viewedSessionId) return "settings" as const
  return modelSelectionTarget(currentRuntimeSnapshot().status, runtimeTurnActive())
}

function closeModelMenu() {
  if (state.modelMenuOpen || state.modelMenuLoading) modelMenuRequestId += 1
  state.modelMenuOpen = false
  state.modelMenuLoading = false
}

function closeComposerSelectMenus() {
  closeModelMenu()
  state.projectMenuOpen = false
}

async function toggleModelMenu() {
  if (!canOpenModelMenu()) return
  if (state.modelMenuOpen) {
    closeModelMenu()
    render()
    return
  }
  const requestId = ++modelMenuRequestId
  state.modelMenuOpen = true
  state.modelMenuLoading = true
  state.projectMenuOpen = false
  state.composerMenuOpen = false
  closeSlashCommandMenu()
  render()
  try {
    await loadAvailableModels()
    if (!isCurrentModelMenuRequest(requestId)) return
  } catch (error) {
    if (requestId !== modelMenuRequestId) return
    state.notice = error instanceof Error ? error.message : String(error)
    state.modelMenuOpen = false
  } finally {
    if (requestId === modelMenuRequestId) {
      state.modelMenuLoading = false
      render()
    }
  }
}

function isCurrentModelMenuRequest(requestId: number) {
  return requestId === modelMenuRequestId && state.modelMenuOpen
}

async function selectModel(model: string) {
  if (!model || model === displayedModel() || state.modelChanging) {
    closeModelMenu()
    render()
    return
  }
  const target = modelSelectionTargetForState()
  if (target === "unavailable") return
  const sessionId = state.viewedSessionId
  state.modelChanging = true
  render()
  try {
    if (target === "runtime") {
      const result = asRecord(await requestForSession(runtimeMethods.modelSet, sessionId, { model }))
      if (state.viewedSessionId === sessionId) {
        state.model = typeof result.model === "string" && result.model ? result.model : model
      }
    } else {
      state.settings = await window.api.settings.save({ model })
      if (!state.viewedSessionId) state.model = model
    }
    state.models = modelChoices(state.models, displayedModel())
    closeModelMenu()
  } finally {
    state.modelChanging = false
    render()
  }
}

function toggleProjectMenu() {
  if (!workingDirectorySelectionEnabled(state.projects.length, state.viewedSessionId)) {
    state.projectMenuOpen = false
    render()
    return
  }
  state.projectMenuOpen = !state.projectMenuOpen
  closeModelMenu()
  state.composerMenuOpen = false
  closeSlashCommandMenu()
  render()
}

function renderStream() {
  const stickToBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
  const { conversation } = state
  const entries = conversation.entries
  const existing = new Map<string, HTMLElement>()
  for (const node of messageStream.querySelectorAll<HTMLElement>("[data-entry-id]")) {
    if (node.dataset.entryId) existing.set(node.dataset.entryId, node)
  }
  const nextNodes: HTMLElement[] = []
  for (const entry of entries) {
    const template = document.createElement("template")
    template.innerHTML = renderEntry(entry)
    const next = template.content.firstElementChild as HTMLElement | null
    if (!next) continue
    const current = existing.get(entry.id)
    if (current && current.tagName === next.tagName) {
      syncElementAttributes(current, next)
      replaceElementChildren(current, next)
      nextNodes.push(current)
    } else {
      nextNodes.push(next)
    }
  }
  const extras = document.createElement("template")
  extras.innerHTML = `${renderQuestion()}${renderWorking()}`
  const specialNodes = new Map<string, HTMLElement>()
  for (const node of messageStream.querySelectorAll<HTMLElement>("[data-stream-role]")) {
    if (node.dataset.streamRole) specialNodes.set(node.dataset.streamRole, node)
  }
  for (const next of Array.from(extras.content.children) as HTMLElement[]) {
    const current = next.dataset.streamRole ? specialNodes.get(next.dataset.streamRole) : undefined
    if (current && current.tagName === next.tagName) {
      syncElementAttributes(current, next)
      replaceElementChildren(current, next)
      nextNodes.push(current)
    } else {
      nextNodes.push(next)
    }
  }
  const nextSet = new Set(nextNodes)
  for (const child of Array.from(messageStream.children)) {
    if (!nextSet.has(child as HTMLElement)) child.remove()
  }
  let anchor = messageStream.firstElementChild
  for (const node of nextNodes) {
    if (node !== anchor) messageStream.insertBefore(node, anchor)
    anchor = node.nextElementSibling
  }
  if (!entries.length && !conversation.question) {
    const ready = state.runtime.status === "ready"
    if (!messageStream.querySelector(".stream-empty")) {
      const empty = document.createElement("div")
      empty.className = "stream-empty"
      empty.innerHTML = `<img class="stream-empty-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" /><p>No messages yet</p><p class="subtle">${ready ? "Ask Rind to inspect, change, or explain something in this workspace." : "Pick a project and start a runtime to begin."}</p>`
      messageStream.append(empty)
    }
  } else {
    messageStream.querySelector(".stream-empty")?.remove()
  }
  if (stickToBottom) {
    messageStream.scrollTop = messageStream.scrollHeight
    jumpLatest.hidden = true
  } else if (entries.length > lastRenderedEntries) {
    jumpLatest.hidden = false
  }
  lastRenderedEntries = entries.length
}

function syncElementAttributes(current: HTMLElement, next: HTMLElement) {
  for (const attribute of Array.from(current.attributes)) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
  }
  for (const attribute of Array.from(next.attributes)) current.setAttribute(attribute.name, attribute.value)
}

function replaceElementChildren(current: HTMLElement, next: HTMLElement) {
  const focused = document.activeElement instanceof HTMLInputElement && current.contains(document.activeElement)
  const selectionStart = focused ? (document.activeElement as HTMLInputElement).selectionStart : null
  const selectionEnd = focused ? (document.activeElement as HTMLInputElement).selectionEnd : null
  current.replaceChildren(...Array.from(next.childNodes))
  if (!focused) return
  const input = current.querySelector<HTMLInputElement>("input")
  if (!input) return
  input.focus()
  if (selectionStart !== null && selectionEnd !== null) input.setSelectionRange(selectionStart, selectionEnd)
}

function renderEntry(entry: Entry): string {
  switch (entry.kind) {
    case "user":
      return `<article class="turn-user" data-entry-id="${escapeAttribute(entry.id)}"><div class="user-bubble">${renderMarkdown(entry.content)}</div></article>`
    case "assistant":
      return `<article class="turn-assistant" data-entry-id="${escapeAttribute(entry.id)}">${renderMarkdown(entry.content)}</article>`
    case "tool":
      return renderTool(entry)
    case "file":
      return `<div class="ledger-row ledger-file" data-entry-id="${escapeAttribute(entry.id)}"><span class="status-pip pip-done"></span><span class="ledger-verb">Edited</span><code class="ledger-arg">${escapeHtml(entry.filePath)}</code></div>`
    case "error":
      return `<div class="stream-card card-error" data-entry-id="${escapeAttribute(entry.id)}"><div class="card-label">${escapeHtml(entry.source)}</div><div class="card-body">${escapeHtml(entry.content)}</div></div>`
    case "notice":
      return `<div class="stream-card card-notice" data-entry-id="${escapeAttribute(entry.id)}"><div class="card-label">${escapeHtml(entry.label)}</div><div class="card-body">${escapeHtml(entry.content)}</div></div>`
    case "command":
      return `<div data-entry-id="${escapeAttribute(entry.id)}">${renderCommandResult(entry)}</div>`
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
    <div class="ledger-row tool-${tool.status}${open ? " open" : ""}" data-entry-id="${escapeAttribute(tool.id)}" data-tool-id="${escapeAttribute(tool.id)}">
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
  const selection = questionSelectionFor(question)
  const customIndex = question.options.length
  const customSelected = selection.selectedIndex === customIndex
  const canConfirm = canConfirmQuestion(selection, question.options.length)
  return `
    <div class="stream-card card-question" data-stream-role="question">
      <div class="card-label">Rind asks</div>
      <div class="question-text">${escapeHtml(question.question)}</div>
      <div class="question-options">${question.options.map((option, index) => `
        <button type="button" class="question-option${selection.selectedIndex === index ? " selected" : ""}" data-question-option-index="${index}" aria-pressed="${String(selection.selectedIndex === index)}">
          <strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.description)}</small>
        </button>
      `).join("")}
        <button type="button" class="question-option question-custom${customSelected ? " selected" : ""}" data-question-option-index="${customIndex}" aria-pressed="${String(customSelected)}">
          <strong>Type your own answer</strong><small>Enter a custom response.</small>
        </button>
      </div>
      <form id="question-form" class="question-form">
        ${customSelected ? `<input id="question-answer" aria-label="Your answer" autocomplete="off" placeholder="Type your own answer" value="${escapeAttribute(selection.customInput)}" />` : ""}
        <button type="submit" class="primary-button"${canConfirm ? "" : " disabled"}>Confirm</button>
      </form>
    </div>
  `
}

function renderWorking(): string {
  const conversation = runtimeConversation()
  const turnId = activeTurnIdFor(state.viewedSessionId)
  if (!turnId) return ""
  const elapsed = conversation.turnStartedAt ? Math.max(0, Math.round((Date.now() - conversation.turnStartedAt) / 1000)) : 0
  return `<div class="working" data-stream-role="working"><img class="working-mark" src="${workingMarkUrl}" alt="" aria-hidden="true" /><span id="working-label">Working… ${elapsed}s</span></div>`
}

function syncWorkingTimer() {
  const active = runtimeTurnActive()
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
  if (status === "stopping") return "Stopping"
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

function questionSelectionFor(question: NonNullable<ConversationState["question"]>): QuestionSelection {
  if (state.questionSelection?.questionId === question.toolCallId) return state.questionSelection
  const selection = createQuestionSelection(question.toolCallId, question.options.length)
  state.questionSelection = selection
  return selection
}

function runtimeConversation() {
  return conversationFor(state.viewedSessionId)
}

function activeTurnIdFor(sessionId: string) {
  return state.activeTurnIds[sessionId] || conversationFor(sessionId).activeTurnId || ""
}

function runtimeTurnActive() {
  return sessionTurnActive(state.viewedSessionId)
}

function setConversationFor(sessionId: string, conversation: ConversationState) {
  if (sessionId === state.viewedSessionId) {
    state.conversation = conversation
    return
  }
  state.conversationCache = { ...state.conversationCache, [sessionId]: conversation }
}

function clearRuntimeTurnState() {
  state.runtimeTurnPending = {}
  state.activeTurnIds = {}
  state.pendingInputs = {}
  state.conversation = { ...state.conversation, activeTurnId: "", turnStartedAt: 0 }
  state.conversationCache = Object.fromEntries(
    Object.entries(state.conversationCache).map(([sessionId, conversation]) => [
      sessionId,
      { ...conversation, activeTurnId: "", turnStartedAt: 0 },
    ]),
  )
}

function resetConversationPresentation(resetPlanDock = true) {
  state.expandedTools = new Set()
  state.revealedTools = new Set()
  toolOpenRequests.clear()
  toolAnimationUntil = 0
  if (resetPlanDock) {
    state.planDock.collapsed = false
    state.planDock.sessionId = ""
  }
  dismissPlanError(state.conversation, state.viewedSessionId, state.planDock)
  lastRenderedEntries = 0
}

async function request(method: RuntimeMethod, params: Record<string, unknown> = {}) {
  const requestParams = { ...params }
  if (sessionScopedMethods.has(method) && state.viewedSessionId && !requestParams.session_id) {
    requestParams.session_id = state.viewedSessionId
  }
  const targetSessionId = typeof requestParams.session_id === "string" ? requestParams.session_id : ""
  try {
    const turnSessionId = targetSessionId || state.viewedSessionId
    if (turnScopedMethods.has(method) && turnSessionId && !requestParams.turn_id) {
      const turnId = activeTurnIdFor(turnSessionId)
      if (turnId) requestParams.turn_id = turnId
    }
    return await window.api.runtime.request(method, requestParams)
  } catch (error) {
    if (!targetSessionId || targetSessionId === state.viewedSessionId) {
      state.notice = error instanceof Error ? error.message : String(error)
      render()
    }
    throw error
  }
}

async function requestForSession(method: RuntimeMethod, sessionId: string, params: Record<string, unknown> = {}) {
  const result = await request(method, { ...params, session_id: sessionId })
  const responseSessionId = asRecordText(asRecord(result).session_id)
  if (responseSessionId && responseSessionId !== sessionId) {
    throw new Error(`Runtime returned session ${responseSessionId} for requested session ${sessionId}.`)
  }
  return result
}

async function ensureRuntime() {
  if (state.runtime.status === "ready") return state.runtime
  if (state.runtime.status !== "starting") {
    throw new Error(state.runtime.message || "Runtime is not available. Use Retry to restart it.")
  }
  render()
  try {
    applyRuntimeInitialization(await window.api.runtime.initialize())
    state.runtime = { status: "ready" }
    return state.runtime
  } finally {
    render()
  }
}

async function restartRuntime(workspace: string) {
  state.runtime = await window.api.runtime.start(workspace)
  render()
  return ensureRuntime()
}

function runAction(action: () => Promise<unknown>, sessionId = "") {
  void action().catch((error) => {
    if (sessionId && state.viewedSessionId !== sessionId) return
    state.notice = error instanceof Error ? error.message : String(error)
    render()
  })
}

async function loadSessions() {
  const version = ++overviewVersion
  const overview = await window.api.projects.get()
  if (version !== overviewVersion) return
  applyOverview(overview)
  await flushRecentSessions()
}

async function ensureSession(workspaceRoot: string, requestedSessionId?: string, requestedModel = "") {
  const currentSessionId = requestedSessionId === undefined ? state.viewedSessionId : requestedSessionId
  if (currentSessionId) return currentSessionId
  const created = asRecord(await request(runtimeMethods.sessionNew, { workspace_root: workspaceRoot }))
  const sessionId = asRecordText(created.session_id)
  if (!sessionId) throw new Error("Runtime did not create a session.")
  const selectedModel = requestedModel.trim() || state.model.trim() || state.settings.model.trim()
  const createdModel = asRecordText(created.model)
  state.sessionModels[sessionId] = createdModel || selectedModel
  const bindToView = !state.viewedSessionId && samePath(state.chatProjectPath, workspaceRoot)
  if (bindToView) {
    state.viewedSessionId = sessionId
    state.viewedProjectPath = workspaceRoot
    state.model = state.sessionModels[sessionId]
    state.conversation = createConversation()
  } else {
    state.conversationCache = { ...state.conversationCache, [sessionId]: createConversation() }
  }
  if (selectedModel && selectedModel !== createdModel) {
    await requestForSession(runtimeMethods.modelSet, sessionId, { model: selectedModel })
    state.sessionModels[sessionId] = selectedModel
    if (state.viewedSessionId === sessionId) state.model = selectedModel
  }
  await loadSessions()
  return sessionId
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
  state.fallbackProjectPath = overview.activeProjectPath
  state.chatProjectPath = projectForPath(state.chatProjectPath)?.path
    || defaultNewChatProjectPath(state.projects, state.recentSessions, state.fallbackProjectPath)
  state.viewedProjectPath = projectForPath(state.viewedProjectPath)?.path || state.chatProjectPath
  if (!projectForPath(state.projectMenuPath)) state.projectMenuPath = ""
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
  const pending = replayRequests.get(sessionId)
  if (pending) return pending
  const request = loadReplayNow(sessionId)
  replayRequests.set(sessionId, request)
  try {
    await request
  } finally {
    if (replayRequests.get(sessionId) === request) replayRequests.delete(sessionId)
  }
}

async function loadReplayNow(sessionId: string) {
  if (!sessionId) return
  const session = knownSessions().find((item) => item.id === sessionId)
  if (!session) return
  await ensureRuntime()
  const result = asRecord(await requestForSession(runtimeMethods.sessionReplay, sessionId))
  const messages = Array.isArray(result.messages) ? result.messages : []
  const persisted = conversationFromReplay(messages)
  const live = conversationFor(sessionId)
  const liveSnapshot = asRecord(result.live_turn)
  const snapshotLive = conversationFromLiveTurn(liveSnapshot)
  const snapshotTurnId = asRecordText(liveSnapshot.turn_id)
  if (snapshotTurnId && snapshotLive.activeTurnId) state.activeTurnIds[sessionId] = snapshotTurnId
  else if (asRecord(result.turn_state).status === "running" && asRecordText(asRecord(result.turn_state).turn_id)) {
    state.activeTurnIds[sessionId] = asRecordText(asRecord(result.turn_state).turn_id)
  } else if (!snapshotTurnId) delete state.activeTurnIds[sessionId]
  const mergedLive = mergeLiveConversation(live, snapshotLive)
  const conversation = mergeReplayConversation(persisted, mergedLive)
  setConversationFor(sessionId, conversation)
  if (!state.pendingInputs[sessionId] && Array.isArray(liveSnapshot.pending_inputs)) {
    state.pendingInputs[sessionId] = liveSnapshot.pending_inputs.flatMap((item) => {
      const value = asRecord(item)
      const inputId = asRecordText(value.input_id)
      const input = asRecordText(value.input)
      const mode = value.mode === "steering" ? "steering" : "follow_up"
      return inputId && input ? [{ inputId, input, mode, promoting: false, recalling: false }] : []
    })
    if (!state.pendingInputs[sessionId].length) delete state.pendingInputs[sessionId]
  }
  if (sessionId === state.viewedSessionId) {
    const model = asRecordText(result.model)
    if (model) {
      state.sessionModels[sessionId] = model
      state.model = model
    }
    resetConversationPresentation(false)
  }
}

async function loadAvailableModels() {
  state.models = await window.api.models.list(state.chatProjectPath || state.fallbackProjectPath)
}

async function loadSettings() {
  try {
    state.settings = await window.api.settings.get(state.chatProjectPath || state.fallbackProjectPath)
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

function applyRuntimeInitialization(result: unknown) {
  const initialize = asRecord(result)
  if (!state.viewedSessionId && typeof initialize.model === "string") {
    state.model = initialize.model
  }
  const commands = parseSlashCommands(initialize.commands)
  if (commands.length) state.slashCommands = mergeSlashCommands(fallbackSlashCommands, commands)
}

function syncCurrentPendingInputs() {
  syncPendingInputDock(
    pendingInputDock,
    state.pendingInputs[state.viewedSessionId] || [],
    (inputId) => runAction(() => promoteFollowUp(inputId), state.viewedSessionId),
    (inputId) => runAction(() => recallPendingInput(inputId), state.viewedSessionId),
  )
}

function addPendingInput(sessionId: string, input: string, result: Record<string, unknown>) {
  const inputId = asRecordText(result.input_id)
  if (!inputId) throw new Error("Runtime accepted queued input without input_id.")
  const pending = state.pendingInputs[sessionId] || []
  state.pendingInputs[sessionId] = [
    ...pending,
    { inputId, input, mode: result.mode === "steering" ? "steering" : "follow_up", promoting: false, recalling: false },
  ]
}

function deliverPendingInput(sessionId: string, inputId: string) {
  if (!inputId) return false
  const pending = state.pendingInputs[sessionId]
  const index = pending?.findIndex((item) => item.inputId === inputId) ?? -1
  if (index < 0 || !pending) return false
  const input = pending[index]
  pending.splice(index, 1)
  if (!pending.length) delete state.pendingInputs[sessionId]
  if (sessionId) setConversationFor(sessionId, addUserMessage(conversationFor(sessionId), input.input))
  return true
}

async function promoteFollowUp(inputId: string) {
  const sessionId = state.viewedSessionId
  const item = state.pendingInputs[sessionId]?.find((pending) => pending.inputId === inputId)
  if (!item || item.mode !== "follow_up" || item.promoting) return
  item.promoting = true
  syncCurrentPendingInputs()
  try {
    const result = asRecord(await requestForSession(runtimeMethods.sessionPromoteFollowUp, sessionId, { input_id: inputId }))
    if (asRecordText(result.input_id) !== inputId || result.mode !== "steering") {
      throw new Error("Runtime returned an invalid queued input promotion.")
    }
    item.mode = "steering"
    const pending = state.pendingInputs[sessionId]
    if (pending) {
      pending.splice(pending.indexOf(item), 1)
      pending.push(item)
    }
  } finally {
    item.promoting = false
    syncCurrentPendingInputs()
  }
}

async function recallPendingInput(inputId: string) {
  const sessionId = state.viewedSessionId
  const pending = state.pendingInputs[sessionId]
  const item = pending?.find((candidate) => candidate.inputId === inputId)
  if (!item || item.promoting || item.recalling) return
  item.recalling = true
  syncCurrentPendingInputs()
  try {
    const method = item.mode === "steering"
      ? runtimeMethods.sessionUnsteer
      : runtimeMethods.sessionDequeueFollowUp
    const result = asRecord(await requestForSession(method, sessionId, { input_id: item.inputId }))
    const input = asRecordText(result.input)
    if (result.retrieved !== true || result.mode !== item.mode || asRecordText(result.input_id) !== item.inputId || !input) {
      throw new Error("Runtime returned an invalid queued input retrieval.")
    }
    const index = pending.findIndex((candidate) => candidate.inputId === item.inputId)
    if (index < 0) throw new Error("Retrieved input is not present in the local queue.")
    pending.splice(index, 1)
    if (!pending.length) delete state.pendingInputs[sessionId]
    setPrompt([input, prompt.value].filter((value) => value.trim()).join("\n\n"), true)
  } finally {
    item.recalling = false
    syncCurrentPendingInputs()
  }
}

function mergeSlashCommands(...groups: SlashCommand[][]) {
  const unique = new Map<string, SlashCommand>()
  for (const group of groups) {
    for (const command of group) unique.set(command.name, command)
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function handleRuntimeEvent(envelope: RuntimeEvent) {
  if (envelope.sequence <= lastRuntimeSequence) return
  lastRuntimeSequence = envelope.sequence
  const sessionId = envelope.sessionId
  const eventSessionId = asRecordText(envelope.event.session_id)
  if (!sessionId || (eventSessionId && eventSessionId !== sessionId)) return
  const activeTurnId = activeTurnIdFor(sessionId)
  if (envelope.type === "turn_started") {
    if (activeTurnId && envelope.turnId !== activeTurnId) return
    state.activeTurnIds[sessionId] = envelope.turnId
  } else if (!activeTurnId || envelope.turnId !== activeTurnId) {
    return
  }
  const turnStarted = envelope.type === "turn_started"
  const turnSettled = envelope.type === "turn_completed" || envelope.type === "turn_failed" || envelope.type === "turn_cancelled"
  if (turnStarted || turnSettled) {
    state.runtimeTurnPending[sessionId] = turnStarted
  }
  if (turnStarted) {
    runAction(() => recordRecentSession(sessionId), sessionId)
  }
  if (envelope.type === "queued_input_delivered") {
    deliverPendingInput(sessionId, asRecordText(envelope.event.input_id))
  }
  setConversationFor(sessionId, reduceEvent(conversationFor(sessionId), envelope))
  if (turnSettled) {
    delete state.activeTurnIds[sessionId]
    delete state.pendingInputs[sessionId]
    runAction(async () => {
      await loadSessions()
      if (sessionId === state.viewedSessionId) render()
      else renderRecentSessions()
    }, sessionId)
  }
  if (sessionId === state.viewedSessionId) scheduleRender()
  else if (turnStarted || turnSettled) render()
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

function setPrompt(value: string, focus = false) {
  prompt.value = value
  if (state.chatProjectPath) state.drafts[state.chatProjectPath] = value
  autoGrowPrompt()
  renderSlashCommandMenu()
  if (focus) prompt.focus()
}

function renderSlashCommandMenu() {
  if (prompt.disabled) {
    closeSlashCommandMenu()
    return
  }
  const menu = buildSlashCommandMenu(state.slashCommands, prompt.value)
  if (!menu) {
    state.slashMenuOpen = false
    slashCommandMenu.hidden = true
    slashCommandMenu.replaceChildren()
    prompt.setAttribute("aria-expanded", "false")
    prompt.removeAttribute("aria-activedescendant")
    return
  }
  state.slashMenuOpen = true
  prompt.setAttribute("aria-expanded", "true")
  if (!menu.commands.length) {
    slashCommandMenu.innerHTML = `<p class="slash-command-empty">No matching command</p>`
    slashCommandMenu.hidden = false
    prompt.removeAttribute("aria-activedescendant")
    return
  }
  state.slashMenuActiveIndex = Math.min(state.slashMenuActiveIndex, menu.commands.length - 1)
  const active = menu.commands[state.slashMenuActiveIndex]
  prompt.setAttribute("aria-activedescendant", `slash-command-${active.name}`)
  slashCommandMenu.innerHTML = menu.commands.map((command, index) => `
    <button
      id="slash-command-${escapeAttribute(command.name)}"
      type="button"
      class="slash-command-option${index === state.slashMenuActiveIndex ? " selected" : ""}"
      role="option"
      aria-selected="${String(index === state.slashMenuActiveIndex)}"
      data-slash-command="${escapeAttribute(command.name)}"
    >
      <span class="slash-command-main"><code>/${escapeHtml(command.name)}</code><span>${escapeHtml(command.description)}</span></span>
      <span class="slash-command-usage">${escapeHtml(command.usage)}</span>
    </button>
  `).join("")
  slashCommandMenu.hidden = false
}

function revealActiveSlashCommand() {
  revealSlashCommandOption(slashCommandMenu.querySelector<HTMLElement>(".slash-command-option.selected"))
}

function closeSlashCommandMenu() {
  state.slashMenuOpen = false
  state.slashMenuActiveIndex = 0
  slashCommandMenu.hidden = true
  slashCommandMenu.replaceChildren()
  prompt.setAttribute("aria-expanded", "false")
  prompt.removeAttribute("aria-activedescendant")
}

function selectSlashCommand(command: SlashCommand) {
  if (!command) return
  setPrompt(commandPrefill(command), true)
  closeSlashCommandMenu()
}

  requiredElement<HTMLFormElement>("composer").addEventListener("submit", (event) => { event.preventDefault(); runAction(sendPrompt, state.viewedSessionId) })

prompt.addEventListener("input", () => {
  if (state.chatProjectPath) state.drafts[state.chatProjectPath] = prompt.value
  autoGrowPrompt()
  renderSlashCommandMenu()
})
prompt.addEventListener("keydown", (event) => {
  const menu = buildSlashCommandMenu(state.slashCommands, prompt.value)
  if (state.slashMenuOpen && menu && menu.commands.length) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const offset = event.key === "ArrowDown" ? 1 : -1
      state.slashMenuActiveIndex = (state.slashMenuActiveIndex + offset + menu.commands.length) % menu.commands.length
      renderSlashCommandMenu()
      revealActiveSlashCommand()
      return
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !isExactSlashCommand(state.slashCommands, prompt.value))) {
      event.preventDefault()
      selectSlashCommand(menu.commands[state.slashMenuActiveIndex] || menu.commands[0])
      return
    }
  }
  if (event.key === "Escape" && state.slashMenuOpen) {
    event.preventDefault()
    closeSlashCommandMenu()
    return
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    runAction(sendPrompt, state.viewedSessionId)
  }
})
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.slashMenuOpen) {
    event.preventDefault()
    closeSlashCommandMenu()
    return
  }
  if (event.key === "Escape" && state.modelMenuOpen) {
    event.preventDefault()
    closeModelMenu()
    render()
    modelMenuTrigger.focus()
    return
  }
  if (event.key === "Escape" && state.projectMenuOpen) {
    event.preventDefault()
    state.projectMenuOpen = false
    render()
    projectMenuTrigger.focus()
    return
  }
  if (event.key === "Escape" && state.composerMenuOpen) {
    state.composerMenuOpen = false
    render()
    prompt.focus()
    return
  }
  if (event.key === "Escape" && state.projectMenuPath) {
    const menuPath = state.projectMenuPath
    state.projectMenuPath = ""
    render()
    projectList.querySelector<HTMLButtonElement>(`[data-project-menu="${CSS.escape(menuPath)}"]`)?.focus()
    return
  }
  if (event.key === "Escape" && runtimeTurnActive() && !state.settingsOpen) {
    runAction(() => request(runtimeMethods.sessionCancel), state.viewedSessionId)
  }
})
document.addEventListener("pointerdown", (event) => {
  if ((state.modelMenuOpen || state.projectMenuOpen) && !(event.target as HTMLElement).closest(".composer-select-wrap")) {
    closeComposerSelectMenus()
    render()
  }
  if (state.composerMenuOpen && !(event.target as HTMLElement).closest(".composer-menu-wrap")) {
    state.composerMenuOpen = false
    render()
  }
  if (state.projectMenuPath && !(event.target as HTMLElement).closest(".project-menu-wrap")) {
    state.projectMenuPath = ""
    render()
  }
  if (state.slashMenuOpen && !(event.target as HTMLElement).closest(".prompt-wrap")) closeSlashCommandMenu()
})

async function sendPrompt() {
  if (state.slashCommandPending) {
    state.notice = `Running ${state.slashCommandInput || "command"}...`
    render()
    return
  }
  const input = prompt.value.trim()
  if (!input) return
  const project = chatProject()
  if (!project?.available) {
    state.notice = "Choose a project before sending a message."
    render()
    return
  }
  if (input.startsWith("/")) {
    prompt.value = ""
    state.drafts[state.chatProjectPath] = ""
    autoGrowPrompt()
    closeSlashCommandMenu()
    runAction(() => runSlash(input), state.viewedSessionId)
    return
  }
  const projectPath = project.path
  const requestedSessionId = state.viewedSessionId
  const requestedModel = state.model || state.settings.model
  await ensureRuntime()
  const sessionId = await ensureSession(projectPath, requestedSessionId, requestedModel)
  const active = sessionTurnActive(sessionId)
  if (active) {
    const result = asRecord(await requestForSession(runtimeMethods.sessionFollowUp, sessionId, { input }))
    addPendingInput(sessionId, input, result)
    prompt.value = ""
    state.drafts[projectPath] = ""
    autoGrowPrompt()
    closeSlashCommandMenu()
    syncCurrentPendingInputs()
    return
  }
  prompt.value = ""
  state.drafts[projectPath] = ""
  autoGrowPrompt()
  closeSlashCommandMenu()
  setConversationFor(sessionId, addUserMessage(conversationFor(sessionId), input))
  if (state.viewedSessionId === sessionId) render()
  const result = await startTurn(sessionId, input)
  if (typeof result.session_id === "string" && result.session_id) {
    await loadSessions()
    await recordRecentSession(result.session_id)
  }
  if (state.viewedSessionId === sessionId) render()
}

async function startTurn(sessionId: string, input: string, transientSystemMessages?: unknown) {
  state.runtimeTurnPending[sessionId] = true
  if (state.viewedSessionId === sessionId) render()
  try {
    return asRecord(await requestForSession(runtimeMethods.sessionPrompt, sessionId, {
      input,
      ...(Array.isArray(transientSystemMessages) ? { transient_system_messages: transientSystemMessages } : {}),
    }))
  } finally {
    state.runtimeTurnPending[sessionId] = false
    if (state.viewedSessionId === sessionId) render()
  }
}

function clearSlashCommandPending() {
  state.slashCommandPending = false
  state.slashCommandInput = ""
}

async function runSlash(input: string) {
  const localNotice = desktopSlashCommandNotice(input)
  if (localNotice) {
    state.notice = localNotice
    clearSlashCommandPending()
    render()
    return
  }
  const localResult = executeLocalSlashCommand(input, {
    settings: state.settings,
    runtime: currentRuntimeSnapshot(),
    sessionId: state.viewedSessionId,
    projectPath: state.chatProjectPath,
    commands: state.slashCommands,
  })
  if (localResult) {
    if (state.viewedSessionId && localResult.text) {
      setConversationFor(
        state.viewedSessionId,
        addCommandResult(conversationFor(state.viewedSessionId), input, localResult.text, localResult.display),
      )
    } else {
      state.notice = localResult.text
    }
    render()
    return
  }
  const project = chatProject()
  if (!project?.available) {
    state.notice = "Choose a project before running a command."
    render()
    return
  }
  const projectPath = project.path
  const requestedSessionId = state.viewedSessionId
  const requestedModel = state.model || state.settings.model
  const compacting = /^\/compact\s*$/i.test(input)
  state.slashCommandPending = true
  state.slashCommandInput = input
  if (compacting) {
    state.compacting = true
  }
  render()
  try {
    await ensureRuntime()
    const commandSessionId = await ensureSession(projectPath, requestedSessionId, requestedModel)
    const result = asRecord(await requestForSession(runtimeMethods.commandExecute, commandSessionId, { input }))
    const commands = parseSlashCommands(asRecord(result.display).commands)
    if (commands.length) state.slashCommands = mergeSlashCommands(fallbackSlashCommands, commands)
    const text = asRecordText(result.text)
    if (compacting && text.startsWith("Compact complete.")) {
      await loadReplay(commandSessionId)
      if (isCurrentSlashView(projectPath, commandSessionId)) {
        state.notice = "Context compacted. Session history remains visible."
      }
    } else if (text && canUpdateSlashSession(projectPath, commandSessionId)) {
      setConversationFor(
        commandSessionId,
        addCommandResult(conversationFor(commandSessionId), input, text, asRecord(result.display)),
      )
    }
    const prefill = typeof result.prompt_prefill === "string" ? result.prompt_prefill : ""
    if (prefill && isCurrentSlashView(projectPath, commandSessionId)) setPrompt(prefill, true)
    const nextPrompt = result.next_prompt && typeof result.next_prompt === "object"
      ? result.next_prompt as Record<string, unknown>
      : null
    const followUp = typeof nextPrompt?.input === "string" ? nextPrompt.input.trim() : ""
    if (followUp && canUpdateSlashSession(projectPath, commandSessionId)) {
      setConversationFor(commandSessionId, addUserMessage(conversationFor(commandSessionId), followUp))
      const turn = await startTurn(commandSessionId, followUp, nextPrompt?.transient_system_messages)
      if (typeof turn.session_id === "string" && turn.session_id) {
        await loadSessions()
        await recordRecentSession(turn.session_id)
      }
    }
  } finally {
    state.compacting = false
    clearSlashCommandPending()
    render()
  }
}

function isCurrentSlashView(projectPath: string, sessionId: string) {
  return samePath(state.chatProjectPath, projectPath)
    && state.viewedSessionId === sessionId
}

function canUpdateSlashSession(projectPath: string, sessionId: string) {
  return isCurrentSlashView(projectPath, sessionId)
    || Boolean(sessionId && Object.hasOwn(state.conversationCache, sessionId))
}

async function compactCurrentSession() {
  const project = chatProject()
  if (!project?.available || !state.viewedSessionId) return
  const sessionId = state.viewedSessionId
  state.compacting = true
  render()
  try {
    await ensureRuntime()
    const record = asRecord(await requestForSession(runtimeMethods.sessionCompact, sessionId))
    await loadReplay(sessionId)
    if (state.viewedSessionId === sessionId) state.notice = compactNotice(record)
  } finally {
    state.compacting = false
    render()
    prompt.focus()
  }
}

function compactNotice(record: Record<string, unknown>) {
  const source = asRecord(record.source)
  const start = source.message_start_index
  const end = source.message_end_index_exclusive
  if (typeof start === "number" && typeof end === "number") {
    return `Context compacted from messages ${start + 1}-${end}. Session history remains visible.`
  }
  return "Context compacted. Session history remains visible."
}

function asRecordText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

interrupt.addEventListener("click", () => runAction(() => request(runtimeMethods.sessionCancel), state.viewedSessionId))
retry.addEventListener("click", () => runAction(async () => {
  const project = chatProject()
  if (!project?.available) return
  await restartRuntime(project.path)
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
requiredElement("sidebar-add-project").addEventListener("click", () => runAction(addProject))
requiredElement("open-settings").addEventListener("click", () => openSettings())
requiredElement("new-session").addEventListener("click", () => runAction(startNewChat))
sidebarToggle.addEventListener("click", () => runAction(toggleSidebar))
requiredElement("close-files").addEventListener("click", () => runAction(() => setFilesOpen(false)))
filesToggle.addEventListener("click", () => runAction(() => setFilesOpen(!state.filesOpen)))
composerMenuTrigger.addEventListener("click", () => {
  closeComposerSelectMenus()
  state.composerMenuOpen = !state.composerMenuOpen
  render()
})
compactContext.addEventListener("click", () => {
  state.composerMenuOpen = false
  render()
    runAction(compactCurrentSession, state.viewedSessionId)
})
slashCommandMenu.addEventListener("pointermove", (event) => {
  const commandName = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-slash-command]")?.dataset.slashCommand
  if (!commandName) return
  const index = buildSlashCommandMenu(state.slashCommands, prompt.value)?.commands.findIndex((command) => command.name === commandName) ?? -1
  if (index < 0 || index === state.slashMenuActiveIndex) return
  state.slashMenuActiveIndex = index
  renderSlashCommandMenu()
  revealActiveSlashCommand()
})
slashCommandMenu.addEventListener("click", (event) => {
  const commandName = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-slash-command]")?.dataset.slashCommand
  const command = state.slashCommands.find((item) => item.name === commandName)
  if (command) selectSlashCommand(command)
})
modelMenuTrigger.addEventListener("click", () => runAction(toggleModelMenu))
modelMenu.addEventListener("click", (event) => {
  const model = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-model-choice]")?.dataset.modelChoice
  if (model) runAction(() => selectModel(model))
})
settingsForm.addEventListener("submit", (event) => { event.preventDefault(); runAction(saveSettings) })
requiredElement("close-settings").addEventListener("click", () => { state.settingsOpen = false; render() })
requiredElement("cancel-settings").addEventListener("click", () => { state.settingsOpen = false; render() })
settingsDialog.addEventListener("cancel", () => { state.settingsOpen = false; render() })
projectMenuTrigger.addEventListener("click", () => toggleProjectMenu())
projectMenu.addEventListener("click", (event) => {
  if (state.viewedSessionId) {
    state.projectMenuOpen = false
    render()
    return
  }
  const path = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-project-choice]")?.dataset.projectChoice
  if (!path || samePath(path, state.chatProjectPath)) {
    state.projectMenuOpen = false
    render()
    return
  }
  state.projectMenuOpen = false
  render()
  runAction(() => selectChatProject(path))
})
projectList.addEventListener("click", (event) => {
  const target = event.target as HTMLElement
  const menuProjectPath = target.closest<HTMLButtonElement>("[data-project-menu]")?.dataset.projectMenu
  if (menuProjectPath) {
    state.projectMenuPath = samePath(menuProjectPath, state.projectMenuPath) ? "" : menuProjectPath
    render()
    return
  }
  const projectPath = target.closest<HTMLButtonElement>("[data-project-path]")?.dataset.projectPath
  if (projectPath) {
    runAction(() => toggleProject(projectPath))
    return
  }
  const removeProjectPath = target.closest<HTMLButtonElement>("[data-remove-project]")?.dataset.removeProject
  if (removeProjectPath) {
    state.projectMenuPath = ""
    render()
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
  if (nextSessionId) runAction(() => switchSession(nextSessionId), nextSessionId)
})
recentList.addEventListener("click", (event) => {
  const nextSessionId = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-session-id]")?.dataset.sessionId
  if (nextSessionId) runAction(() => switchSession(nextSessionId), nextSessionId)
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
  const commandName = target.closest<HTMLButtonElement>("[data-command-prefill]")?.dataset.commandPrefill
  if (commandName) {
    const command = state.slashCommands.find((item) => item.name === commandName)
    if (command) selectSlashCommand(command)
    return
  }
  const commandSessionId = target.closest<HTMLButtonElement>("[data-command-session-id]")?.dataset.commandSessionId
  if (commandSessionId) {
    runAction(() => switchSession(commandSessionId), commandSessionId)
    return
  }
  const questionOption = target.closest<HTMLButtonElement>("[data-question-option-index]")
  if (questionOption && state.conversation.question) {
    const index = Number(questionOption.dataset.questionOptionIndex)
    if (Number.isInteger(index)) {
      const question = state.conversation.question
      const selection = questionSelectionFor(question)
      state.questionSelection = selectQuestionOption(selection, index, question.options.length)
      render()
      if (index === question.options.length) requiredElement<HTMLInputElement>("question-answer").focus()
    }
  }
})
messageStream.addEventListener("input", (event) => {
  const target = event.target as HTMLElement
  if (target.id !== "question-answer" || !(target instanceof HTMLInputElement) || !state.conversation.question) return
  const selection = updateQuestionInput(questionSelectionFor(state.conversation.question), target.value)
  state.questionSelection = selection
  const form = requiredElement<HTMLFormElement>("question-form")
  const confirm = form.querySelector<HTMLButtonElement>("[type=submit]")
  if (confirm) confirm.disabled = !canConfirmQuestion(selection, state.conversation.question.options.length)
})
messageStream.addEventListener("submit", (event) => {
  event.preventDefault()
  if ((event.target as HTMLElement).id !== "question-form") return
  const question = state.conversation.question
  if (!question) return
  const answer = questionAnswer(questionSelectionFor(question), question.options)
  if (answer) runAction(() => answerQuestion(answer), state.viewedSessionId)
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
  if (recentFlushPromise) return recentFlushPromise
  recentFlushPromise = (async () => {
    while (state.pendingRecentSessionIds.size) {
      const sessionIds = [...state.pendingRecentSessionIds]
      for (const sessionId of sessionIds) {
        const overview = await window.api.projects.markRecent(sessionId)
        applyOverview(overview)
        if (overview.recentSessions.some((session) => session.id === sessionId)) state.pendingRecentSessionIds.delete(sessionId)
      }
    }
  })().finally(() => {
    recentFlushPromise = undefined
  })
  return recentFlushPromise
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
  closeComposerSelectMenus()
  state.viewedSessionId = ""
  state.conversationCache = {}
  state.sessionModels = {}
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

function resolveNewChatProjectPath() {
  return defaultNewChatProjectPath(state.projects, state.recentSessions, state.fallbackProjectPath)
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
  if (state.expandedProjects.has(path)) {
    const trigger = [...projectList.querySelectorAll<HTMLButtonElement>("[data-project-path]")]
      .find((item) => item.dataset.projectPath === path)
    const sessions = trigger?.closest<HTMLElement>(".project-item")?.querySelector<HTMLElement>(".project-sessions")
    if (sessions && !sessions.classList.contains("collapsing") && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          window.clearTimeout(timeoutId)
          sessions.removeEventListener("animationend", finish)
          resolve()
        }
        sessions.style.height = `${sessions.offsetHeight}px`
        sessions.classList.add("collapsing")
        sessions.addEventListener("animationend", finish, { once: true })
        requestAnimationFrame(() => { sessions.style.height = "0px" })
        const timeoutId = window.setTimeout(finish, 260)
      })
    }
    state.expandedProjects.delete(path)
    projectList.classList.add("skip-project-animation")
  } else {
    state.expandedProjects.add(path)
  }
  state.notice = ""
  render()
  if (projectList.classList.contains("skip-project-animation")) {
    requestAnimationFrame(() => projectList.classList.remove("skip-project-animation"))
  }
}

async function removeProject(path: string) {
  const project = state.projects.find((item) => item.path === path)
  if (!project) return
  if (!window.confirm(`Remove ${project.name} from Rind Desktop? Its folder and sessions will be kept.`)) return
  const removesViewedProject = samePath(path, state.viewedProjectPath)
  const removesChatProject = samePath(path, state.chatProjectPath)
  const overview = await window.api.projects.remove(path)
  applyOverview(overview)
  delete state.drafts[path]
  if (removesViewedProject || removesChatProject) {
    state.chatProjectPath = resolveNewChatProjectPath()
    state.viewedProjectPath = state.chatProjectPath
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
  closeComposerSelectMenus()
  if (state.chatProjectPath) state.drafts[state.chatProjectPath] = prompt.value
  state.chatProjectPath = resolveNewChatProjectPath()
  state.viewedProjectPath = state.chatProjectPath
  const project = chatProject()
  if (!project?.available) {
    await addProject(true)
    return
  }
  state.viewedSessionId = ""
  state.model = state.settings.model
  state.filesOpen = false
  state.filePreview = undefined
  state.fileListings = {}
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
  const projectPath = project.path
  const listing = await window.api.files.list(projectPath, path)
  if (!samePath(viewedProject()?.path || "", projectPath)) return
  state.fileListings = { ...state.fileListings, [path]: listing }
  render()
}

async function toggleDirectory(path: string) {
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

async function previewFile(path: string) {
  const project = viewedProject()
  if (!project) return
  const projectPath = project.path
  const preview = await window.api.files.preview(projectPath, path)
  if (!samePath(viewedProject()?.path || "", projectPath)) return
  state.filePreview = preview
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
  if (nextSessionId === state.viewedSessionId) return
  const session = knownSessions().find((item) => item.id === nextSessionId)
  if (!session) {
    state.notice = "This session is unavailable in the registered Desktop projects."
    render()
    return
  }
  const project = projectForPath(session.workspaceRoot)
  if (!project) return
  closeComposerSelectMenus()
  showCachedSession(nextSessionId)
  state.viewedSessionId = nextSessionId
  state.model = state.sessionModels[nextSessionId] || ""
  state.viewedProjectPath = project.path
  state.chatProjectPath = project.path
  state.expandedDirectories = new Set([""])
  state.fileListings = {}
  state.filePreview = undefined
  render()
  await loadReplay(nextSessionId)
  if (state.viewedSessionId !== nextSessionId) return
  if (state.filesOpen && viewedProject()?.available) await loadDirectory("")
  render()
}

async function selectChatProject(path: string) {
  if (state.viewedSessionId) return
  const project = state.projects.find((item) => item.path === path)
  if (!project) return
  closeComposerSelectMenus()
  if (state.chatProjectPath) state.drafts[state.chatProjectPath] = prompt.value
  state.chatProjectPath = project.path
  state.viewedProjectPath = project.path
  state.viewedSessionId = ""
  state.model = state.settings.model
  state.conversation = createConversation()
  state.expandedDirectories = new Set([""])
  state.fileListings = {}
  state.filePreview = undefined
  resetConversationPresentation()
  restoreProjectDraft()
  if (state.filesOpen && project.available) await loadDirectory("")
  render()
}

function showCachedSession(sessionId: string) {
  if (sessionId === state.viewedSessionId) return
  const cache = { ...state.conversationCache }
  if (state.viewedSessionId) cache[state.viewedSessionId] = state.conversation
  state.viewedSessionId = sessionId
  state.conversation = cache[sessionId] || createConversation()
  state.conversationCache = cache
  resetConversationPresentation()
}

async function answerQuestion(answer: string) {
  const sessionId = state.viewedSessionId
  if (!sessionTurnActive(sessionId)) return
  const question = state.conversation.question
  if (!question) return
  state.conversation = { ...state.conversation, question: undefined }
  state.questionSelection = undefined
  render()
  await requestForSession(runtimeMethods.userQuestionRespond, sessionId, { tool_call_id: question.toolCallId, answer })
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
    const runtimeConfigChanged = Boolean(apiKey)
      || settingsBaseUrl.value.trim() !== state.settings.baseUrl
      || settingsModel.value.trim() !== state.settings.model
      || settingsReasoning.value.trim() !== state.settings.reasoningEffort
    const hasRunningRuntime = state.runtime.status === "starting" || state.runtime.status === "ready"
    state.settings = await window.api.settings.save({
      ...(apiKey ? { apiKey } : {}),
      model: settingsModel.value.trim(),
      baseUrl: settingsBaseUrl.value.trim(),
      reasoningEffort: settingsReasoning.value.trim(),
    }, state.chatProjectPath || state.fallbackProjectPath)
    state.settingsOpen = false
    state.settingsAutoOpened = true
    state.notice = runtimeConfigChanged && hasRunningRuntime
      ? "Settings saved. Existing runtimes keep their current configuration until they restart."
      : "Settings saved."
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    state.settingsSaving = false
    render()
  }
}

const unsubscribeStatus = window.api.runtime.subscribe((snapshot) => {
  state.runtime = snapshot
  if (snapshot.status !== "ready") {
    lastRuntimeSequence = 0
    clearRuntimeTurnState()
  }
  if (snapshot.status === "error") {
    clearSlashCommandPending()
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
