import { renderMarkdown } from "./markdown.ts"
import { isDesktopHiddenSlashCommand } from "./slash-commands.ts"

export type CommandResult = {
  command: string
  content: string
  display?: Record<string, unknown>
}

export function renderCommandResult(entry: CommandResult): string {
  const display = renderCommandDisplay(entry.display)
  const fallback = `<div class="command-result-body">${renderMarkdown(entry.content)}</div>`
  return `<section class="command-result"><div class="command-result-head"><code>${escapeHtml(entry.command)}</code></div>${display || fallback}</section>`
}

function renderCommandDisplay(display: Record<string, unknown> | undefined): string {
  if (!display) return ""
  const type = typeof display.type === "string" ? display.type : ""
  if (type === "help") return renderHelpCommandDisplay(display)
  if (type === "config") return renderKeyValueDisplay(display.entries)
  if (type === "doctor") return renderDoctorDisplay(display)
  if (type === "sessions") return renderSessionsDisplay(display)
  if (type === "skills") return renderSkillsDisplay(display)
  if (type === "status") return renderStatusDisplay(display)
  if (type === "team_create") return renderKeyValueDisplay([
    { label: "project", value: display.project_id },
    { label: "main agent", value: display.main_agent },
    { label: "workspace", value: display.workspace_root },
  ])
  return ""
}

function renderHelpCommandDisplay(display: Record<string, unknown>) {
  const selected = asRecord(display.command)
  const commands = (typeof selected.name === "string" ? [selected] : recordList(display.commands))
    .filter((command) => !isDesktopHiddenSlashCommand(typeof command.name === "string" ? command.name : ""))
  if (!commands.length) return ""
  const heading = typeof selected.name === "string" ? `/${selected.name}` : "Commands"
  return `<div class="command-display"><div class="command-display-title">${escapeHtml(heading)}</div><div class="command-list">${commands.map((command) => {
    const name = typeof command.name === "string" ? command.name : ""
    if (!name) return ""
    const description = typeof command.description === "string" ? command.description : ""
    const usage = typeof command.usage === "string" ? command.usage : `/${name}`
    return `<button type="button" class="command-list-item" data-command-prefill="${escapeAttribute(name)}"><span><code>/${escapeHtml(name)}</code><small>${escapeHtml(description)}</small></span><code>${escapeHtml(usage)}</code></button>`
  }).join("")}</div></div>`
}

function renderKeyValueDisplay(entries: unknown) {
  const rows = recordList(entries).flatMap((entry) => {
    const label = typeof entry.label === "string" ? entry.label : ""
    if (!label) return []
    const state = typeof entry.state === "string" ? ` <small>${escapeHtml(entry.state)}</small>` : ""
    return [`<div class="command-key-value"><span>${escapeHtml(label)}</span><code>${escapeHtml(displayText(entry.value))}</code>${state}</div>`]
  })
  return rows.length ? `<div class="command-display command-key-values">${rows.join("")}</div>` : ""
}

function renderDoctorDisplay(display: Record<string, unknown>) {
  const checks = recordList(display.checks)
  const summary = `${displayText(display.failures)} failures, ${displayText(display.warnings)} warnings`
  const nextSteps = stringList(display.next_steps)
  return `<div class="command-display"><div class="command-display-summary">${escapeHtml(summary)}</div><div class="command-check-list">${checks.map((check) => {
    const status = typeof check.status === "string" ? check.status : "warn"
    return `<div class="command-check command-check-${escapeAttribute(status)}"><span aria-hidden="true"></span><strong>${escapeHtml(displayText(check.name))}</strong><small>${escapeHtml(displayText(check.detail))}</small></div>`
  }).join("")}</div>${nextSteps.length ? `<ul class="command-next-steps">${nextSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>` : ""}</div>`
}

function renderSessionsDisplay(display: Record<string, unknown>) {
  const sessions = recordList(display.sessions)
  if (!sessions.length) return `<div class="command-display-empty">No recent sessions</div>`
  return `<div class="command-display command-session-list">${sessions.map((session) => {
    const id = displayText(session.id)
    const title = displayText(session.title) || "Untitled"
    const metadata = [displayText(session.updated_at), Number.isFinite(session.messages) ? `${session.messages} messages` : "", Number.isFinite(session.tool_calls) ? `${session.tool_calls} tools` : ""].filter(Boolean).join(" | ")
    const current = session.current === true
    const state = current ? " current" : ""
    const action = id ? ` type="button" data-command-session-id="${escapeAttribute(id)}"${current ? ' aria-current="page"' : ""}` : ""
    const content = `<strong>${escapeHtml(title)}</strong><small>${escapeHtml(metadata)}</small>${session.preview ? `<span>${escapeHtml(displayText(session.preview))}</span>` : ""}`
    return id
      ? `<button class="command-session${state}"${action}>${content}</button>`
      : `<div class="command-session${state}">${content}</div>`
  }).join("")}</div>`
}

function renderSkillsDisplay(display: Record<string, unknown>) {
  const skills = recordList(display.skills)
  if (!skills.length) return `<div class="command-display-empty">No skills found</div>`
  return `<div class="command-display command-skill-list">${skills.map((skill) => `<div class="command-skill"><strong>${escapeHtml(displayText(skill.name))}</strong><small>${escapeHtml(displayText(skill.scope))}</small><span>${escapeHtml(displayText(skill.description))}</span>${skill.path ? `<code>${escapeHtml(displayText(skill.path))}</code>` : ""}</div>`).join("")}</div>`
}

function renderStatusDisplay(display: Record<string, unknown>) {
  const git = asRecord(display.git)
  const entries = [
    { label: "session", value: display.session },
    { label: "model", value: display.model },
    { label: "messages", value: display.messages },
    ...(git.branch ? [{ label: "git", value: `${displayText(git.branch)}${git.dirty ? " *" : ""}` }] : []),
  ]
  const usageRows = recordList(display.usage).map((item) => `<div class="command-usage"><strong>${escapeHtml(displayText(item.label))}</strong><span>Input <b>${escapeHtml(formatCount(item.input_tokens))}</b>${Number(item.context_window_tokens) > 0 ? ` / ${escapeHtml(formatCount(item.context_window_tokens))}` : ""}</span><span>Output <b>${escapeHtml(formatCount(item.output_tokens))}</b></span><span>Context <b>${escapeHtml(formatPercent(item.context_usage_percent))}</b></span></div>`)
  return `<div class="command-display">${renderKeyValueDisplay(entries)}${usageRows.join("")}</div>`
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const record = asRecord(item)
    return Object.keys(record).length ? [record] : []
  }) : []
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}

function displayText(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : ""
}

function formatCount(value: unknown) {
  const count = Number(value)
  return Number.isFinite(count) ? count.toLocaleString() : displayText(value)
}

function formatPercent(value: unknown) {
  const percent = Number(value)
  return Number.isFinite(percent) ? `${Math.round(percent * 100)}%` : ""
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character)
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/\n/g, "&#10;")
}
