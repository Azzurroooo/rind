// Task pages and output cursors belong to one viewed session. Replacing the
// state when switching sessions isolates responses that are still in flight.

import type { DesktopBackgroundTask } from "../preload/types"
import { escapeHtml } from "./app/html.ts"

const ACTIVE_STATES = new Set(["starting", "running", "cancelling"])
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timed_out", "lost"])

export type TaskMonitorState = {
  tasks: DesktopBackgroundTask[]
  expandedId: string
  outputs: Record<string, DesktopBackgroundTask | undefined>
  cursors: Record<string, string | undefined>
  reads: Record<string, number>
  reading: Set<string>
  pagesLoaded: number
  nextPage?: string
  refreshing: boolean
  error: string
}

export function createTaskMonitorState(): TaskMonitorState {
  return { tasks: [], expandedId: "", outputs: {}, cursors: {}, reads: {}, reading: new Set(), pagesLoaded: 1, refreshing: false, error: "" }
}

// Merge loaded rind/task/list pages into the running task list. Tasks that
// disappear from the listing while still "running" are assumed finished and
// dropped (the kernel expires them); settled tasks linger until then.
export function mergeTasks(current: DesktopBackgroundTask[], listed: unknown): DesktopBackgroundTask[] {
  const rows = Array.isArray(listed) ? listed : []
  const byId = new Map<string, DesktopBackgroundTask>()
  for (const task of rows) {
    const record = task && typeof task === "object" && !Array.isArray(task) ? task as Record<string, unknown> : {}
    const bgId = String(record.task_id || record.bg_id || "").trim()
    if (!bgId) continue
    const previous = current.find((item) => item.bg_id === bgId)
    byId.set(bgId, previous && TERMINAL_STATES.has(previous.status) && ACTIVE_STATES.has(String(record.status))
      ? previous : normalizeTask({ ...previous, ...record, bg_id: bgId }))
  }
  const merged = [
    ...byId.values(),
    ...current.filter((task) => !byId.has(task.bg_id) && !ACTIVE_STATES.has(task.status)),
  ]
  return merged.sort((left, right) => left.bg_id.localeCompare(right.bg_id))
}

export function normalizeTask(record: unknown): DesktopBackgroundTask {
  const value = record && typeof record === "object" && !Array.isArray(record) ? record as Record<string, unknown> : {}
  const meta = value.meta && typeof value.meta === "object" ? value.meta as Record<string, unknown> : {}
  return {
    bg_id: String(value.task_id || value.bg_id || "").trim(),
    status: String(value.status || "unknown"),
    exit_code: typeof value.exit_code === "number" ? value.exit_code : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    stdout: typeof value.stdout === "string" ? value.stdout : undefined,
    stderr: typeof value.stderr === "string" ? value.stderr : undefined,
    truncated: meta.truncated === true || value.truncated === true,
    next_cursor: typeof value.next_cursor === "string" ? value.next_cursor : undefined,
    start_cursor: typeof value.start_cursor === "string" ? value.start_cursor : undefined,
  }
}

export async function refreshTaskPages(state: TaskMonitorState, fetchPage: (token?: string) => Promise<unknown>, more = false) {
  if (state.refreshing || (more && !state.nextPage)) return
  state.refreshing = true
  try {
    let token = more ? state.nextPage : undefined
    const rows: unknown[] = []
    const count = more ? 1 : state.pagesLoaded
    let loaded = 0
    for (; loaded < count; loaded++) {
      const result = await fetchPage(token) as { tasks?: unknown[]; next_page_token?: string }
      if (Array.isArray(result?.tasks)) rows.push(...result.tasks)
      token = result?.next_page_token || undefined
      if (!token) { loaded++; break }
    }
    state.tasks = mergeTasks(state.tasks, more ? [...state.tasks, ...rows] : rows)
    state.pagesLoaded = more ? state.pagesLoaded + loaded : loaded
    state.nextPage = token
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
  return tasks.filter((task) => ACTIVE_STATES.has(task.status)).length
}

export function taskStatusClass(task: DesktopBackgroundTask) {
  if (ACTIVE_STATES.has(task.status)) return "pip-running"
  if (["error", "failed", "timed_out", "lost"].includes(task.status)) return "pip-error"
  return "pip-done"
}

// DOM-sync renderer for the inspector Tasks tab: one row per task, click to
// expand polled output. Interactions use data-attribute delegation in
// app/inspector-tasks.ts (data-toggle-task, data-task-output, data-task-action).
export function renderTaskMonitor(dock: HTMLElement, state: TaskMonitorState) {
  if (!state.tasks.length) {
    dock.innerHTML = `
      <div class="task-monitor-head">
        <strong>Running</strong>
      </div>
      <p class="task-monitor-empty">${state.error ? escapeHtml(state.error) : state.refreshing ? "Loading tasks…" : "No background tasks in this conversation. Long commands appear here while Rind keeps them running."}</p>
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
          <code class="task-monitor-id">${escapeHtml(task.bg_id)}</code>
          <span class="task-monitor-status">${escapeHtml(task.status)}${task.exit_code !== undefined && task.status !== "running" ? ` · exit ${task.exit_code}` : ""}</span>
        </button>
        ${expanded ? `<div class="task-monitor-output">${outputText ? `<pre><code>${escapeHtml(outputText)}</code></pre>` : `<p class="subtle">${state.reading.has(task.bg_id) ? "Loading output…" : "No output yet."}</p>`}
          <div class="task-control-actions"><button type="button" class="ghost-button" data-task-output="latest" data-task-id="${escapeHtml(task.bg_id)}" ${state.reading.has(task.bg_id) ? "disabled" : ""}>${state.cursors[task.bg_id] ? "Latest output" : "Refresh"}</button>${output?.start_cursor ? `<button type="button" class="ghost-button" data-task-output="start" data-task-id="${escapeHtml(task.bg_id)}" ${state.reading.has(task.bg_id) ? "disabled" : ""}>Read from start</button>` : ""}${output?.truncated && output.next_cursor && (state.cursors[task.bg_id] || !output.start_cursor) ? `<button type="button" class="ghost-button" data-task-output="next" data-task-id="${escapeHtml(task.bg_id)}" ${state.reading.has(task.bg_id) ? "disabled" : ""}>Next output</button>` : ""}</div>
          ${ACTIVE_STATES.has(task.status) ? `<div class="task-control-actions"><button type="button" class="ghost-button" data-task-action="release" data-task-id="${escapeHtml(task.bg_id)}">Run in background</button><button type="button" class="ghost-button danger" data-task-action="cancel" data-task-id="${escapeHtml(task.bg_id)}">Stop task</button></div>` : ""}</div>` : ""}
      </div>
    `
  }).join("")
  dock.innerHTML = `
    <div class="task-monitor-head">
      <strong>Running</strong>
      <span class="task-monitor-count">${runningTaskCount(state.tasks)} running</span>
    </div>
    <div class="task-monitor-list">${rows}</div>
    ${state.error ? `<p class="subtle" role="alert">${escapeHtml(state.error)}</p>` : ""}
    ${state.nextPage ? `<button type="button" class="ghost-button task-monitor-more" data-task-more ${state.refreshing ? "disabled" : ""}>Load more tasks</button>` : ""}
  `
}
