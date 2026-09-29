import { type DesktopTheme, type RuntimeSnapshot } from "../../preload/types.ts"
import { type IconNode } from "lucide"
import { Moon, renderIcon, Sun, SunMoon } from "../icons.ts"
import { renderComposer, renderPlanDock, syncPendingInputDock } from "../composer-region.ts"
import { renderAttachments } from "./attachments-ui.ts"
import { renderEffortMenu, renderModels, renderProjectControl } from "./composer-menus.ts"
import { renderSlashCommandMenu } from "./composer.ts"
import { appRoot, attachButton, compactContext, composerMenu, composerMenuTrigger, connection, connectionText, contextMeter, interrupt, newSessionButton, notice, noticeText, pendingInputDock, planDock, planDockShell, prompt, retry, send, shortcutsDialog, shortcutTable, sidebar, sidebarToggle, slashCommandMenu } from "./dom.ts"
import { escapeHtml } from "./html.ts"
import { renderInspector } from "./inspector.ts"
import { renderPalette } from "./palette-ui.ts"
import { promoteFollowUp, recallPendingInput } from "./pending-inputs.ts"
import { activeTurnIdFor, runAction, runtimeTurnActive } from "./runtime.ts"
import { applyOverview, chatProject, currentRuntimeSnapshot } from "./sessions.ts"
import { renderSessionHead } from "./session-head.ts"
import { renderSettings } from "./settings.ts"
import { renderProjects, renderRecentSessions } from "./sidebar.ts"
import { state, vars } from "./state.ts"
import { renderStream, syncWorkingTimer } from "./stream.ts"



export function render() {
  const runtime = currentRuntimeSnapshot()
  state.runtime = runtime
  connectionText.textContent = runtimeStatusLabel(runtime.status)
  connection.className = `connection connection-${runtime.status}`
  connection.hidden = runtime.status === "starting"
  appRoot.classList.toggle("sidebar-open", state.sidebarOpen)
  appRoot.style.setProperty("--sidebar-panel-width", `${state.sidebarOpen ? state.sidebarWidth : 0}px`)
  sidebar.setAttribute("aria-hidden", String(!state.sidebarOpen))
  sidebar.inert = !state.sidebarOpen
  newSessionButton.title = chatProject()?.available ? `Start a new chat in ${chatProject()?.name}` : "Choose a project for a new chat"
  const sidebarLabel = state.sidebarOpen ? "Hide projects sidebar" : "Show projects sidebar"
  sidebarToggle.dataset.tooltip = sidebarLabel
  sidebarToggle.setAttribute("aria-label", sidebarLabel)
  sidebarToggle.setAttribute("aria-expanded", String(state.sidebarOpen))
  renderSessionHead()
  noticeText.textContent = state.notice || runtime.message || ""
  retry.hidden = runtime.status !== "error"
  notice.hidden = !noticeText.textContent && retry.hidden
  renderProjectControl()
  renderRecentSessions()
  renderProjects()
  renderModels()
  renderEffortMenu()
  renderInspector()
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
    toggle.dataset.tooltip = label
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

/** Sidebar drag-resize; the inspector has its own handler in inspector.ts. */
export function bindSidebarResize(handle: HTMLElement) {
  handle.addEventListener("pointerdown", (event) => {
    if (!state.sidebarOpen) return
    const width = state.sidebarWidth
    vars.resizeStart = { target: "sidebar", pointerId: event.pointerId, x: event.clientX, width, lastWidth: width }
    handle.setPointerCapture(event.pointerId)
    document.body.classList.add("resizing-panel")
    event.preventDefault()
  })
  handle.addEventListener("pointermove", (event) => {
    const start = vars.resizeStart
    if (!start || start.target !== "sidebar" || start.pointerId !== event.pointerId) return
    const width = Math.round(start.width + event.clientX - start.x)
    vars.resizeStart = { ...start, lastWidth: width }
    state.sidebarWidth = Math.max(0, Math.min(SIDEBAR_MAX, width))
    render()
  })
  handle.addEventListener("pointerup", (event) => finishSidebarResize(handle, event))
  handle.addEventListener("lostpointercapture", () => { vars.resizeStart = undefined; document.body.classList.remove("resizing-panel") })
}

function finishSidebarResize(handle: HTMLElement, event: PointerEvent) {
  if (!vars.resizeStart || vars.resizeStart.target !== "sidebar" || vars.resizeStart.pointerId !== event.pointerId) return
  handle.releasePointerCapture(event.pointerId)
  vars.resizeStart = undefined
  document.body.classList.remove("resizing-panel")
  runAction(async () => {
    const sidebarOpen = state.sidebarWidth >= SIDEBAR_COLLAPSE
    state.sidebarWidth = sidebarOpen ? Math.max(SIDEBAR_MIN, state.sidebarWidth) : SIDEBAR_DEFAULT
    applyOverview(await window.api.projects.updateLayout({ sidebarOpen, sidebarWidth: state.sidebarWidth }))
    render()
  })
}
