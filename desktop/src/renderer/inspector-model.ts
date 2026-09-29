// Inspector (spec section 2): tab identity, width bounds, and the pure
// normalizers and renderers for the Usage tab (rind/usage/summary) and the
// finished-task history in the Tasks tab (rind/background/list + output).
// The live task monitor and the goal panel keep their own modules.

import { asRecord, escapeAttribute, escapeHtml } from "./app/html.ts"

export const INSPECTOR_TABS = ["context", "tasks", "files", "goal", "usage"] as const
export type InspectorTab = typeof INSPECTOR_TABS[number]

export const INSPECTOR_TAB_LABELS: Readonly<Record<InspectorTab, string>> = {
  context: "Context",
  tasks: "Tasks",
  files: "Files",
  goal: "Goal",
  usage: "Usage",
}

export const INSPECTOR_WIDTH = { min: 320, max: 640, fallback: 360 } as const
/** Dragging the inspector narrower than this closes it. */
export const INSPECTOR_CLOSE_WIDTH = 240
/** The conversation column keeps at least this much room beside the inspector. */
export const CONVERSATION_MIN_WIDTH = 420

export function isInspectorTab(value: unknown): value is InspectorTab {
  return typeof value === "string" && (INSPECTOR_TABS as readonly string[]).includes(value)
}

export function clampInspectorWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return INSPECTOR_WIDTH.fallback
  return Math.round(Math.max(INSPECTOR_WIDTH.min, Math.min(INSPECTOR_WIDTH.max, value)))
}

/** The inspector yields before the conversation drops under its minimum width. */
export function inspectorFits(viewportWidth: number, sidebarWidth: number, inspectorWidth: number): boolean {
  return viewportWidth - sidebarWidth - inspectorWidth >= CONVERSATION_MIN_WIDTH
}

/** Moves the selected tab for ArrowLeft/ArrowRight/Home/End on the tab list. */
export function nextInspectorTab(current: InspectorTab, key: string): InspectorTab | undefined {
  const index = INSPECTOR_TABS.indexOf(current)
  const last = INSPECTOR_TABS.length - 1
  if (key === "ArrowRight") return INSPECTOR_TABS[index === last ? 0 : index + 1]
  if (key === "ArrowLeft") return INSPECTOR_TABS[index === 0 ? last : index - 1]
  if (key === "Home") return INSPECTOR_TABS[0]
  if (key === "End") return INSPECTOR_TABS[last]
  return undefined
}

// ---------- usage summary ----------

export type UsageTotals = {
  input: number
  cached: number
  output: number
  reasoning: number
  total: number
  samples: number
  compactions: number
}

export type UsageSummary = {
  days: number
  totals: UsageTotals
  byDay: ReadonlyArray<{ day: string; tokens: number }>
  byModel: ReadonlyArray<{ model: string; tokens: number; samples: number }>
}

export function normalizeUsageSummary(value: unknown): UsageSummary {
  const root = asRecord(value)
  const totals = asRecord(root.totals)
  return {
    days: count(root.days),
    totals: {
      input: count(totals.input),
      cached: count(totals.cached),
      output: count(totals.output),
      reasoning: count(totals.reasoning),
      total: count(totals.total),
      samples: count(totals.samples),
      compactions: count(totals.compactions),
    },
    byDay: rows(root.by_day).flatMap((row) => {
      const day = text(row.day)
      return day ? [{ day, tokens: count(row.tokens) }] : []
    }),
    byModel: rows(root.by_model).flatMap((row) => {
      const model = text(row.model)
      return model ? [{ model, tokens: count(row.tokens), samples: count(row.samples) }] : []
    }),
  }
}

export function renderUsageSummary(summary: UsageSummary): string {
  const { totals } = summary
  if (!totals.total && !totals.samples) {
    return `<p class="inspector-empty">No token usage recorded in the last ${summary.days || 7} days.</p>`
  }
  const stats: ReadonlyArray<[string, number]> = [
    ["Total", totals.total],
    ["Input", totals.input],
    ["Cached", totals.cached],
    ["Output", totals.output],
    ["Reasoning", totals.reasoning],
    ["Requests", totals.samples],
  ]
  const peak = Math.max(1, ...summary.byDay.map((row) => row.tokens))
  const days = [...summary.byDay].reverse().map((row) => {
    const share = Math.max(1, (row.tokens / peak) * 100)
    return `<div class="usage-day"><span>${escapeHtml(row.day)}</span><span class="usage-bar" aria-hidden="true"><i style="width:${share.toFixed(1)}%"></i></span><b>${escapeHtml(formatCount(row.tokens))}</b></div>`
  })
  const models = summary.byModel.map((row) => `<li><code>${escapeHtml(row.model)}</code><span>${escapeHtml(formatCount(row.tokens))} tokens, ${row.samples} ${row.samples === 1 ? "request" : "requests"}</span></li>`)
  return `
    <dl class="usage-stats">${stats.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(formatCount(value))}</dd></div>`).join("")}</dl>
    ${totals.compactions ? `<p class="subtle">${totals.compactions} ${totals.compactions === 1 ? "compaction" : "compactions"}</p>` : ""}
    ${days.length ? `<h3 class="inspector-section-title">By day</h3><div class="usage-days">${days.join("")}</div>` : ""}
    ${models.length ? `<h3 class="inspector-section-title">By model</h3><ul class="usage-models">${models.join("")}</ul>` : ""}
  `
}

// ---------- background task history ----------

export type BackgroundRecord = {
  bgId: string
  status: string
  command: string
  elapsedMs: number
}

export type BackgroundOutput = {
  text: string
  exitCode?: number
  truncated: boolean
}

export type BackgroundHistoryView = {
  records: ReadonlyArray<BackgroundRecord>
  expandedId: string
  outputs: Readonly<Record<string, BackgroundOutput>>
  reading: ReadonlySet<string>
  loading: boolean
  error: string
}

const ACTIVE_BACKGROUND = new Set(["starting", "running", "cancelling"])

/** Finished background tasks, newest first; live ones stay in the task monitor. */
export function normalizeBackgroundList(value: unknown): BackgroundRecord[] {
  return rows(asRecord(value).tasks).flatMap((row) => {
    const bgId = text(row.bg_id)
    const status = text(row.status) || "unknown"
    if (!bgId || ACTIVE_BACKGROUND.has(status)) return []
    return [{ bgId, status, command: text(row.command), elapsedMs: count(row.elapsed_ms) }]
  }).reverse()
}

export function normalizeBackgroundOutput(value: unknown): BackgroundOutput {
  const task = asRecord(asRecord(value).task)
  const exitCode = typeof task.exit_code === "number" && Number.isFinite(task.exit_code) ? task.exit_code : undefined
  const output = [task.stdout, task.stderr].filter((item): item is string => typeof item === "string" && item.length > 0).join("\n")
  return { text: output, truncated: task.truncated === true, ...(exitCode === undefined ? {} : { exitCode }) }
}

export function renderBackgroundHistory(view: BackgroundHistoryView): string {
  if (view.error) return `<p class="inspector-empty" role="alert">${escapeHtml(view.error)}</p>`
  if (!view.records.length) return view.loading ? `<p class="inspector-empty">Loading history…</p>` : `<p class="inspector-empty">No finished background tasks yet.</p>`
  const items = view.records.map((record) => {
    const expanded = view.expandedId === record.bgId
    const output = view.outputs[record.bgId]
    const body = !expanded ? "" : view.reading.has(record.bgId) && !output
      ? `<p class="subtle">Loading output…</p>`
      : `${output?.text ? `<pre><code>${escapeHtml(output.text)}</code></pre>` : `<p class="subtle">No output captured.</p>`}${output?.truncated ? `<span class="task-monitor-truncated">Output truncated.</span>` : ""}`
    const exit = output?.exitCode === undefined ? "" : ` · exit ${output.exitCode}`
    return `
      <li class="task-history-item${expanded ? " open" : ""}">
        <button type="button" class="task-monitor-trigger" data-history-task="${escapeAttribute(record.bgId)}" aria-expanded="${String(expanded)}">
          <span class="status-pip ${record.status === "completed" ? "pip-done" : "pip-error"}"></span>
          <code class="task-monitor-id">${escapeHtml(record.bgId)}</code>
          <span class="task-monitor-status">${escapeHtml(record.status)}${exit}${record.elapsedMs ? ` · ${formatDuration(record.elapsedMs)}` : ""}</span>
        </button>
        ${record.command ? `<code class="task-history-command">${escapeHtml(record.command)}</code>` : ""}
        ${expanded ? `<div class="task-monitor-output">${body}</div>` : ""}
      </li>`
  })
  return `<ul class="task-history-list">${items.join("")}</ul>`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown>[] : []
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US")
}
