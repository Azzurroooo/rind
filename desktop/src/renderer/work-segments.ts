// Work-segment folding (spec section 5.1). Every tool call between two pieces
// of visible prose folds into one segment with a generated summary. Pure and
// DOM-free; inputs are never mutated.

import type { Entry, ToolEntry } from "./timeline-model.ts"
import { argPath, editCounts, hiddenTools, plural } from "./tool-display.ts"

export type WorkSegment = {
  kind: "segment"
  id: string
  tools: ToolEntry[]
  /** A call is still running, or the turn is active and this is the last segment. */
  live: boolean
  /** The agent is waiting on the person (an open ask_user_question). */
  awaiting: boolean
}
export type StreamItem = Entry | WorkSegment
export type SegmentOpenMode = "all" | "trimmed" | "closed"
export type SegmentSummary = { text: string; failed: number; cancelled: number; durationMs: number }

export const liveTrailingCalls = 2

type FoldOptions = { activeTurn: boolean; awaitingToolCallId?: string }

export function isWorkSegment(item: StreamItem): item is WorkSegment {
  return item.kind === "segment"
}

/** Groups tool calls between prose boundaries into segments. */
export function foldWorkSegments(entries: readonly Entry[], options: FoldOptions): StreamItem[] {
  const items: StreamItem[] = []
  let tools: ToolEntry[] = []
  let trailing: Entry[] = []
  const flush = (last: boolean) => {
    items.push(...segmentItems(tools, trailing, options, last))
    tools = []
    trailing = []
  }
  for (const entry of entries) {
    if (entry.kind === "tool") tools = [...tools, entry]
    else if (isBoundary(entry)) {
      flush(false)
      items.push(entry)
    } else trailing = [...trailing, entry]
  }
  flush(true)
  return items
}

function isBoundary(entry: Entry): boolean {
  if (entry.kind === "assistant") return entry.content.trim().length > 0
  return entry.kind === "user" || entry.kind === "error" || entry.kind === "notice" || entry.kind === "command"
}

function segmentItems(tools: ToolEntry[], trailing: Entry[], options: FoldOptions, last: boolean): StreamItem[] {
  const visible = tools.filter((tool) => !hiddenTools.has(tool.toolName))
  const extras = trailing.filter((entry) => entry.kind !== "file" || !coveredByTool(entry.filePath, visible))
  if (!visible.length) return extras
  const awaiting = tools.some((tool) => isLive(tool) && (tool.toolName === "ask_user_question" || tool.toolCallId === options.awaitingToolCallId))
  const live = visible.some(isLive) || (options.activeTurn && last)
  return [{ kind: "segment", id: `segment:${visible[0].id}`, tools: visible, live, awaiting }, ...extras]
}

function isLive(tool: ToolEntry) {
  return tool.status === "running" || tool.status === "pending"
}

/** A file_change row repeats a write or edit already shown in the segment. */
function coveredByTool(filePath: string, tools: readonly ToolEntry[]) {
  return tools.some((tool) => (tool.toolName === "write_file" || tool.toolName === "edit_file") && samePath(argPath(tool), filePath))
}

export function samePath(a: string, b: string) {
  const left = a.replace(/\\/g, "/")
  const right = b.replace(/\\/g, "/")
  if (!left || !right) return false
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

/** Open state: the person's choice wins, then live (trimmed), failed or awaiting (all). */
export function segmentOpenMode(segment: WorkSegment, choice: boolean | undefined): SegmentOpenMode {
  if (choice === true) return "all"
  if (choice === false) return "closed"
  if (segment.live) return "trimmed"
  const failed = segment.tools.some((tool) => tool.status === "error")
  return failed || segment.awaiting ? "all" : "closed"
}

/** Running calls plus the last finished ones, in original order. */
export function trimmedCalls(tools: readonly ToolEntry[], keep = liveTrailingCalls): { shown: ToolEntry[]; earlier: number } {
  const finished = tools.filter((tool) => !isLive(tool))
  const kept = new Set([...tools.filter(isLive), ...finished.slice(Math.max(0, finished.length - keep))])
  const shown = tools.filter((tool) => kept.has(tool))
  return { shown, earlier: tools.length - shown.length }
}

// ---------- summary ----------

type Group = { key: string; tools: ToolEntry[] }

const groupKeys: Record<string, string> = {
  read_file: "read",
  fetch_web_page: "page",
  grep: "search",
  glob: "search",
  search_web: "web",
  bash: "run",
  bash_output: "task",
  task_control: "task",
  write_file: "edit",
  edit_file: "edit",
  delegate: "delegate",
  agent_create: "agent",
  skill_create: "skillCreate",
  skill: "skill",
  update_goal: "goal",
}

/** "Read 4 files, searched 2 patterns, ran 3 commands, edited app.ts +12 -3". */
export function segmentSummary(tools: readonly ToolEntry[]): SegmentSummary {
  const groups = tools.reduce<Group[]>((acc, tool) => {
    const key = groupKeys[tool.toolName] || `tool:${tool.toolName}`
    const index = acc.findIndex((group) => group.key === key)
    return index < 0
      ? [...acc, { key, tools: [tool] }]
      : acc.map((group, at) => at === index ? { ...group, tools: [...group.tools, tool] } : group)
  }, [])
  const phrases = groups.map(groupPhrase).filter(Boolean)
  const text = phrases.join(", ")
  return {
    text: text ? `${text[0].toUpperCase()}${text.slice(1)}` : "",
    failed: tools.filter((tool) => tool.status === "error").length,
    cancelled: tools.filter((tool) => tool.status === "cancelled").length,
    durationMs: tools.reduce((total, tool) => total + Math.max(0, tool.durationMs), 0),
  }
}

function groupPhrase(group: Group): string {
  const count = group.tools.length
  switch (group.key) {
    case "read": return pathPhrase("read", uniquePaths(group.tools), count)
    case "page": return `read ${plural(count, "page")}`
    case "search": return `searched ${plural(count, "pattern")}`
    case "web": return count === 1 ? "searched the web" : `searched the web ${count} times`
    case "run": return `ran ${plural(count, "command")}`
    case "task": return `checked ${plural(count, "task")}`
    case "edit": return editPhrase(group.tools)
    case "delegate": return `delegated ${plural(count, "task")}`
    case "agent": return `created ${plural(count, "agent")}`
    case "skillCreate": return `created ${plural(count, "skill")}`
    case "skill": return `loaded ${plural(count, "skill")}`
    case "goal": return "updated the goal"
    default: {
      const name = group.key.slice("tool:".length) || "a tool"
      return count === 1 ? `used ${name}` : `used ${name} ${count} times`
    }
  }
}

function uniquePaths(tools: readonly ToolEntry[]): string[] {
  return [...new Set(tools.map(argPath).filter(Boolean))]
}

function pathPhrase(verb: string, paths: string[], calls: number) {
  if (paths.length === 1) return `${verb} ${basename(paths[0])}`
  return `${verb} ${plural(paths.length || calls, "file")}`
}

function editPhrase(tools: readonly ToolEntry[]) {
  const totals = tools.map((tool) => editCounts(tool)).reduce<{ added: number; removed: number } | undefined>(
    (sum, counts) => counts ? { added: (sum?.added || 0) + counts.added, removed: (sum?.removed || 0) + counts.removed } : sum,
    undefined,
  )
  const base = pathPhrase("edited", uniquePaths(tools), tools.length)
  return totals ? `${base} +${totals.added} -${totals.removed}` : base
}

export function basename(path: string) {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] || path
}
