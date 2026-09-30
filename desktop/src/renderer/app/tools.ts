// Call rows and work-segment folds (spec sections 5.1 and 5.2). Content comes
// from the pure formatters in tool-display.ts; this module only builds markup.

import { formatDuration, type ToolEntry, type ToolStatus } from "../timeline-model.ts"
import { toolView, type MetaPart, type ToolView } from "../tool-display.ts"
import { segmentOpenMode, segmentSummary, trimmedCalls, type SegmentOpenMode, type WorkSegment } from "../work-segments.ts"
import { Ban, Check, ChevronRight, CircleX, Hand, LoaderCircle, renderIcon } from "../icons.ts"
import { renderToolBody, renderToolError } from "./tool-bodies.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { state } from "./state.ts"

export type RowStatus = ToolStatus | "waiting"

const statusLabels: Record<RowStatus, string> = {
  pending: "Starting",
  running: "Running",
  completed: "Done",
  error: "Failed",
  cancelled: "Cancelled",
  waiting: "Waiting on you",
}

/** 14px status glyph with an accessible label. */
export function renderToolStatusIcon(status: RowStatus): string {
  const icon = status === "running" || status === "pending" ? LoaderCircle
    : status === "error" ? CircleX
      : status === "cancelled" ? Ban
        : status === "waiting" ? Hand
          : Check
  return `<span class="tool-status tool-status-${status}" role="img" aria-label="${statusLabels[status]}">${renderIcon(icon, "tool-status-icon")}</span>`
}

function renderMeta(parts: MetaPart[]): string {
  if (!parts.length) return ""
  return `<span class="tool-meta">${parts.map((part) => `<span class="tool-meta-part${part.tone ? ` tone-${part.tone}` : ""}">${escapeHtml(part.text)}</span>`).join("")}</span>`
}

function renderTarget(view: ToolView): string {
  if (!view.target) return ""
  return view.path
    ? `<span class="tool-target tool-target-path"><bdi>${escapeHtml(view.target)}</bdi></span>`
    : `<span class="tool-target">${escapeHtml(view.target)}</span>`
}

export function renderTool(tool: ToolEntry): string {
  const view = toolView(tool)
  if (view.hidden) return ""
  const live = tool.status === "running" || tool.status === "pending"
  const body = view.body
  const open = Boolean(body) && state.expandedTools.has(tool.id)
  const revealed = open || state.revealedTools.has(tool.id)
  const bodyId = `tool-body-${tool.id}`
  const head = `${renderToolStatusIcon(tool.status)}<span class="tool-verb">${escapeHtml(view.verb)}</span>${renderTarget(view)}${renderMeta(view.meta)}${body ? renderIcon(ChevronRight, "tool-chevron") : ""}`
  const trigger = body
    ? `<button type="button" class="tool-trigger" data-toggle-tool="${escapeAttribute(tool.id)}" aria-expanded="${String(open)}" aria-controls="${escapeAttribute(bodyId)}">${head}</button>`
    : view.opensFile
      ? `<button type="button" class="tool-trigger" data-open-file="${escapeAttribute(view.opensFile)}" data-tooltip="Open in Files">${head}</button>`
      : `<div class="tool-trigger">${head}</div>`
  const shell = body && revealed
    ? `<div class="tool-detail-shell" id="${escapeAttribute(bodyId)}" aria-hidden="${String(!open)}"><div class="tool-detail-clip">${renderToolBody(tool.id, body, live)}</div></div>`
    : ""
  return `<div class="tool-row tool-${tool.status}${open ? " open" : ""}" data-entry-id="${escapeAttribute(tool.id)}" data-tool-id="${escapeAttribute(tool.id)}">${trigger}${view.error ? renderToolError(tool.id, view.error) : ""}${shell}</div>`
}

/** A file_change that no write or edit row in its segment already shows. */
export function renderFileChange(id: string, filePath: string): string {
  return `<div class="tool-row tool-completed" data-entry-id="${escapeAttribute(id)}"><div class="tool-trigger">${renderToolStatusIcon("completed")}<span class="tool-verb">Changed</span><span class="tool-target tool-target-path"><bdi>${escapeHtml(filePath)}</bdi></span></div></div>`
}

function segmentStatus(segment: WorkSegment, failed: number, cancelled: number): RowStatus {
  if (segment.awaiting) return "waiting"
  if (segment.live) return "running"
  if (failed) return "error"
  return cancelled === segment.tools.length ? "cancelled" : "completed"
}

/** One fold per work segment: summary row, then rows when open. */
export function renderWorkSegment(segment: WorkSegment, mode: SegmentOpenMode = segmentOpenMode(segment, state.segmentFolds.get(segment.id))): string {
  const single = segment.tools.length === 1
  if (single) mode = "all"
  const summary = segmentSummary(segment.tools)
  const status = segmentStatus(segment, summary.failed, summary.cancelled)
  const duration = segment.live ? "" : formatDuration(summary.durationMs)
  const bodyId = `${segment.id}:calls`
  const failures = [
    summary.failed ? `<span class="segment-failed">${summary.failed} failed</span>` : "",
    summary.cancelled ? `<span class="segment-cancelled">${summary.cancelled} cancelled</span>` : "",
  ].join("")
  const trimmed = mode === "trimmed" ? trimmedCalls(segment.tools) : { shown: segment.tools, earlier: 0 }
  const earlier = trimmed.earlier
    ? `<button type="button" class="segment-earlier" data-segment-earlier="${escapeAttribute(segment.id)}">+${trimmed.earlier} earlier</button>`
    : ""
  const calls = mode === "closed" ? "" : `${earlier}${trimmed.shown.map(renderTool).join("")}`
  return `<section class="work-segment${single ? " work-single" : ""}${mode === "closed" ? "" : " open"}${segment.live ? " live" : ""}" data-entry-id="${escapeAttribute(segment.id)}">
    <div class="segment-heading"${single ? ' aria-hidden="true" inert' : ""}><div class="segment-heading-clip">
    <button type="button" class="segment-trigger" data-toggle-segment="${escapeAttribute(segment.id)}" aria-expanded="${String(mode !== "closed")}" aria-controls="${escapeAttribute(bodyId)}">
      ${renderToolStatusIcon(status)}
      <span class="segment-summary">${escapeHtml(summary.text)}</span>
      ${failures}
      ${duration ? `<span class="segment-duration">${escapeHtml(duration)}</span>` : ""}
      ${renderIcon(ChevronRight, "tool-chevron")}
    </button>
    </div></div>
    <div class="segment-calls-shell" id="${escapeAttribute(bodyId)}" aria-hidden="${String(mode === "closed")}"${mode === "closed" ? " inert" : ""}><div class="segment-calls-clip"><div class="segment-calls">${calls}</div></div></div>
  </section>`
}
