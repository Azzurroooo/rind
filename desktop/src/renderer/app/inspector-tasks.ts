// Inspector Tasks tab: the live monitor (rind/task/list + read, cancel,
// release) rendered by task-monitor.ts, and finished-task history from
// rind/background/list + output rendered by inspector-model.ts.

import { runtimeMethods } from "../../preload/types.ts"
import { normalizeBackgroundList, normalizeBackgroundOutput, renderBackgroundHistory } from "../inspector-model.ts"
import { readTaskOutput, refreshTaskPages, renderTaskMonitor, runningTaskCount } from "../task-monitor.ts"
import { taskHistory, taskMonitorDock } from "./dom.ts"
import { requestForSession, runAction } from "./runtime.ts"
import { currentRuntimeSnapshot } from "./sessions.ts"
import { createBackgroundHistory, state, vars } from "./state.ts"

const POLL_INTERVAL_MS = 2000
const HISTORY_OUTPUT_CHARS = 20000

function tasksTabVisible() {
  return state.inspectorOpen && state.inspectorTab === "tasks"
}

function canPoll() {
  return Boolean(state.viewedSessionId) && currentRuntimeSnapshot().status === "ready"
}

/** Topbar badge and label; runs on every render, whichever tab is open. */
export function renderTaskBadge() {
  const running = runningTaskCount(state.taskMonitor.tasks)
  const badge = document.getElementById("task-count-badge")
  if (badge) {
    badge.hidden = !running
    badge.textContent = running ? String(running) : ""
  }
  const toggle = document.getElementById("toggle-tasks")
  if (!toggle) return
  const label = running ? `Background tasks, ${running} running` : "Background tasks"
  toggle.setAttribute("aria-label", label)
  toggle.dataset.tooltip = label
  toggle.setAttribute("aria-expanded", String(tasksTabVisible()))
}

export function renderTasksTab() {
  renderTaskMonitor(taskMonitorDock, state.taskMonitor)
  taskHistory.innerHTML = renderBackgroundHistory(state.backgroundHistory)
}

/** Starts or stops the 2s poll so it only runs while the Tasks tab is shown. */
export function syncTaskPolling() {
  const wanted = tasksTabVisible() && canPoll()
  if (wanted && !vars.taskMonitorTimer) {
    vars.taskMonitorTimer = setInterval(() => { void pollTasks().catch(() => {}) }, POLL_INTERVAL_MS)
    void pollTasks().catch(() => {})
    void loadBackgroundHistory().catch(() => {})
  } else if (!wanted) {
    stopTaskPolling()
  }
}

export function stopTaskPolling() {
  if (!vars.taskMonitorTimer) return
  clearInterval(vars.taskMonitorTimer)
  vars.taskMonitorTimer = undefined
}

export async function pollTasks(more = false) {
  if (!canPoll()) return
  const monitor = state.taskMonitor
  if (monitor.refreshing) return
  const sessionId = state.viewedSessionId
  const runningBefore = runningTaskCount(monitor.tasks)
  const pending = refreshTaskPages(monitor, (token) => requestForSession(runtimeMethods.taskList, sessionId, token ? { page_token: token } : {}), more)
  renderTasksPanels()
  await pending
  if (monitor !== state.taskMonitor) return
  const expandedId = monitor.expandedId
  if (expandedId && !monitor.reading.has(expandedId)) await loadTaskOutput(expandedId)
  // A task that just finished moves from the monitor into the history list.
  if (runningTaskCount(monitor.tasks) < runningBefore) void loadBackgroundHistory().catch(() => {})
  if (monitor === state.taskMonitor) renderTasksPanels()
}

export async function loadTaskOutput(taskId: string, cursor = state.taskMonitor.cursors[taskId]) {
  const monitor = state.taskMonitor
  const sessionId = state.viewedSessionId
  if (!sessionId) return
  const pending = readTaskOutput(monitor, (id, position) => requestForSession(runtimeMethods.taskRead, sessionId, {
    task_id: id, max_output_chars: HISTORY_OUTPUT_CHARS, ...(position ? { cursor: position } : {}),
  }), taskId, cursor)
  renderTasksPanels()
  await pending
  if (monitor === state.taskMonitor) renderTasksPanels()
}

export async function loadBackgroundHistory() {
  const sessionId = state.viewedSessionId
  const history = state.backgroundHistory
  if (!canPoll() || history.loading) return
  state.backgroundHistory = { ...history, loading: true }
  renderTasksPanels()
  try {
    const records = normalizeBackgroundList(await requestForSession(runtimeMethods.backgroundList, sessionId))
    if (sessionId !== state.viewedSessionId) return
    state.backgroundHistory = { ...state.backgroundHistory, records, loading: false, error: "" }
  } catch (error) {
    if (sessionId !== state.viewedSessionId) return
    state.backgroundHistory = { ...state.backgroundHistory, loading: false, error: error instanceof Error ? error.message : String(error) }
  }
  renderTasksPanels()
}

async function toggleHistoryRecord(bgId: string) {
  const history = state.backgroundHistory
  const expandedId = history.expandedId === bgId ? "" : bgId
  state.backgroundHistory = { ...history, expandedId }
  renderTasksPanels()
  if (!expandedId || history.outputs[bgId] || history.reading.has(bgId)) return
  const sessionId = state.viewedSessionId
  state.backgroundHistory = { ...state.backgroundHistory, reading: new Set([...history.reading, bgId]) }
  try {
    const output = normalizeBackgroundOutput(await requestForSession(runtimeMethods.backgroundOutput, sessionId, { bg_id: bgId, max_output_chars: HISTORY_OUTPUT_CHARS }))
    if (sessionId !== state.viewedSessionId) return
    state.backgroundHistory = { ...state.backgroundHistory, outputs: { ...state.backgroundHistory.outputs, [bgId]: output } }
  } finally {
    if (sessionId === state.viewedSessionId) {
      const reading = new Set(state.backgroundHistory.reading)
      reading.delete(bgId)
      state.backgroundHistory = { ...state.backgroundHistory, reading }
      renderTasksPanels()
    }
  }
}

export function resetTasks() {
  state.backgroundHistory = createBackgroundHistory()
}

function renderTasksPanels() {
  renderTaskBadge()
  if (tasksTabVisible()) renderTasksTab()
}

export function bindTasksEvents(): void {
  taskMonitorDock.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    if (target.closest("[data-task-more]")) {
      void pollTasks(true)
      return
    }
    const outputAction = target.closest<HTMLButtonElement>("[data-task-output]")
    if (outputAction?.dataset.taskId) {
      const taskId = outputAction.dataset.taskId
      const output = state.taskMonitor.outputs[taskId]
      const mode = outputAction.dataset.taskOutput
      void loadTaskOutput(taskId, mode === "next" ? output?.next_cursor : mode === "start" ? output?.start_cursor : "")
      return
    }
    const action = target.closest<HTMLButtonElement>("[data-task-action]")
    if (action) {
      const sessionId = state.viewedSessionId
      const taskId = action.dataset.taskId
      if (!sessionId || !taskId) return
      action.disabled = true
      runAction(async () => {
        try {
          await requestForSession(action.dataset.taskAction === "cancel" ? runtimeMethods.taskCancel : runtimeMethods.taskReleaseWait, sessionId, { task_id: taskId })
          if (state.viewedSessionId === sessionId) await pollTasks()
        } finally { action.disabled = false }
      }, sessionId)
      return
    }
    const bgId = target.closest<HTMLButtonElement>("[data-toggle-task]")?.dataset.toggleTask
    if (!bgId) return
    state.taskMonitor.expandedId = state.taskMonitor.expandedId === bgId ? "" : bgId
    renderTasksPanels()
    if (state.taskMonitor.expandedId) void loadTaskOutput(state.taskMonitor.expandedId)
  })

  taskHistory.addEventListener("click", (event) => {
    const bgId = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-history-task]")?.dataset.historyTask
    if (bgId) runAction(() => toggleHistoryRecord(bgId), state.viewedSessionId)
  })
}
