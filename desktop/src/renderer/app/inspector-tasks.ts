// Inspector Activity tab: the yielded-running task monitor (rind/task/list +
// read + cancel) rendered by task-monitor.ts. Finished tasks stay in the
// transcript, so there is no history section and no pagination.

import { runtimeMethods } from "../../preload/types.ts"
import { createTaskMonitorState, readTaskOutput, refreshTasks, renderTaskMonitor, runningTaskCount } from "../task-monitor.ts"
import { inspector, taskMonitorDock } from "./dom.ts"
import { requestForSession, runAction } from "./runtime.ts"
import { currentRuntimeSnapshot } from "./sessions.ts"
import { state, vars } from "./state.ts"
import { renderActivityEmpty } from "./activity-empty.ts"

const POLL_INTERVAL_MS = 4000
const OUTPUT_CHARS = 20000

function activityTabVisible() {
  return state.inspectorOpen && !inspector.inert && state.inspectorTab === "activity" && !document.hidden
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
  const label = running ? `Activity, ${running} background ${running === 1 ? "command" : "commands"} running` : "Activity"
  toggle.setAttribute("aria-label", label)
  toggle.dataset.tooltip = label
  toggle.setAttribute("aria-expanded", String(activityTabVisible()))
}

export function renderTasksSection() {
  renderTaskMonitor(taskMonitorDock, state.taskMonitor, state.conversation.backgroundWait?.count || 0)
  renderActivityEmpty()
}

/** Poll only while the Activity tab and its window are visible. */
export function syncTaskPolling() {
  const wanted = activityTabVisible() && canPoll()
  if (wanted && !vars.taskMonitorTimer) {
    vars.taskMonitorTimer = setInterval(() => { void pollTasks().catch(() => {}) }, POLL_INTERVAL_MS)
    void pollTasks().catch(() => {})
  } else if (!wanted) {
    stopTaskPolling()
  }
}

export function stopTaskPolling() {
  if (!vars.taskMonitorTimer) return
  clearInterval(vars.taskMonitorTimer)
  vars.taskMonitorTimer = undefined
}

export async function pollTasks() {
  if (!canPoll() || !activityTabVisible()) return
  const monitor = state.taskMonitor
  if (monitor.refreshing) return
  const sessionId = state.viewedSessionId
  const pending = refreshTasks(monitor, () => requestForSession(runtimeMethods.taskList, sessionId))
  renderActivityPanels()
  await pending
  if (monitor !== state.taskMonitor) return
  const expandedId = monitor.expandedId
  if (expandedId && !monitor.cursors[expandedId] && !monitor.reading.has(expandedId)) await loadTaskOutput(expandedId, undefined, true)
  if (monitor === state.taskMonitor) renderActivityPanels()
}

export async function loadTaskOutput(taskId: string, cursor = state.taskMonitor.cursors[taskId], silent = false) {
  const monitor = state.taskMonitor
  const sessionId = state.viewedSessionId
  if (!sessionId) return
  const pending = readTaskOutput(monitor, (id, position) => requestForSession(runtimeMethods.taskRead, sessionId, {
    task_id: id, max_output_chars: OUTPUT_CHARS, ...(position ? { cursor: position } : {}),
  }), taskId, cursor)
  if (!silent) renderActivityPanels()
  await pending
  if (monitor === state.taskMonitor) renderActivityPanels()
}

export function resetTasks() {
  state.taskMonitor = createTaskMonitorState()
}

function renderActivityPanels() {
  renderTaskBadge()
  if (activityTabVisible()) renderTasksSection()
}

export function bindTasksEvents(): void {
  document.addEventListener("visibilitychange", syncTaskPolling)
  taskMonitorDock.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
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
          await requestForSession(runtimeMethods.taskCancel, sessionId, { task_id: taskId })
          if (state.viewedSessionId === sessionId) await pollTasks()
        } finally { action.disabled = false }
      }, sessionId)
      return
    }
    const bgId = target.closest<HTMLButtonElement>("[data-toggle-task]")?.dataset.toggleTask
    if (!bgId) return
    state.taskMonitor.expandedId = state.taskMonitor.expandedId === bgId ? "" : bgId
    renderActivityPanels()
    if (state.taskMonitor.expandedId) void loadTaskOutput(state.taskMonitor.expandedId)
  })
}
