// Inspector (spec section 2): tab identity, width bounds, and the pure
// normalizers and renderers for the Usage tab (rind/usage/summary) and the
// plan checklist in the Activity tab. The task monitor and the goal panel
// keep their own modules.

import { asRecord, escapeHtml } from "./app/html.ts"

export const INSPECTOR_TABS = ["context", "activity", "files", "usage"] as const
export type InspectorTab = typeof INSPECTOR_TABS[number]

export const INSPECTOR_TAB_LABELS: Readonly<Record<InspectorTab, string>> = {
  context: "Context",
  activity: "Activity",
  files: "Files",
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
