// The Context inspector and meter (spec section 8): turn the
// rind/context/inspect record into a command result with a section breakdown.
import { escapeHtml } from "./html-escape.ts"

export type ContextSection = { key: string; label: string; tokens: number; messages: number }

export type ContextDisplay = {
  type: "context"
  total: number
  window: number
  percent: number | null
  sections: ContextSection[]
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  capturedAt: string
}

export function contextDisplayFrom(record: unknown): ContextDisplay {
  const root = asRecord(record)
  const breakdown = asRecord(root.breakdown)
  const usage = asRecord(root.latest_usage)
  const sections = Array.isArray(breakdown.sections) ? breakdown.sections.flatMap(asSection) : []
  const total = count(breakdown.estimated_total) || sections.reduce((sum, section) => sum + section.tokens, 0)
  const window = count(breakdown.context_window_tokens) || count(usage.context_window_tokens)
  const measured = count(usage.input_tokens) || total
  return {
    type: "context",
    total,
    window,
    percent: window > 0 && measured > 0 ? Math.min(1, measured / window) : null,
    sections,
    inputTokens: count(usage.input_tokens),
    cachedTokens: count(usage.cached_input_tokens),
    outputTokens: count(usage.output_tokens),
    capturedAt: typeof breakdown.captured_at === "string" ? breakdown.captured_at : "",
  }
}

export function contextReportText(display: ContextDisplay): string {
  if (!display.sections.length && !display.inputTokens) return "Context: nothing captured yet. Send a message first."
  const head = display.window
    ? `Context: ${formatCount(display.total)} of ${formatCount(display.window)} tokens${display.percent === null ? "" : ` (${Math.round(display.percent * 100)}%)`}`
    : `Context: ${formatCount(display.total)} tokens`
  return [head, ...display.sections.map((section) => `- ${section.label}: ${formatCount(section.tokens)}`)].join("\n")
}

export function renderContextDisplay(value: Record<string, unknown>): string {
  const display = value as unknown as ContextDisplay
  const sections = Array.isArray(display.sections) ? display.sections : []
  if (!sections.length && !display.inputTokens) return `<div class="command-display"><div class="command-display-empty">Nothing captured yet. Send a message first.</div></div>`
  const denominator = Math.max(1, display.window || display.total)
  const percent = typeof display.percent === "number" ? ` <span>${Math.round(display.percent * 100)}%</span>` : ""
  const summary = display.window ? `${formatCount(display.total)} / ${formatCount(display.window)} tokens` : `${formatCount(display.total)} tokens`
  const rows = sections.map((section) => {
    const share = Math.max(0.5, Math.min(100, (section.tokens / denominator) * 100))
    return `<div class="context-row"><span class="context-row-label">${escapeHtml(section.label)}</span><span class="context-row-bar" aria-hidden="true"><i style="width:${share.toFixed(1)}%"></i></span><b>${escapeHtml(formatCount(section.tokens))}</b></div>`
  })
  const usage = display.inputTokens
    ? `<div class="command-usage"><strong>Last request</strong><span>Input <b>${escapeHtml(formatCount(display.inputTokens))}</b></span><span>Cached <b>${escapeHtml(formatCount(display.cachedTokens))}</b></span><span>Output <b>${escapeHtml(formatCount(display.outputTokens))}</b></span></div>`
    : ""
  return `<div class="command-display context-display"><div class="command-display-title">Context window${percent}</div><div class="command-display-summary">${escapeHtml(summary)}</div><div class="context-rows">${rows.join("")}</div>${usage}</div>`
}

function asSection(value: unknown): ContextSection[] {
  const item = asRecord(value)
  const label = typeof item.label === "string" ? item.label.trim() : ""
  if (!label) return []
  return [{ key: typeof item.key === "string" ? item.key : label, label, tokens: count(item.tokens), messages: count(item.messages) }]
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function formatCount(value: number) {
  return value.toLocaleString("en-US")
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
