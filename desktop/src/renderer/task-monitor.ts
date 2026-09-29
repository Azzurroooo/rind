// The Activity tab's task list belongs to one viewed session. Replacing the
// state when switching sessions isolates responses that are still in flight.

import type { DesktopBackgroundTask } from "../preload/types"
import { escapeHtml } from "./app/html.ts"

const ACTIVE_STATES = new Set(["starting", "running", "cancelling"])

export type TaskMonitorState = {
  tasks: DesktopBackgroundTask[]
  expandedId: string
  outputs: Record<string, DesktopBackgroundTask | undefined>
  cursors: Record<string, string | undefined>
  reads: Record<string, number>
  reading: Set<string>
  refreshing: boolean
  error: string
}

export function createTaskMonitorState(): TaskMonitorState {
  return { tasks: [], expandedId: "", outputs: {}, cursors: {}, reads: {}, reading: new Set(), refreshing: false, error: "" }
}

/** A task is listed only once the agent yielded it and it is still running. */
export function isYieldedRunning(task: DesktopBackgroundTask) {
  return ACTIVE_STATES.has(task.status)
}

export function normalizeTask(record: unknown): DesktopBackgroundTask {
  const value = record && typeof record === "object" && !Array.isArray(record) ? record as Record<string, unknown> : {}
  const meta = value.meta && typeof value.meta === "object" ? value.meta as Record<string, unknown> : {}
  return {
    bg_id: String(value.task_id || value.bg_id || "").trim(),
    status: String(value.status || "unknown"),
    handoff: value.handoff === true,
    command: typeof value.command === "string" ? value.command : undefined,
    elapsed_ms: typeof value.elapsed_ms === "number" && Number.isFinite(value.elapsed_ms) ? value.elapsed_ms : undefined,
    exit_code: typeof value.exit_code === "number" ? value.exit_code : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    stdout: typeof value.stdout === "string" ? value.stdout : undefined,
    stderr: typeof value.stderr === "string" ? value.stderr : undefined,
    truncated: meta.truncated === true || value.truncated === true,
    next_cursor: typeof value.next_cursor === "string" ? value.next_cursor : undefined,
    start_cursor: typeof value.start_cursor === "string" ? value.start_cursor : undefined,
  }
}

// Merges one rind/task/list page into the yielded-and-running list. The
// runtime lists finished handoffs too (they stay undelivered briefly); those
// drop out of the panel here and settle in the transcript instead.
export function mergeTasks(current: DesktopBackgroundTask[], listed: unknown): DesktopBackgroundTask[] {
  const rows = Array.isArray(listed) ? listed : []
  const previous = new Map(current.map((task) => [task.bg_id, task]))
  return rows
    .map((row) => {
      const task = normalizeTask(row)
      const prior = previous.get(task.bg_id)
      // The listing truncates long commands; keep the fuller text across polls.
      const command = [task.command, prior?.command].filter((value): value is string => Boolean(value))
        .sort((left, right) => right.length - left.length)[0]
      return { ...task, ...(command ? { command } : {}) }
    })
    .filter((task) => task.bg_id && task.handoff === true && ACTIVE_STATES.has(task.status))
    .sort((left, right) => left.bg_id.localeCompare(right.bg_id))
}

export async function refreshTasks(state: TaskMonitorState, fetchPage: () => Promise<unknown>) {
  if (state.refreshing) return
  state.refreshing = true
  try {
    const result = await fetchPage() as { tasks?: unknown[] }
    state.tasks = mergeTasks(state.tasks, Array.isArray(result?.tasks) ? result.tasks : [])
    if (!state.tasks.some((task) => task.bg_id === state.expandedId)) state.expandedId = ""
    state.error = ""
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
  } finally { state.refreshing = false }
}

export async function readTaskOutput(state: TaskMonitorState, fetchOutput: (id: string, cursor?: string) => Promise<unknown>, taskId: string, cursor = state.cursors[taskId]) {
  const sequence = (state.reads[taskId] || 0) + 1
  state.reads[taskId] = sequence
  state.reading.add(taskId)
  try {
    const output = normalizeTask(await fetchOutput(taskId, cursor))
    if (state.reads[taskId] !== sequence) return
    state.outputs[taskId] = output
    state.cursors[taskId] = cursor
    state.error = ""
  } catch (error) {
    if (state.reads[taskId] === sequence) state.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (state.reads[taskId] === sequence) state.reading.delete(taskId)
  }
}

export function runningTaskCount(tasks: DesktopBackgroundTask[]) {
  return tasks.length
}

export function taskStatusClass(task: DesktopBackgroundTask) {
  if (task.status === "cancelling") return "pip-paused"
  return "pip-running"
}

// DOM-sync renderer for the Activity tab's task section: one row per yielded
// running command, click to expand polled output. Interactions use
// data-attribute delegation in app/inspector-tasks.ts (data-toggle-task,
// data-task-output, data-task-action).
export function renderTaskMonitor(dock: HTMLElement, state: TaskMonitorState) {
  if (!state.tasks.length) {
    dock.innerHTML = `
      <div class="task-monitor-head">
        <h3 class="inspector-section-title">Tasks</h3>
      </div>
      <p class="inspector-empty">${state.error ? escapeHtml(state.error) : state.refreshing ? "Loading tasks…" : "No background commands are running. Commands Rind yields to the background appear here while they run."}</p>
    `
    return
  }
  const rows = state.tasks.map((task) => {
    const expanded = state.expandedId === task.bg_id
    const output = state.outputs[task.bg_id]
    const outputText = [output?.stdout, output?.stderr].filter((value) => typeof value === "string" && value.length).join("\n")
    return `
      <div class="task-monitor-item${expanded ? " open" : ""}" data-task-id="${escapeHtml(task.bg_id)}">
        <button type="button" class="task-monitor-trigger" data-toggle-task="${escapeHtml(task.bg_id)}" aria-expanded="${String(expanded)}">
          <span class="status-pip ${taskStatusClass(task)}"></span>
          <code class="task-monitor-command">${escapeHtml(task.command || task.bg_id)}</code>
          ${typeof task.elapsed_ms === "number" && task.elapsed_ms > 0 ? `<span class="task-monitor-status">${formatDuration(task.elapsed_ms)}</span>` : ""}
        </button>
        ${expanded ? `<div class="task-monitor-output">${outputText ? `<pre><code>${escapeHtml(outputText)}</code></pre>` : `<p class="subtle">${state.reading.has(task.bg_id) ? "Loading output…" : "No output yet."}</p>`}
          <div class="task-control-actions"><button type="button" class="ghost-button" data-task-output="latest" data-task-id="${escapeHtml(task.bg_id)}" ${state.reading.has(task.bg_id) ? "disabled" : ""}>${state.cursors[task.bg_id] ? "Latest output" : "Refresh"}</button>${output?.start_cursor ? `<button type="button" class="ghost-button" data-task-output="start" data-task-id="${escapeHtml(task.bg_id)}" ${state.reading.has(task.bg_id) ? "disabled" : ""}>Read from start</button>` : ""}${output?.truncated && output.next_cursor ? `<button type="button" class="ghost-button" data-task-output="next" data-task-id="${escapeHtml(task.bg_id)}" ${state.reading.has(task.bg_id) ? "disabled" : ""}>Next output</button>` : ""}</div>
          <div class="task-control-actions"><button type="button" class="ghost-button danger" data-task-action="cancel" data-task-id="${escapeHtml(task.bg_id)}">Stop task</button></div></div>` : ""}
      </div>
    `
  }).join("")
  dock.innerHTML = `
    <div class="task-monitor-head">
      <h3 class="inspector-section-title">Tasks</h3>
      <span class="activity-note">${state.tasks.length} running</span>
    </div>
    <div class="task-monitor-list">${rows}</div>
    ${state.error ? `<p class="subtle" role="alert">${escapeHtml(state.error)}</p>` : ""}
  `
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
