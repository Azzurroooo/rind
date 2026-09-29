import { type DesktopTheme, type RuntimeSnapshot } from "../../preload/types.ts"
import { type IconNode } from "lucide"
import { Moon, renderIcon, Sun, SunMoon } from "../icons.ts"
import { renderComposer, renderPlanDock, syncPendingInputDock } from "../composer-region.ts"
import { renderAttachments } from "./attachments-ui.ts"
import { renderEffortMenu, renderModels, renderProjectControl } from "./composer-menus.ts"
import { renderSlashCommandMenu } from "./composer.ts"
import { appRoot, attachButton, compactContext, composerMenu, composerMenuTrigger, connection, connectionText, contextMeter, filePanel, interrupt, newSessionButton, notice, noticeText, pendingInputDock, planDock, planDockShell, prompt, requiredElement, retry, send, sessionIdLabel, sessionTitle, shortcutsDialog, shortcutTable, sidebar, sidebarToggle, slashCommandMenu } from "./dom.ts"
import { renderFiles } from "./files-panel.ts"
import { escapeHtml } from "./html.ts"
import { renderGoalDock, renderTaskMonitorDock } from "./inspector.ts"
import { renderPalette } from "./palette-ui.ts"
import { promoteFollowUp, recallPendingInput } from "./pending-inputs.ts"
import { activeTurnIdFor, runAction, runtimeTurnActive } from "./runtime.ts"
import { applyOverview, chatProject, currentRuntimeSnapshot, knownSessions } from "./sessions.ts"
import { renderSettings } from "./settings.ts"
import { renderProjects, renderRecentSessions } from "./sidebar.ts"
import { state, vars } from "./state.ts"
import { renderStream, syncWorkingTimer } from "./stream.ts"



export function render() {
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
  sessionIdLabel.textContent = state.model || chatProject()?.name || "Select a project to begin"
  sessionIdLabel.title = state.viewedSessionId || ""
  requiredElement<HTMLButtonElement>("export-session").disabled = !state.conversation.entries.length
  requiredElement<HTMLButtonElement>("fork-session").disabled = !state.viewedSessionId || runtimeTurnActive()
  noticeText.textContent = state.notice || runtime.message || ""
  retry.hidden = runtime.status !== "error"
  notice.hidden = !noticeText.textContent && retry.hidden
  renderProjectControl()
  renderRecentSessions()
  renderProjects()
  renderModels()
  renderEffortMenu()
  renderTaskMonitorDock()
  renderGoalDock()
  renderPalette()
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
    { prompt, send, interrupt, menuTrigger: composerMenuTrigger, menu: composerMenu, compactContext, slashCommandMenu, contextMeter, attachButton },
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
  renderAttachments()
  renderFiles()
  renderSettings()
  renderTheme()
  renderShortcuts()
  syncWorkingTimer()
}

export function renderTheme() {
  const resolved = resolveTheme()
  if (document.documentElement.dataset.theme !== resolved) document.documentElement.dataset.theme = resolved
  const toggle = document.getElementById("toggle-theme")
  if (toggle) {
    const icons: Record<DesktopTheme, IconNode> = { system: SunMoon, dark: Moon, light: Sun }
    const label = `Theme: ${state.theme}. Switch to ${nextTheme()}.`
    if (toggle.dataset.themeIcon !== state.theme) {
      toggle.innerHTML = renderIcon(icons[state.theme])
      toggle.dataset.themeIcon = state.theme
    }
    toggle.title = label
    toggle.setAttribute("aria-label", label)
  }
}

export function resolveTheme(): "dark" | "light" {
  if (state.theme === "system") return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
  return state.theme
}

export function nextTheme(): DesktopTheme {
  return state.theme === "system" ? "dark" : state.theme === "dark" ? "light" : "system"
}

export function setTheme(theme: DesktopTheme) {
  state.theme = theme
  renderTheme()
  runAction(async () => {
    await window.api.prefs.update({ theme })
  })
}

export function renderShortcuts() {
  if (state.shortcutsOpen && !shortcutsDialog.open) shortcutsDialog.showModal()
  if (!state.shortcutsOpen && shortcutsDialog.open) shortcutsDialog.close()
  if (shortcutTable.dataset.rendered) return
  shortcutTable.dataset.rendered = "1"
  shortcutTable.innerHTML = shortcutRows.map(([combo, label]) => `
    <div class="shortcut-row"><span>${escapeHtml(label)}</span><code>${escapeHtml(combo)}</code></div>
  `).join("")
}

export const shortcutRows: Array<[string, string]> = [
  ["Ctrl+K", "Command palette"],
  ["Ctrl+N", "New chat"],
  ["Ctrl+B", "Toggle sidebar"],
  ["Ctrl+,", "Open settings"],
  ["Ctrl+1…9", "Switch to a loaded session"],
  ["Enter", "Send message"],
  ["Shift+Enter", "New line"],
  ["Enter (running)", "Queue a follow-up"],
  ["Alt+Enter (running)", "Steer the running turn"],
  ["Up (empty composer)", "Recall the last prompt"],
  ["Esc", "Close menus / stop turn / focus composer"],
  ["?", "This cheat sheet"],
]

export function runtimeStatusLabel(status: RuntimeSnapshot["status"]) {
  if (status === "starting") return "Preparing"
  if (status === "ready") return "Ready"
  if (status === "stopping") return "Stopping"
  if (status === "error") return "Needs attention"
  return "Idle"
}

export function scheduleRender() {
  const animationDelay = vars.toolAnimationUntil - performance.now()
  if (animationDelay > 0) {
    if (vars.renderTimer === undefined) {
      vars.renderTimer = setTimeout(() => {
        vars.renderTimer = undefined
        scheduleRender()
      }, animationDelay)
    }
    return
  }
  if (vars.renderFrame !== undefined) return
  vars.renderFrame = requestAnimationFrame(() => {
    vars.renderFrame = undefined
    render()
  })
}

// Sidebar width range from spec section 2; dragging below the collapse point closes it.
const SIDEBAR_MIN = 232
const SIDEBAR_MAX = 360
const SIDEBAR_DEFAULT = 264
const SIDEBAR_COLLAPSE = 160

export async function toggleSidebar() {
  applyOverview(await window.api.projects.updateLayout({ sidebarOpen: !state.sidebarOpen }))
  render()
}

export function usesWideFileLayout() {
  if (!state.filesOpen || !state.filePreview || window.innerWidth < 1180) return false
  const sidebarWidth = state.sidebarOpen ? state.sidebarWidth : 0
  return state.filePanelWidth >= 520 && window.innerWidth - sidebarWidth - state.filePanelWidth >= 440
}

export function startResize(handle: HTMLElement, target: "sidebar" | "files") {
  handle.addEventListener("pointerdown", (event) => {
    if ((target === "sidebar" && !state.sidebarOpen) || (target !== "sidebar" && !state.filesOpen)) return
    const width = target === "sidebar" ? state.sidebarWidth : state.filePanelWidth
    vars.resizeStart = { target, pointerId: event.pointerId, x: event.clientX, width, lastWidth: width }
    handle.setPointerCapture(event.pointerId)
    document.body.classList.add("resizing-panel")
    event.preventDefault()
  })
  handle.addEventListener("pointermove", (event) => {
    if (!vars.resizeStart || vars.resizeStart.target !== target || vars.resizeStart.pointerId !== event.pointerId) return
    const delta = target === "sidebar" ? event.clientX - vars.resizeStart.x : vars.resizeStart.x - event.clientX
    const width = Math.round(vars.resizeStart.width + delta)
    vars.resizeStart.lastWidth = width
    if (target === "sidebar") state.sidebarWidth = Math.max(0, Math.min(SIDEBAR_MAX, width))
    else state.filePanelWidth = Math.max(0, Math.min(900, width))
    render()
  })
  handle.addEventListener("pointerup", (event) => finishResize(handle, event))
  handle.addEventListener("lostpointercapture", () => { vars.resizeStart = undefined; document.body.classList.remove("resizing-panel") })
}

export function finishResize(handle: HTMLElement, event: PointerEvent) {
  if (!vars.resizeStart || vars.resizeStart.pointerId !== event.pointerId) return
  const { target, lastWidth } = vars.resizeStart
  handle.releasePointerCapture(event.pointerId)
  vars.resizeStart = undefined
  document.body.classList.remove("resizing-panel")
  runAction(async () => {
    if (target === "sidebar") {
      const sidebarOpen = state.sidebarWidth >= SIDEBAR_COLLAPSE
      state.sidebarWidth = sidebarOpen ? Math.max(SIDEBAR_MIN, state.sidebarWidth) : SIDEBAR_DEFAULT
      applyOverview(await window.api.projects.updateLayout({ sidebarOpen, sidebarWidth: state.sidebarWidth }))
    } else {
      const filesOpen = lastWidth >= 240
      state.filePanelWidth = Math.max(280, state.filePanelWidth || 480)
      applyOverview(await window.api.projects.updateLayout({ filesOpen, filePanelWidth: state.filePanelWidth }))
    }
    render()
  })
}
