// Tool call bodies and error blocks (spec section 5.3). Each body starts at
// its preview cap; "Show all", "Show raw" and "Show details" are stored per
// call in state.toolBodiesShown so re-renders keep the person's choice.

import type { DiffLine } from "../diff-text.ts"
import { renderMarkdown } from "../markdown.ts"
import { highlightFile } from "../syntax-highlight.ts"
import { textLines, type ListItem, type ToolBody, type ToolError } from "../tool-display.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { state } from "./state.ts"

export type BodyToggle = "all" | "raw" | "details"

export function bodyToggleKey(id: string, toggle: BodyToggle) {
  return `${id}:${toggle}`
}

function shown(id: string, toggle: BodyToggle) {
  return state.toolBodiesShown.has(bodyToggleKey(id, toggle))
}

function moreButton(id: string, toggle: BodyToggle, label: string, expanded: boolean) {
  return `<button type="button" class="tool-more" data-tool-more="${escapeAttribute(bodyToggleKey(id, toggle))}" aria-expanded="${String(expanded)}">${escapeHtml(label)}</button>`
}

function showAll(id: string, total: number, preview: number, noun = "lines") {
  if (total <= preview) return ""
  const open = shown(id, "all")
  return moreButton(id, "all", open ? "Show less" : `Show all ${total} ${noun}`, open)
}

export function renderToolBody(id: string, body: ToolBody, live: boolean): string {
  switch (body.type) {
    case "diff": return renderDiff(id, body.lines, body.preview)
    case "code": return renderCode(id, body.path, body.text, body.preview, body.max)
    case "terminal": return renderTerminal(id, body.lines, body.preview, body.max, live)
    case "list": return renderList(id, body.items, body.preview, body.max)
    case "markdown": return renderMarkdownBody(id, body.text, body.preview)
    case "fields": return renderFields(id, body.fields, body.result, body.resultMax, body.raw)
  }
}

function renderDiff(id: string, lines: DiffLine[], preview: number) {
  const visible = shown(id, "all") ? lines : lines.slice(0, preview)
  const rows = visible.map((line) => {
    const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "
    return `<div class="file-diff-line file-diff-${line.kind}"><span>${sign}</span><code>${escapeHtml(line.text || " ")}</code></div>`
  }).join("")
  return `<div class="tool-body"><div class="file-diff-lines" aria-label="Diff">${rows}</div>${showAll(id, lines.length, preview)}</div>`
}

function renderCode(id: string, path: string, text: string, preview: number, max: number) {
  const lines = textLines(text)
  const limit = shown(id, "all") ? max : preview
  const { language, html } = highlightFile(path, lines.slice(0, limit).join("\n"))
  const beyond = shown(id, "all") && lines.length > max ? `<p class="tool-note">${lines.length - max} more lines not shown</p>` : ""
  return `<div class="tool-body"><pre class="tool-code"><code class="hljs language-${escapeAttribute(language)}">${html}</code></pre>${beyond}${showAll(id, Math.min(lines.length, max), preview)}</div>`
}

function renderTerminal(id: string, lines: string[], preview: number, max: number, live: boolean) {
  const all = !live && shown(id, "all")
  const tail = lines.slice(Math.max(0, lines.length - (all ? max : preview)))
  const hidden = lines.length - tail.length
  const note = all && hidden ? `<p class="tool-note">${hidden} earlier lines not shown</p>` : ""
  const more = live ? "" : showAll(id, Math.min(lines.length, max), preview)
  return `<div class="tool-body">${note}<pre class="tool-terminal"><code>${escapeHtml(tail.join("\n"))}</code></pre>${more}</div>`
}

function renderList(id: string, items: ListItem[], preview: number, max: number) {
  const visible = items.slice(0, shown(id, "all") ? max : preview)
  const rows = visible.map((item) => `<li><span class="tool-list-label">${escapeHtml(item.label)}</span>${item.detail ? `<span class="tool-list-detail">${escapeHtml(item.detail)}</span>` : ""}</li>`).join("")
  return `<div class="tool-body"><ul class="tool-list">${rows}</ul>${showAll(id, Math.min(items.length, max), preview, "items")}</div>`
}

function renderMarkdownBody(id: string, text: string, preview: number) {
  const lines = text.split(/\r?\n/)
  const visible = shown(id, "all") ? text : lines.slice(0, preview).join("\n")
  return `<div class="tool-body"><div class="tool-markdown">${renderMarkdown(visible)}</div>${showAll(id, lines.length, preview)}</div>`
}

function renderFields(id: string, fields: Array<{ key: string; value: string }>, result: string[], resultMax: number, raw: string) {
  const list = fields.length
    ? `<dl class="tool-fields">${fields.map((field) => `<dt>${escapeHtml(field.key)}</dt><dd>${escapeHtml(field.value)}</dd>`).join("")}</dl>`
    : ""
  const clipped = result.length > resultMax ? `<p class="tool-note">${result.length - resultMax} more lines</p>` : ""
  const output = result.length ? `<pre class="tool-terminal"><code>${escapeHtml(result.slice(0, resultMax).join("\n"))}</code></pre>${clipped}` : ""
  const rawOpen = shown(id, "raw")
  const rawToggle = raw.trim() ? moreButton(id, "raw", rawOpen ? "Hide raw" : "Show raw", rawOpen) : ""
  const rawBlock = rawOpen && raw.trim() ? `<pre class="tool-terminal tool-raw"><code>${escapeHtml(raw)}</code></pre>` : ""
  return `<div class="tool-body">${list}${output}${rawToggle}${rawBlock}</div>`
}

/** Errors always render under the row; long traces sit behind "Show details". */
export function renderToolError(id: string, error: ToolError): string {
  const open = shown(id, "details")
  const toggle = error.details ? moreButton(id, "details", open ? "Hide details" : "Show details", open) : ""
  const details = open && error.details ? `<pre class="tool-error-details"><code>${escapeHtml(error.details)}</code></pre>` : ""
  return `<div class="tool-error"><p class="tool-error-message">${escapeHtml(error.message)}</p>${toggle}${details}</div>`
}
