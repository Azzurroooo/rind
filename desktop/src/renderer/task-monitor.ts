// Background task monitor (task B6): merge/presentation logic ported from
// frontend-cli/lib/task-monitor-controller.js, with a DOM sync renderer in the
// style of syncPendingInputDock. Polling stays in index.ts.

import type { DesktopBackgroundTask } from "../preload/types"

export type TaskMonitorState = {
  tasks: DesktopBackgroundTask[]
  expandedId: string
  outputs: Record<string, DesktopBackgroundTask | undefined>
}

export function createTaskMonitorState(): TaskMonitorState {
  return { tasks: [], expandedId: "", outputs: {} }
}

// Merge one rind/background/list page into the running task list. Tasks that
// disappear from the listing while still "running" are assumed finished and
// dropped (the kernel expires them); settled tasks linger until then.
export function mergeTasks(current: DesktopBackgroundTask[], listed: unknown): DesktopBackgroundTask[] {
  const rows = Array.isArray(listed) ? listed : []
  const byId = new Map<string, DesktopBackgroundTask>()
  for (const task of rows) {
    const record = task && typeof task === "object" && !Array.isArray(task) ? task as Record<string, unknown> : {}
    const bgId = typeof record.bg_id === "string" ? record.bg_id.trim() : ""
    if (!bgId) continue
    byId.set(bgId, normalizeTask({ ...current.find((item) => item.bg_id === bgId), ...record, bg_id: bgId }))
  }
  const merged = [
    ...byId.values(),
    ...current.filter((task) => !byId.has(task.bg_id) && task.status !== "running"),
  ]
  return merged.sort((left, right) => left.bg_id.localeCompare(right.bg_id))
}

export function normalizeTask(record: unknown): DesktopBackgroundTask {
  const value = record && typeof record === "object" && !Array.isArray(record) ? record as Record<string, unknown> : {}
  return {
    bg_id: String(value.bg_id || "").trim(),
    status: String(value.status || "unknown"),
    exit_code: typeof value.exit_code === "number" ? value.exit_code : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    stdout: typeof value.stdout === "string" ? value.stdout : undefined,
    stderr: typeof value.stderr === "string" ? value.stderr : undefined,
    truncated: value.truncated === true,
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character)
}

export function runningTaskCount(tasks: DesktopBackgroundTask[]) {
  return tasks.filter((task) => task.status === "running").length
}

export function taskStatusClass(task: DesktopBackgroundTask) {
  if (task.status === "running") return "pip-running"
  if (task.status === "error" || task.status === "failed") return "pip-error"
  return "pip-done"
}

export type TaskMonitorElements = {
  shell: HTMLElement
  dock: HTMLElement
}

// DOM-sync renderer: one row per task, click to expand polled output.
// Shell visibility (open/closed) is managed by the caller; interactions use
// data-attribute delegation in index.ts (data-toggle-task / data-task-close).
export function renderTaskMonitor(elements: TaskMonitorElements, state: TaskMonitorState) {
  if (!state.tasks.length) {
    elements.dock.innerHTML = `
      <div class="task-monitor-head">
        <strong>Background tasks</strong>
        <button type="button" class="ghost-button" data-task-close title="Close task monitor">Close</button>
      </div>
      <p class="task-monitor-empty">No background tasks in this session. Background shells started with trailing <code>&amp;</code> commands appear here.</p>
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
        ${expanded ? `<div class="task-monitor-output">${outputText ? `<pre><code>${escapeHtml(outputText)}</code></pre>${output?.truncated ? `<small class="task-monitor-truncated">Output truncated to the last lines.</small>` : ""}` : `<p class="subtle">No output yet.</p>`}</div>` : ""}
      </div>
    `
  }).join("")
  elements.dock.innerHTML = `
    <div class="task-monitor-head">
      <strong>Background tasks</strong>
      <span class="task-monitor-count">${runningTaskCount(state.tasks)} running</span>
      <button type="button" class="ghost-button" data-task-close title="Close task monitor">Close</button>
    </div>
    <div class="task-monitor-list">${rows}</div>
  `
}
