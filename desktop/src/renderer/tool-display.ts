// Per-tool presentation rules (spec section 5.3). Pure and DOM-free so each
// formatter is unit tested. Caps follow frontend-cli/lib/tool-display.js.
// Nothing here ever echoes raw arguments, JSON or file contents by default.

import { extractDiffText, parseDiffLines, type DiffLine } from "./diff-text.ts"
import { clipLine, fileMutationPreview, formatDuration, type ToolEntry } from "./timeline-model.ts"

export type Tone = "success" | "danger" | "dim" | "info"
export type MetaPart = { text: string; tone?: Tone }
export type ListItem = { label: string; detail?: string }
export type ToolBody =
  | { type: "diff"; lines: DiffLine[]; preview: number }
  | { type: "code"; path: string; text: string; preview: number; max: number }
  | { type: "terminal"; lines: string[]; preview: number; max: number }
  | { type: "list"; items: ListItem[]; preview: number; max: number }
  | { type: "markdown"; text: string; preview: number }
  | { type: "fields"; fields: Array<{ key: string; value: string }>; result: string[]; resultMax: number; raw: string }
export type ToolError = { message: string; details: string }
export type ToolView = {
  hidden: boolean
  verb: string
  target: string
  /** Target is a path: truncate from the start. */
  path: boolean
  meta: MetaPart[]
  body?: ToolBody
  opensFile?: string
  error?: ToolError
}

export const hiddenTools = new Set(["ask_user_question", "update_plan"])
export const bodyCaps = {
  codePreview: 20, codeMax: 400,
  diffPreview: 20,
  listPreview: 20, listMax: 200,
  terminalPreview: 5, terminalMax: 400,
  webResults: 16,
  markdownPreview: 24,
  unknownResult: 40,
  errorLines: 6,
} as const

type Formatter = (tool: ToolEntry) => Omit<ToolView, "hidden" | "error">

const formatters: Record<string, Formatter> = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  grep,
  glob,
  bash,
  bash_output: taskCheck,
  task_control: taskCheck,
  search_web: searchWeb,
  fetch_web_page: fetchPage,
  delegate,
  report: reportTool,
  agent_management: agentManagementTool,
  agent_create: agentCreate,
  update_goal: updateGoal,
}

export function toolView(tool: ToolEntry): ToolView {
  if (hiddenTools.has(tool.toolName)) return { hidden: true, verb: "", target: "", path: false, meta: [] }
  const view = (formatters[tool.toolName] || unknownTool)(tool)
  const live = tool.status === "running" || tool.status === "pending"
  const meta = live && tool.progress ? [{ text: tool.progress }] : view.meta
  return { ...view, hidden: false, meta, error: tool.status === "error" ? toolError(tool) : undefined }
}

// ---------- files ----------

function readFile(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const path = argPath(tool)
  return { verb: "Read", target: path, path: true, meta: readRange(tool), opensFile: path || undefined }
}

function readRange(tool: ToolEntry): MetaPart[] {
  const shown = /Showing lines (\d+) to (\d+)/.exec(str(tool.result?.data))
  if (shown) return [{ text: shown[1] === shown[2] ? `line ${shown[1]}` : `lines ${shown[1]}-${shown[2]}` }]
  const offset = num(tool.arguments.offset)
  const limit = num(tool.arguments.limit)
  if (offset !== undefined && limit !== undefined) return [{ text: `lines ${offset}-${offset + limit - 1}` }]
  const count = textLines(str(tool.result?.data)).length
  return count ? [{ text: plural(count, "line") }] : []
}

function writeFile(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const path = argPath(tool)
  const content = str(tool.arguments.content)
  const file = resultFile(tool)
  const added = num(file.added_lines) ?? (content ? textLines(content).length : undefined)
  const meta: MetaPart[] = added !== undefined ? [{ text: `+${added}`, tone: "success" }] : []
  const body = content ? { type: "code" as const, path, text: content, preview: bodyCaps.codePreview, max: bodyCaps.codeMax } : undefined
  return { verb: "Wrote", target: path, path: true, meta, body }
}

function editFile(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const path = argPath(tool)
  const lines = editDiffLines(tool)
  const counts = editCounts(tool, lines)
  const meta: MetaPart[] = counts ? [{ text: `+${counts.added}`, tone: "success" }, { text: `-${counts.removed}`, tone: "danger" }] : []
  return { verb: "Edited", target: path, path: true, meta, body: lines.length ? { type: "diff", lines, preview: bodyCaps.diffPreview } : undefined }
}

export function editDiffLines(tool: ToolEntry): DiffLine[] {
  const diffText = extractDiffText(tool.toolName, tool.result)
  const fromResult = diffText.trim() ? parseDiffLines(diffText) : []
  if (fromResult.length) return fromResult
  const preview = fileMutationPreview(tool.toolName, tool.arguments)
  if (!preview) return []
  return [
    ...preview.removed.map((text) => ({ kind: "removed" as const, text })),
    ...preview.added.map((text) => ({ kind: "added" as const, text })),
  ]
}

/** Line counts for a write or edit: result meta first, then the diff shown. */
export function editCounts(tool: ToolEntry, lines = editDiffLines(tool)): { added: number; removed: number } | undefined {
  const file = resultFile(tool)
  const added = num(file.added_lines)
  const removed = num(file.removed_lines)
  if (added !== undefined || removed !== undefined) return { added: added ?? 0, removed: removed ?? 0 }
  if (!lines.length) return undefined
  const real = lines.filter((line) => line.text !== "…")
  return { added: real.filter((line) => line.kind === "added").length, removed: real.filter((line) => line.kind === "removed").length }
}

// ---------- search ----------

function grep(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const matches = arr(tool.result?.data).map(rec)
  const byFile = new Map<string, number>()
  for (const match of matches) {
    const file = str(match.file)
    if (file) byFile.set(file, (byFile.get(file) || 0) + 1)
  }
  const truncated = tool.result?.meta.truncated === true
  const done = tool.status === "completed" && tool.result?.ok === true
  const meta: MetaPart[] = !done ? [] : matches.length
    ? [{ text: `${plural(matches.length, "match", "matches")}${truncated ? "+" : ""} in ${plural(byFile.size, "file")}` }]
    : [{ text: "No matches" }]
  const items = [...byFile].map(([label, count]) => ({ label, detail: String(count) }))
  return { verb: "Searched", target: str(tool.arguments.pattern), path: false, meta, body: listBody(items, bodyCaps.listPreview, bodyCaps.listMax) }
}

function glob(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const paths = arr(tool.result?.data).map((item) => str(rec(item).path)).filter(Boolean)
  const done = tool.status === "completed" && tool.result?.ok === true
  const truncated = tool.result?.meta.truncated === true
  const pattern = str(tool.arguments.glob) || str(tool.arguments.pattern)
  const meta: MetaPart[] = !done ? [] : [{ text: paths.length ? `${plural(paths.length, "file")}${truncated ? "+" : ""}` : "No files" }]
  return { verb: "Found", target: pattern, path: false, meta, body: listBody(paths.map((label) => ({ label })), bodyCaps.listPreview, bodyCaps.listMax) }
}

function searchWeb(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const results = arr(tool.result?.data).map(rec)
  const items = results.map((item) => ({ label: str(item.title) || str(item.url), detail: domainOf(str(item.url)) })).filter((item) => item.label)
  const done = tool.status === "completed" && tool.result?.ok === true
  const meta: MetaPart[] = done ? [{ text: items.length ? plural(items.length, "result") : "No results" }] : []
  return { verb: "Searched the web", target: str(tool.arguments.query), path: false, meta, body: listBody(items, bodyCaps.webResults, bodyCaps.webResults) }
}

function fetchPage(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const url = str(tool.arguments.url) || str(tool.result?.meta.url)
  const page = str(tool.result?.data)
  const title = firstHeading(page)
  const paragraph = firstParagraph(page)
  const text = [title ? `**${title}**` : "", paragraph].filter(Boolean).join("\n\n")
  return {
    verb: "Read", target: domainPath(url), path: false,
    meta: title ? [{ text: clipLine(title, 60) }] : [],
    body: text ? { type: "markdown", text, preview: bodyCaps.markdownPreview } : undefined,
  }
}

// ---------- shell ----------

function bash(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const data = rec(tool.result?.data)
  const command = str(tool.arguments.command) || str(data.command)
  const meta = [...shellStatus(data), ...durationMeta(tool)]
  return { verb: "Ran", target: firstLine(command), path: false, meta, body: terminalBody(tool, data) }
}

function taskCheck(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const data = rec(tool.result?.data)
  const action = tool.toolName === "bash_output"
    ? (tool.arguments.kill === true ? "cancel" : "wait")
    : str(tool.arguments.action)
  if (action === "list") {
    const tasks = arr(data.tasks).map(rec)
    const items = tasks.map((task) => ({ label: firstLine(str(task.command)) || str(task.task_id), detail: str(task.status) }))
    const done = tool.status === "completed" && tool.result?.ok === true
    return { verb: "Listed tasks", target: "", path: false, meta: done ? [{ text: plural(items.length, "task") }] : [], body: listBody(items, bodyCaps.listPreview, bodyCaps.listMax) }
  }
  const label = firstLine(str(data.command)) || str(tool.arguments.task_id) || str(tool.arguments.bg_id)
  const status = str(data.status)
  return {
    verb: action === "cancel" ? "Stopped" : "Checked",
    target: label, path: false,
    meta: [...(status ? [{ text: status }] : []), ...shellStatus({ exit_code: data.exit_code })],
    body: terminalBody(tool, data),
  }
}

function shellStatus(data: Record<string, unknown>): MetaPart[] {
  const code = num(data.exit_code)
  if (code !== undefined && code !== 0) return [{ text: `exit ${code}`, tone: "danger" }]
  if (str(data.status) === "running") return [{ text: "in background", tone: "info" }]
  return []
}

function terminalBody(tool: ToolEntry, data: Record<string, unknown>): ToolBody | undefined {
  const stdout = textLines(str(data.stdout))
  const stderr = textLines(str(data.stderr))
  const streamed = tool.result ? [] : textLines(tool.output)
  const lines = [...stdout, ...stderr, ...streamed]
  return lines.length ? { type: "terminal", lines, preview: bodyCaps.terminalPreview, max: bodyCaps.terminalMax } : undefined
}

// ---------- agents, goals ----------

function unwrapData(rawData: unknown): Record<string, unknown> {
  let current = rec(rawData)
  if (typeof rawData === "string") {
    try {
      current = rec(JSON.parse(rawData))
    } catch {
      // Plain string data.
    }
  }
  if (current.result && typeof current.result === "object" && !Array.isArray(current.result)) {
    return rec(current.result)
  }
  return current
}

function delegate(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const data = unwrapData(tool.result?.data)
  if (tool.arguments.wait === true || Array.isArray(data.settled)) {
    const settled = arr(data.settled)
    const taskId = str(tool.arguments.task)
    const target = taskId ? `task ${taskId}` : "delegated tasks"
    const output = (str(data.output) || str(data.summary)).trim()
    return {
      verb: "Waited for",
      target,
      path: false,
      meta: [
        { text: `${settled.length} settled` },
        ...(data.timedOut ? [{ text: "timed out", tone: "danger" as const }] : data.released ? [{ text: "released" }] : []),
        ...durationMeta(tool),
      ],
      body: output ? { type: "markdown", text: output, preview: bodyCaps.markdownPreview } : undefined,
    }
  }
  const retire = str(tool.arguments.retire)
  if (retire) {
    return {
      verb: "Retired",
      target: retire,
      path: false,
      meta: durationMeta(tool),
    }
  }
  const newName = str(rec(tool.arguments.new).name)
  const isNew = Boolean(newName && !str(data.assignee) && !str(tool.arguments.to))
  const baseAgent = str(data.assignee) || str(tool.arguments.to) || newName || str(tool.arguments.agent_id) || str(data.agent_id)
  const agent = isNew ? `${baseAgent} (new)` : baseAgent
  const task = clipLine(str(tool.arguments.brief) || str(tool.arguments.message) || str(tool.arguments.task), 80)
  const status = str(data.status)
  const summary = str(data.summary).trim()
  return {
    verb: "Delegated to", target: [agent, task].filter(Boolean).join(": "), path: false,
    meta: [...(str(data.taskId) ? [{ text: "task " + str(data.taskId) }] : []), ...(status ? [{ text: status }] : []), ...durationMeta(tool)],
    body: summary ? { type: "markdown", text: summary, preview: bodyCaps.markdownPreview } : undefined,
  }
}

function reportTool(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const data = unwrapData(tool.result?.data)
  const blocked = rec(tool.arguments.blocked)
  if (Object.keys(blocked).length > 0) {
    const responder = str(blocked.responder) || "lead"
    const action = str(blocked.action)
    const summary = str(tool.arguments.summary).trim()
    return {
      verb: "Reported",
      target: "blocked",
      path: false,
      meta: [{ text: action ? `needs ${responder}: ${action}` : `needs ${responder}`, tone: "danger" }],
      body: summary ? { type: "markdown", text: summary, preview: bodyCaps.markdownPreview } : undefined,
    }
  }
  const outcome = str(tool.arguments.outcome) || str(data.outcome) || str(data.status) || "completed"
  const delivered = Boolean(data.delivered)
  const summary = (str(tool.arguments.summary) || str(data.summary)).trim()
  const evidence = arr(tool.arguments.evidence).map((x) => str(x).trim()).filter(Boolean)
  const artifacts = arr(tool.arguments.artifacts)
    .map((x) => str(x).trim().split(/[\\/]/).pop() || "")
    .filter(Boolean)
  const sections = [
    summary,
    evidence.length ? `**Evidence:** ${evidence.join(" · ")}` : "",
    artifacts.length ? `**Files:** \`${artifacts.join("`, `")}\`` : "",
  ].filter(Boolean)
  return {
    verb: "Reported",
    target: outcome,
    path: false,
    meta: [
      ...(delivered ? [{ text: "delivered", tone: "success" as const }] : []),
      ...(artifacts.length ? [{ text: plural(artifacts.length, "file") }] : []),
    ],
    body: sections.length ? { type: "markdown", text: sections.join("\n\n"), preview: bodyCaps.markdownPreview } : undefined,
  }
}

function agentManagementTool(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const data = unwrapData(tool.result?.data)
  const rawAction = str(tool.arguments.action) || str(tool.arguments.operation) || str(data.action) || "update"
  const actionLabel = rawAction.replace(/[_-]+/g, " ")
  const subject =
    str(tool.arguments.name) ||
    str(tool.arguments.team) ||
    str(tool.arguments.agent) ||
    str(tool.arguments.member) ||
    str(tool.arguments.taskId) ||
    str(data.name) ||
    str(rec(data.team).name) ||
    str(rec(data.agent).name)
  const summary = (str(data.summary) || str(tool.arguments.brief) || str(tool.arguments.description)).trim()
  const status = str(data.status)
  return {
    verb: "Managed agents",
    target: subject ? `${actionLabel}: ${subject}` : actionLabel,
    path: false,
    meta: status ? [{ text: status }] : [],
    body: summary ? { type: "markdown", text: summary, preview: bodyCaps.markdownPreview } : undefined,
  }
}

function agentCreate(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const data = rec(tool.result?.data)
  const name = str(data.name) || str(tool.arguments.agent_id)
  const description = str(data.description) || str(tool.arguments.description)
  return { verb: "Created agent", target: name, path: false, meta: [], body: describe(name, description) }
}

function updateGoal(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const data = rec(tool.result?.data)
  const status = str(data.status) || str(tool.arguments.status)
  const objective = str(data.objective).trim()
  return {
    verb: "Updated goal", target: "", path: false,
    meta: status ? [{ text: status, tone: status === "blocked" ? "danger" : status === "complete" ? "success" : undefined }] : [],
    body: objective ? { type: "markdown", text: objective, preview: bodyCaps.markdownPreview } : undefined,
  }
}

function describe(name: string, description: string): ToolBody | undefined {
  const text = [name ? `**${name}**` : "", description.trim()].filter(Boolean).join("\n\n")
  return description.trim() ? { type: "markdown", text, preview: bodyCaps.markdownPreview } : undefined
}

// ---------- unknown tools ----------

function unknownTool(tool: ToolEntry): Omit<ToolView, "hidden" | "error"> {
  const fields = Object.entries(tool.arguments)
    .filter(([key]) => !key.startsWith("_"))
    .map(([key, value]) => ({ key, value: clipLine(typeof value === "string" ? value : JSON.stringify(value) ?? "", 200) }))
  const result = resultLines(tool)
  const raw = tool.output
  const body = fields.length || result.length ? { type: "fields" as const, fields, result, resultMax: bodyCaps.unknownResult, raw } : undefined
  return { verb: tool.toolName || "Tool", target: "", path: false, meta: durationMeta(tool), body }
}

function resultLines(tool: ToolEntry): string[] {
  const result = tool.result
  if (!result || result.ok === false) return []
  if (result.ok === null) return textLines(result.raw)
  if (typeof result.data === "string") return textLines(result.data)
  if (result.data === undefined || result.data === null) return []
  return textLines(JSON.stringify(result.data, null, 2))
}

// ---------- errors ----------

export function toolError(tool: ToolEntry): ToolError {
  const result = tool.result
  const text = result?.error || (result?.ok === null ? result.raw : "") || tool.errorType || "The tool failed."
  const lines = textLines(text)
  const message = lines.slice(0, bodyCaps.errorLines).join("\n")
  const rest = lines.slice(bodyCaps.errorLines)
  const type = tool.errorType && tool.errorType !== text ? [`Type: ${tool.errorType}`] : []
  return { message, details: [...rest, ...type].join("\n") }
}

// ---------- helpers ----------

function listBody(items: ListItem[], preview: number, max: number): ToolBody | undefined {
  return items.length ? { type: "list", items, preview, max } : undefined
}

function durationMeta(tool: ToolEntry): MetaPart[] {
  const text = formatDuration(tool.durationMs)
  return text ? [{ text }] : []
}

function resultFile(tool: ToolEntry): Record<string, unknown> {
  return rec(arr(tool.result?.meta.files)[0])
}

export function argPath(tool: ToolEntry): string {
  return str(tool.arguments.path) || str(tool.arguments.file_path) || str(tool.result?.meta.path) || str(resultFile(tool).path)
}

export function textLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.length === 1 && !lines[0].trim() ? [] : lines
}

function firstLine(text: string): string {
  return clipLine(text.trim().split(/\r?\n/)[0] || "", 160)
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "") } catch { return "" }
}

export function domainPath(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === "/" ? "" : parsed.pathname
    return `${parsed.hostname.replace(/^www\./, "")}${path}`
  } catch {
    return url
  }
}

function firstHeading(markdown: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(markdown)
  return heading ? heading[1].replace(/[#*_`]+/g, "").trim() : ""
}

function firstParagraph(markdown: string): string {
  const blocks = markdown.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((block) => block.trim())
  const paragraph = blocks.find((block) => block && !/^(#|[-*+]\s|\d+\.\s|```|>|!\[|\|)/.test(block))
  return paragraph ? clipLine(paragraph, 600) : ""
}

export function plural(count: number, noun: string, many = `${noun}s`) {
  return `${count} ${count === 1 ? noun : many}`
}

/** Makes a path relative to the project root; undefined when it lies outside. */
export function projectRelativePath(path: string, root: string): string | undefined {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const target = normalize(path.trim())
  if (!target) return undefined
  const absolute = target.startsWith("/") || /^[A-Za-z]:\//.test(target)
  if (!absolute) return target.split("/").includes("..") ? undefined : target.replace(/^\.\//, "")
  const base = normalize(root)
  if (!base) return undefined
  const windows = /^[A-Za-z]:\//.test(base)
  const same = (a: string, b: string) => windows ? a.toLowerCase() === b.toLowerCase() : a === b
  if (same(target, base)) return ""
  const prefix = target.slice(0, base.length + 1)
  return same(prefix, `${base}/`) ? target.slice(base.length + 1) : undefined
}

export type TurnFileChange = { path: string; added: number; removed: number; toolCallId: string }

export function summarizeTurnFileChanges(entries: ReadonlyArray<{ kind: string; id?: string; toolCallId?: string; toolName?: string } & Record<string, unknown>>): TurnFileChange[] {
  let start = entries.length
  while (start > 0) {
    const kind = entries[start - 1]?.kind
    if (kind === "user") break
    start -= 1
  }
  const byPath = new Map<string, TurnFileChange>()
  for (const entry of entries.slice(start)) {
    if (entry.kind !== "tool") continue
    const tool = entry as unknown as ToolEntry
    if (tool.toolName !== "write_file" && tool.toolName !== "edit_file") continue
    const path = argPath(tool)
    if (!path) continue
    const counts = tool.toolName === "write_file"
      ? { added: num(resultFile(tool).added_lines) ?? textLines(str(tool.arguments.content)).length, removed: 0 }
      : editCounts(tool) || { added: 0, removed: 0 }
    const prev = byPath.get(path)
    byPath.set(path, {
      path,
      added: (prev?.added || 0) + counts.added,
      removed: (prev?.removed || 0) + counts.removed,
      toolCallId: prev?.toolCallId || tool.toolCallId || tool.id,
    })
  }
  return [...byPath.values()]
}

function str(value: unknown) { return typeof value === "string" ? value : "" }
function num(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function arr(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
