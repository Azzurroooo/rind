import type { RuntimeEvent } from "../preload/types"

export type ToolStatus = "pending" | "running" | "completed" | "error"

export type ToolEntry = {
  kind: "tool"
  id: string
  toolCallId: string
  toolName: string
  argsPreview: string
  status: ToolStatus
  output: string
  errorType: string
  durationMs: number
}

export type Entry =
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant"; id: string; content: string }
  | ToolEntry
  | { kind: "file"; id: string; filePath: string }
  | { kind: "error"; id: string; content: string; source: string }
  | { kind: "notice"; id: string; content: string; label: string }

export type Question = {
  toolCallId: string
  turnId: string
  question: string
  options: string[]
  recommended?: string
}

export type ConversationState = {
  entries: Entry[]
  activeTurnId: string
  turnStartedAt: number
  question?: Question
  contextUsagePercent: number | null
}

export const maxEntryChars = 30_000
export const maxEntries = 400

export function createConversation(): ConversationState {
  return { entries: [], activeTurnId: "", turnStartedAt: 0, contextUsagePercent: null }
}

export function boundText(value: string, limit = maxEntryChars): string {
  return value.length > limit ? `${value.slice(0, limit)}\n\n[Output truncated]` : value
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function withEntry(entries: Entry[], id: string, update: (entry: Entry) => Entry, create: () => Entry): Entry[] {
  const index = entries.findIndex((entry) => entry.id === id)
  if (index === -1) return [...entries, create()]
  const next = entries.slice()
  next[index] = update(next[index])
  return next
}

function trimEntries(entries: Entry[]): Entry[] {
  return entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries
}

export function addUserMessage(state: ConversationState, content: string): ConversationState {
  const entry: Entry = { kind: "user", id: `user-${state.entries.length}`, content: boundText(content) }
  return { ...state, entries: trimEntries([...state.entries, entry]) }
}

export function reduceEvent(state: ConversationState, envelope: RuntimeEvent): ConversationState {
  const event = envelope.event
  const turnId = envelope.turnId
  switch (envelope.type) {
    case "turn_started":
      return { ...state, activeTurnId: turnId, turnStartedAt: Date.now() }
    case "assistant_delta":
      return reduceAssistant(state, turnId, (content) => boundText(content + asString(event.text)))
    case "assistant_message_completed":
      return reduceAssistant(state, turnId, () => boundText(asString(event.content)))
    case "tool_requested":
      return reduceTool(state, envelope, () => ({
        status: "pending",
        toolName: asString(event.tool_name),
        argsPreview: clipLine(asString(event.args_preview), 120),
      }))
    case "tool_call_started":
      return reduceTool(state, envelope, (tool) => ({
        status: "running",
        toolName: tool.toolName || asString(event.tool_name),
      }))
    case "tool_progress":
      return reduceTool(state, envelope, (tool) => ({
        output: boundText(tool.output + summarizeProgress(event.payload)),
      }))
    case "tool_result":
      return reduceTool(state, envelope, (tool) => ({
        status: asString(event.status) === "error" || asString(event.error_type) ? "error" : "completed",
        output: boundText(asString(event.result) || tool.output),
        errorType: asString(event.error_type),
        durationMs: asInt(event.duration_ms),
      }))
    case "file_change": {
      const filePath = asString(event.file_path)
      if (!filePath) return state
      const entry: Entry = { kind: "file", id: `file-${state.entries.length}`, filePath }
      return { ...state, entries: trimEntries([...state.entries, entry]) }
    }
    case "user_question_requested":
      return {
        ...state,
        question: {
          toolCallId: asString(event.tool_call_id),
          turnId,
          question: asString(event.question) || "Question required",
          options: Array.isArray(event.options) ? event.options.filter((item): item is string => typeof item === "string") : [],
          recommended: asString(event.recommended) || undefined,
        },
      }
    case "token_stats_updated": {
      const stats = event.stats && typeof event.stats === "object" ? event.stats as Record<string, unknown> : {}
      const percent = typeof stats.context_usage_percent === "number" ? stats.context_usage_percent : null
      return percent === null ? state : { ...state, contextUsagePercent: percent }
    }
    case "turn_failed":
      return finishTurn(appendSimple(state, {
        kind: "error",
        id: `error-${state.entries.length}`,
        content: asString(event.error) || "Turn failed",
        source: asString(event.error_source) || "Runtime error",
      }), turnId)
    case "turn_cancelled":
      return finishTurn(appendSimple(state, {
        kind: "notice",
        id: `notice-${state.entries.length}`,
        content: asString(event.reason) || "Stopped",
        label: "Interrupted",
      }), turnId)
    case "turn_completed":
      return finishTurn(markRunningTools(state, "completed"), turnId)
    default:
      return state
  }
}

function appendSimple(state: ConversationState, entry: Entry): ConversationState {
  return { ...state, entries: trimEntries([...state.entries, entry]) }
}

function finishTurn(state: ConversationState, turnId: string): ConversationState {
  const cleared = !turnId || state.activeTurnId === turnId ? { activeTurnId: "", turnStartedAt: 0 } : {}
  const question = state.question && (!turnId || state.question.turnId === turnId) ? { question: undefined } : {}
  return { ...state, ...cleared, ...question }
}

function markRunningTools(state: ConversationState, status: ToolStatus): ConversationState {
  if (!state.entries.some((entry) => entry.kind === "tool" && (entry.status === "running" || entry.status === "pending"))) {
    return state
  }
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.kind === "tool" && (entry.status === "running" || entry.status === "pending") ? { ...entry, status } : entry,
    ),
  }
}

function reduceAssistant(state: ConversationState, turnId: string, update: (content: string) => string): ConversationState {
  const id = `assistant-${turnId || "draft"}`
  return {
    ...state,
    entries: trimEntries(withEntry(
      state.entries,
      id,
      (entry) => (entry.kind === "assistant" ? { ...entry, content: update(entry.content) } : entry),
      () => ({ kind: "assistant", id, content: update("") }),
    )),
  }
}

function reduceTool(
  state: ConversationState,
  envelope: RuntimeEvent,
  update: (tool: ToolEntry) => Partial<ToolEntry>,
): ConversationState {
  const toolCallId = asString(envelope.event.tool_call_id)
  const id = toolCallId ? `tool-${toolCallId}` : `tool-anon-${state.entries.length}`
  if (!toolCallId) {
    const entry: ToolEntry = {
      kind: "tool", id, toolCallId: "", toolName: asString(envelope.event.tool_name) || "Tool",
      argsPreview: "", status: "pending", output: "", errorType: "", durationMs: 0, ...update({} as ToolEntry),
    }
    return { ...state, entries: trimEntries([...state.entries, entry]) }
  }
  return {
    ...state,
    entries: trimEntries(withEntry(
      state.entries,
      id,
      (entry) => (entry.kind === "tool" ? { ...entry, ...update(entry) } : entry),
      () => ({
        kind: "tool", id, toolCallId, toolName: asString(envelope.event.tool_name) || "Tool",
        argsPreview: "", status: "pending", output: "", errorType: "", durationMs: 0, ...update({} as ToolEntry),
      }),
    )),
  }
}

function summarizeProgress(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const record = payload as Record<string, unknown>
  const text = ["output", "text", "message", "chunk"].map((key) => record[key]).find((value): value is string => typeof value === "string" && value.length > 0)
  return text ? clipLine(text, 200) + "\n" : ""
}

export function clipLine(value: string, limit: number): string {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return ""
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
}

export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ""
  const minutes = Math.max(0, Math.round((now - time) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  return new Date(time).toLocaleDateString()
}
