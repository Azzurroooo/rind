// Inspector (spec section 2): a dismissible right column with Context, Tasks,
// Files, Goal, and Usage tabs. Its open state and width persist through the
// project layout (filesOpen and filePanelWidth keys in the main process).

import { runtimeMethods } from "../../preload/types.ts"
import { contextDisplayFrom, renderContextDisplay } from "../context-report.ts"
import { clampInspectorWidth, INSPECTOR_CLOSE_WIDTH, INSPECTOR_TABS, INSPECTOR_WIDTH, inspectorFits, isInspectorTab, nextInspectorTab, normalizeUsageSummary, renderUsageSummary, type InspectorTab } from "../inspector-model.ts"
import { appRoot, inspector, inspectorContextBody, inspectorResizeHandle, inspectorToggle, inspectorUsageBody, requiredElement } from "./dom.ts"
import { loadDirectory, renderFiles } from "./files-panel.ts"
import { escapeHtml } from "./html.ts"
import { focusGoalInput, loadGoal, renderGoalTab } from "./inspector-goal.ts"
import { loadBackgroundHistory, pollTasks, renderTaskBadge, renderTasksTab, syncTaskPolling } from "./inspector-tasks.ts"
import { request, requestForSession, runAction } from "./runtime.ts"
import { applyOverview, currentRuntimeSnapshot, viewedProject } from "./sessions.ts"
import { render } from "./shell.ts"
import { emptyLoad, state, vars } from "./state.ts"
import { type InspectorLoad } from "./types.ts"

/** Matches the 760px drawer breakpoint used by the stylesheets. */
const MOBILE_MAX_WIDTH = 760
const USAGE_DAYS = 7

/** Open, and either on a mobile drawer or with room left for the conversation. */
export function inspectorShown() {
  if (!state.inspectorOpen) return false
  if (window.innerWidth <= MOBILE_MAX_WIDTH) return true
  return inspectorFits(window.innerWidth, state.sidebarOpen ? state.sidebarWidth : 0, state.inspectorWidth)
}

export function renderInspector() {
  const shown = inspectorShown()
  appRoot.classList.toggle("inspector-open", shown)
  appRoot.style.setProperty("--inspector-width", `${shown ? state.inspectorWidth : 0}px`)
  inspector.setAttribute("aria-hidden", String(!shown))
  inspector.inert = !shown
  const label = state.inspectorOpen ? "Hide inspector" : "Show inspector"
  inspectorToggle.dataset.tooltip = label
  inspectorToggle.setAttribute("aria-label", label)
  inspectorToggle.setAttribute("aria-expanded", String(shown))
  renderTaskBadge()
  for (const tab of INSPECTOR_TABS) {
    const selected = tab === state.inspectorTab
    const button = requiredElement(`inspector-tab-${tab}`)
    button.setAttribute("aria-selected", String(selected))
    button.tabIndex = selected ? 0 : -1
    requiredElement(`inspector-panel-${tab}`).hidden = !selected
  }
  if (!shown) return
  const renderers: Record<InspectorTab, () => void> = {
    context: () => { inspectorContextBody.innerHTML = renderLoad(state.inspectorContext, "Loading context…", (display) => renderContextDisplay(display), contextEmptyText()) },
    tasks: renderTasksTab,
    files: renderFiles,
    goal: renderGoalTab,
    usage: () => { inspectorUsageBody.innerHTML = renderLoad(state.inspectorUsage, "Loading usage…", renderUsageSummary, "Usage appears once the runtime is ready.") },
  }
  renderers[state.inspectorTab]()
}

function contextEmptyText() {
  return state.viewedSessionId ? "Context appears once the runtime is ready." : "Open a session to inspect its context."
}

function renderLoad<T>(load: InspectorLoad<T>, loadingText: string, present: (value: T) => string, emptyText: string) {
  if (load.error) return `<p class="inspector-empty" role="alert">${escapeHtml(load.error)}</p>`
  if (load.value !== undefined) return present(load.value)
  return `<p class="inspector-empty">${escapeHtml(load.loading ? loadingText : emptyText)}</p>`
}

async function persistInspector(patch: { filesOpen?: boolean; filePanelWidth?: number }) {
  applyOverview(await window.api.projects.updateLayout(patch))
}

/** Opens the inspector on a tab (the current one when omitted) and loads it. */
export async function openInspector(tab: InspectorTab = state.inspectorTab) {
  state.inspectorTab = tab
  if (!state.inspectorOpen) {
    state.inspectorOpen = true
    render()
    await persistInspector({ filesOpen: true })
  }
  render()
  syncTaskPolling()
  await loadInspectorTab(tab)
}

export async function closeInspector() {
  state.inspectorOpen = false
  render()
  syncTaskPolling()
  await persistInspector({ filesOpen: false })
  render()
}

export async function toggleInspector(tab?: InspectorTab) {
  if (state.inspectorOpen && (!tab || tab === state.inspectorTab)) await closeInspector()
  else await openInspector(tab)
}

/** Reloads the visible tab; called after session switches and turn completion. */
export async function refreshInspector() {
  syncTaskPolling()
  if (inspectorShown()) await loadInspectorTab(state.inspectorTab)
}

/** Drops data that belongs to the previous session. */
export function resetInspectorData() {
  state.inspectorContext = emptyLoad()
}

async function loadInspectorTab(tab: InspectorTab) {
  if (tab === "context") await loadInspectorContext()
  else if (tab === "usage") await loadInspectorUsage()
  else if (tab === "goal") await loadGoal()
  else if (tab === "files" && viewedProject()?.available) await loadDirectory("")
}

async function fetchInto<T>(
  current: () => InspectorLoad<T>,
  assign: (load: InspectorLoad<T>) => void,
  sessionId: string,
  fetchValue: () => Promise<T>,
) {
  if (current().loading || currentRuntimeSnapshot().status !== "ready") return
  assign({ ...current(), sessionId, loading: true, error: "" })
  render()
  try {
    const value = await fetchValue()
    if (sessionId === current().sessionId) assign({ sessionId, loading: false, error: "", value })
  } catch (error) {
    if (sessionId === current().sessionId) assign({ sessionId, loading: false, error: error instanceof Error ? error.message : String(error) })
  }
  render()
}

export async function loadInspectorContext() {
  const sessionId = state.viewedSessionId
  if (!sessionId) {
    state.inspectorContext = emptyLoad()
    render()
    return
  }
  await fetchInto(() => state.inspectorContext, (load) => { state.inspectorContext = load }, sessionId,
    async () => contextDisplayFrom(await requestForSession(runtimeMethods.contextInspect, sessionId)))
}

export async function loadInspectorUsage() {
  await fetchInto(() => state.inspectorUsage, (load) => { state.inspectorUsage = load }, "",
    async () => normalizeUsageSummary(await request(runtimeMethods.usageSummary, { days: USAGE_DAYS })))
}

export function selectInspectorTab(tab: InspectorTab, focus = false) {
  state.inspectorTab = tab
  render()
  if (focus) requiredElement(`inspector-tab-${tab}`).focus()
  syncTaskPolling()
  runAction(() => loadInspectorTab(tab), state.viewedSessionId)
}

/** Opens the Goal tab with the objective input focused (/goal, #toggle-goal). */
export async function openGoalTab() {
  state.goal = { ...state.goal, setOpen: state.goal.setOpen || !state.goal.value }
  await openInspector("goal")
  focusGoalInput()
}

function bindResize() {
  inspectorResizeHandle.addEventListener("pointerdown", (event) => {
    if (!inspectorShown()) return
    vars.resizeStart = { target: "inspector", pointerId: event.pointerId, x: event.clientX, width: state.inspectorWidth, lastWidth: state.inspectorWidth }
    inspectorResizeHandle.setPointerCapture(event.pointerId)
    document.body.classList.add("resizing-panel")
    event.preventDefault()
  })
  inspectorResizeHandle.addEventListener("pointermove", (event) => {
    const start = vars.resizeStart
    if (!start || start.target !== "inspector" || start.pointerId !== event.pointerId) return
    const width = Math.round(start.width + start.x - event.clientX)
    vars.resizeStart = { ...start, lastWidth: width }
    state.inspectorWidth = Math.max(INSPECTOR_CLOSE_WIDTH, Math.min(INSPECTOR_WIDTH.max, width))
    render()
  })
  inspectorResizeHandle.addEventListener("pointerup", (event) => {
    const start = vars.resizeStart
    if (!start || start.target !== "inspector" || start.pointerId !== event.pointerId) return
    inspectorResizeHandle.releasePointerCapture(event.pointerId)
    vars.resizeStart = undefined
    document.body.classList.remove("resizing-panel")
    const keepOpen = start.lastWidth > INSPECTOR_CLOSE_WIDTH
    state.inspectorWidth = keepOpen ? clampInspectorWidth(state.inspectorWidth) : start.width
    if (!keepOpen) state.inspectorOpen = false
    render()
    syncTaskPolling()
    runAction(() => persistInspector({ filesOpen: keepOpen, filePanelWidth: state.inspectorWidth }))
  })
  inspectorResizeHandle.addEventListener("lostpointercapture", () => {
    vars.resizeStart = undefined
    document.body.classList.remove("resizing-panel")
  })
}

export function bindInspectorEvents(): void {
  const tabList = inspector.querySelector<HTMLElement>("[role=tablist]")
  tabList?.addEventListener("click", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-inspector-tab]")?.dataset.inspectorTab
    if (isInspectorTab(tab)) selectInspectorTab(tab)
  })
  tabList?.addEventListener("keydown", (event) => {
    const next = nextInspectorTab(state.inspectorTab, event.key)
    if (!next) return
    event.preventDefault()
    selectInspectorTab(next, true)
  })
  inspector.addEventListener("click", (event) => {
    const refresh = (event.target as HTMLElement).closest<HTMLElement>("[data-inspector-refresh]")?.dataset.inspectorRefresh
    if (refresh === "context") runAction(loadInspectorContext, state.viewedSessionId)
    else if (refresh === "usage") runAction(loadInspectorUsage)
    else if (refresh === "tasks") runAction(() => Promise.all([pollTasks(), loadBackgroundHistory()]).then(() => undefined), state.viewedSessionId)
  })
  inspector.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return
    if ((event.target as HTMLElement).closest("input, textarea")) return
    event.preventDefault()
    event.stopPropagation()
    runAction(closeInspector)
    inspectorToggle.focus()
  })
  requiredElement("close-inspector").addEventListener("click", () => runAction(closeInspector))
  inspectorToggle.addEventListener("click", () => runAction(() => toggleInspector()))
  document.getElementById("toggle-tasks")?.addEventListener("click", () => runAction(() => toggleInspector("tasks")))
  bindResize()
}
