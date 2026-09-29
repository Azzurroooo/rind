import { diffLineCounts, extractDiffText, parseDiffLines } from "../diff-text.ts"
import { fileMutationPreview, formatDuration, type ToolEntry } from "../timeline-model.ts"
import { asRecord, escapeAttribute, escapeHtml } from "./html.ts"
import { ChevronRight, CircleCheck, CircleX, Clock, LoaderCircle, renderIcon } from "../icons.ts"
import { state } from "./state.ts"

const statusLabels: Record<ToolEntry["status"], string> = {
  pending: "Waiting",
  running: "Running",
  completed: "Done",
  error: "Failed",
}

/** 14px status glyph with an accessible label (spec section 5). */
export function renderToolStatusIcon(status: ToolEntry["status"]): string {
  const icon = status === "running" ? LoaderCircle : status === "error" ? CircleX : status === "completed" ? CircleCheck : Clock
  return `<span class="tool-status tool-status-${status}" role="img" aria-label="${statusLabels[status]}">${renderIcon(icon, "tool-status-icon")}</span>`
}



export function renderTool(tool: ToolEntry): string {
  const open = state.expandedTools.has(tool.id)
  const revealed = open || state.revealedTools.has(tool.id)
  const duration = formatDuration(tool.durationMs)
  // Prefer the unified diff recorded in the tool RESULT; requests without a
  // result diff keep the argument-synthesized preview as a fallback.
  const resultDiffLines = parseDiffLines(extractDiffText(tool.toolName, tool.result))
  const argDiff = resultDiffLines.length ? undefined : fileMutationPreview(tool.toolName, tool.arguments)
  const hasDiffPreview = Boolean(resultDiffLines.length || argDiff)
  const body = renderToolDetails(tool, hasDiffPreview)
  return `
    <div class="ledger-row tool-${tool.status}${open ? " open" : ""}" data-entry-id="${escapeAttribute(tool.id)}" data-tool-id="${escapeAttribute(tool.id)}">
      <button type="button" class="ledger-trigger" data-toggle-tool="${escapeAttribute(tool.id)}" aria-expanded="${body ? String(open) : "false"}" ${body ? "" : "disabled"}>
        ${renderToolStatusIcon(tool.status)}
        <span class="ledger-verb">${escapeHtml(tool.toolName)}</span>
        ${tool.argsPreview ? `<code class="ledger-arg">${escapeHtml(tool.argsPreview)}</code>` : ""}
        ${tool.errorType ? `<span class="ledger-error">${escapeHtml(tool.errorType)}</span>` : ""}
        ${duration ? `<span class="ledger-duration">${duration}</span>` : ""}
        ${body ? renderIcon(ChevronRight, "ledger-chevron") : ""}
      </button>
      ${resultDiffLines.length ? renderResultDiff(tool, resultDiffLines) : argDiff ? renderFileMutationPreview(argDiff) : ""}
      ${body && revealed ? `<div class="tool-detail-shell" aria-hidden="${String(!open)}"><div class="tool-detail-clip">${body}</div></div>` : ""}
    </div>
  `
}

export function renderResultDiff(tool: ToolEntry, lines: ReturnType<typeof parseDiffLines>): string {
  const { added, removed, capped } = diffLineCounts(lines)
  const filePath = resultDiffPath(tool)
  const rows = lines.map((line) => {
    const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "
    return `<div class="file-diff-line file-diff-${line.kind}"><span>${sign}</span><code>${escapeHtml(line.text || " ")}</code></div>`
  }).join("")
  return `
    <section class="file-diff-preview" aria-label="File change diff">
      <div class="file-diff-head">
        <span class="file-diff-label">Diff</span>
        ${filePath ? `<code class="file-diff-path">${escapeHtml(filePath)}</code>` : ""}
        <span class="file-diff-stats">${added ? `<span class="file-diff-added-count">+${added}</span>` : ""}${removed ? `<span class="file-diff-removed-count">-${removed}</span>` : ""}${capped ? `<span class="file-diff-capped">Capped</span>` : ""}</span>
      </div>
      <div class="file-diff-lines">${rows || `<div class="file-diff-empty">Empty file</div>`}</div>
    </section>
  `
}

export function resultDiffPath(tool: ToolEntry): string {
  const fromArgs = typeof tool.arguments.file_path === "string" ? tool.arguments.file_path : ""
  if (fromArgs) return fromArgs
  const metaFiles = tool.result?.meta?.files
  if (Array.isArray(metaFiles)) {
    for (const file of metaFiles) {
      const record = file && typeof file === "object" ? file as Record<string, unknown> : {}
      if (typeof record.path === "string") return record.path
    }
  }
  return ""
}

export function renderToolDetails(tool: ToolEntry, hasMutationPreview: boolean): string {
  const inputs = Object.entries(tool.arguments).filter(([key]) => !hasMutationPreview || !["file_path", "content", "old_str", "new_str", "expected_sha256"].includes(key)).map(([key, value]) => `
    <div class="tool-detail-row"><span>${escapeHtml(key)}</span>${renderToolValue(value)}</div>
  `).join("")
  const result = tool.result
  const outcome = result?.ok === false
    ? `<section class="tool-detail-section tool-detail-error"><strong>${escapeHtml(result.error || "Tool failed")}</strong>${result.errorType ? `<small>${escapeHtml(result.errorType)}</small>` : ""}</section>`
    : result?.ok === true && result.data !== undefined
      ? `<section class="tool-detail-section"><span>Result</span>${renderToolValue(result.data)}</section>`
      : ""
  const resultMeta = hasMutationPreview ? Object.fromEntries(Object.entries(result?.meta || {}).filter(([key]) => key !== "files")) : result?.meta
  const meta = resultMeta && Object.keys(resultMeta).length
    ? `<section class="tool-detail-section"><span>Details</span>${renderToolValue(resultMeta)}</section>`
    : ""
  const fallback = !result || result.ok === null
    ? (tool.output ? `<pre class="ledger-output"><code>${escapeHtml(tool.output)}</code></pre>` : "")
    : ""
  const error = !result?.error && tool.errorType
    ? `<section class="tool-detail-section tool-detail-error"><strong>${escapeHtml(tool.errorType)}</strong></section>`
    : ""
  const content = inputs || outcome || meta || fallback || error
  return content ? `<div class="tool-details">${inputs ? `<section class="tool-detail-section"><span>Input</span>${inputs}</section>` : ""}${outcome}${error}${meta}${fallback}</div>` : ""
}

export function renderFileMutationPreview(diff: ReturnType<typeof fileMutationPreview>): string {
  if (!diff) return ""
  const removed = diff.removed.filter((line) => line !== "…").length
  const added = diff.added.filter((line) => line !== "…").length
  const capped = diff.removed.includes("…") || diff.added.includes("…")
  const rows = [
    ...diff.removed.map((line) => `<div class="file-diff-line file-diff-removed"><span>-</span><code>${escapeHtml(line || " ")}</code></div>`),
    ...diff.added.map((line) => `<div class="file-diff-line file-diff-added"><span>+</span><code>${escapeHtml(line || " ")}</code></div>`),
  ].join("")
  return `
    <section class="file-diff-preview" aria-label="File change preview">
      <div class="file-diff-head">
        <span class="file-diff-label">Changed</span>
        ${diff.filePath ? `<code class="file-diff-path">${escapeHtml(diff.filePath)}</code>` : ""}
        <span class="file-diff-stats">${added ? `<span class="file-diff-added-count">+${added}</span>` : ""}${removed ? `<span class="file-diff-removed-count">-${removed}</span>` : ""}${capped ? `<span class="file-diff-capped">Capped</span>` : ""}</span>
      </div>
      <div class="file-diff-lines">${rows || `<div class="file-diff-empty">Empty file</div>`}</div>
    </section>
  `
}

export function renderToolValue(value: unknown): string {
  if (value === null || value === undefined) return `<code class="tool-detail-value">None</code>`
  if (typeof value === "string") return `<code class="tool-detail-value">${escapeHtml(value)}</code>`
  if (typeof value === "number" || typeof value === "boolean") return `<code class="tool-detail-value">${escapeHtml(String(value))}</code>`
  if (Array.isArray(value)) return `<span class="tool-detail-value">${value.map(renderToolValue).join("")}</span>`
  return `<span class="tool-detail-value">${Object.entries(asRecord(value)).map(([key, item]) => `<span class="tool-detail-row"><span>${escapeHtml(key)}</span>${renderToolValue(item)}</span>`).join("")}</span>`
}
