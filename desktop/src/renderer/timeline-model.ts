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
  | { kind: "assistant"; id: string; content: string; turnId: string }
  | ToolEntry
  | { kind: "file"; id: string; filePath: string }
  | { kind: "error"; id: string; content: string; source: string }
  | { kind: "notice"; id: string; content: string; label: string }
export type Question = { toolCallId: string; turnId: string; question: string; options: string[]; recommended?: string }
export type ConversationState = {
  entries: Entry[]
  activeTurnId: string
  turnStartedAt: number
  question?: Question
  contextUsagePercent: number | null
  openAssistantId: string
  nextEntryId: number
}

export const maxEntryChars = 30_000
export const maxEntries = 400

export function createConversation(): ConversationState {
  return { entries: [], activeTurnId: "", turnStartedAt: 0, contextUsagePercent: null, openAssistantId: "", nextEntryId: 1 }
}

export function boundText(value: string, limit = maxEntryChars) {
  return value.length > limit ? `${value.slice(0, limit)}\n\n[Output truncated]` : value
}

export function addUserMessage(state: ConversationState, content: string): ConversationState {
  return appendEntry(closeAssistant(state), { kind: "user", id: "", content: boundText(content) })
}

export function reduceEvent(state: ConversationState, envelope: RuntimeEvent): ConversationState {
  const event = envelope.event
  const turnId = envelope.turnId
  switch (envelope.type) {
    case "turn_started": return { ...closeAssistant(state), activeTurnId: turnId, turnStartedAt: Date.now() }
    case "assistant_delta": return appendAssistantDelta(state, turnId, asString(event.text))
    case "assistant_message_completed": return completeAssistant(state, turnId, asString(event.content))
    case "tool_requested": return reduceTool(state, envelope, () => ({ status: "pending", toolName: asString(event.tool_name), argsPreview: clipLine(asString(event.args_preview), 120) }))
    case "tool_input_started": return reduceTool(state, envelope, () => ({ status: "pending", toolName: asString(event.tool_name) }))
    case "tool_input_delta": return reduceTool(state, envelope, (tool) => ({ toolName: tool.toolName || asString(event.tool_name), argsPreview: clipLine(tool.argsPreview + asString(event.delta), 120) }))
    case "tool_input_ended": return reduceTool(state, envelope, (tool) => ({ toolName: tool.toolName || asString(event.tool_name) }))
    case "tool_call_started": return reduceTool(state, envelope, (tool) => ({ status: "running", toolName: tool.toolName || asString(event.tool_name) }))
    case "tool_progress": return reduceTool(state, envelope, (tool) => ({ output: boundText(tool.output + summarizeProgress(event.payload)) }))
    case "tool_result": return reduceTool(state, envelope, (tool) => ({
      status: asString(event.status) === "error" || asString(event.error_type) ? "error" : "completed",
      output: boundText(asString(event.result) || tool.output), errorType: asString(event.error_type), durationMs: asInt(event.duration_ms),
    }))
    case "file_change": {
      const filePath = asString(event.file_path)
      return filePath ? appendEntry(closeAssistant(state), { kind: "file", id: "", filePath }) : closeAssistant(state)
    }
    case "user_question_requested": return {
      ...closeAssistant(state), question: {
        toolCallId: asString(event.tool_call_id), turnId, question: asString(event.question) || "Question required",
        options: Array.isArray(event.options) ? event.options.filter((item): item is string => typeof item === "string") : [],
        recommended: asString(event.recommended) || undefined,
      },
    }
    case "token_stats_updated": {
      const stats = asRecord(event.stats)
      const percent = typeof stats.context_usage_percent === "number" ? stats.context_usage_percent : null
      return percent === null ? state : { ...state, contextUsagePercent: percent }
    }
    case "turn_failed": return finishTurn(appendEntry(closeAssistant(state), { kind: "error", id: "", content: asString(event.error) || "Turn failed", source: asString(event.error_source) || "Runtime error" }), turnId)
    case "turn_cancelled": return finishTurn(appendEntry(closeAssistant(state), { kind: "notice", id: "", content: asString(event.reason) || "Stopped", label: "Interrupted" }), turnId)
    case "turn_completed": return finishTurn(markRunningTools(closeAssistant(state), "completed"), turnId)
    default: return state
  }
}

export function conversationFromReplay(messages: unknown[]): ConversationState {
  let state = createConversation()
  for (const message of messages) {
    const record = asRecord(message)
    const role = asString(record.role)
    if (role === "user") {
      state = appendEntry(state, { kind: "user", id: "", content: boundText(asString(record.content)) })
      continue
    }
    if (role === "assistant") {
      const content = asString(record.content)
      if (content) state = appendEntry(state, { kind: "assistant", id: "", content: boundText(content), turnId: "" })
      for (const toolCall of Array.isArray(record.tool_calls) ? record.tool_calls : []) state = appendReplayTool(state, toolCall)
      continue
    }
    if (role === "tool") state = completeReplayTool(state, record)
  }
  return state
}

function appendAssistantDelta(state: ConversationState, turnId: string, text: string): ConversationState {
  if (!text) return state
  const current = state.entries.at(-1)
  if (current?.kind === "assistant" && current.id === state.openAssistantId && current.turnId === turnId) {
    return replaceEntry(state, current.id, { ...current, content: boundText(current.content + text) })
  }
  const next = appendEntry(closeAssistant(state), { kind: "assistant", id: "", content: boundText(text), turnId })
  return { ...next, openAssistantId: next.entries.at(-1)?.id || "" }
}

function completeAssistant(state: ConversationState, turnId: string, content: string): ConversationState {
  const current = state.entries.at(-1)
  if (content && current?.kind === "assistant" && current.id === state.openAssistantId && current.turnId === turnId) {
    return closeAssistant(replaceEntry(state, current.id, { ...current, content: boundText(content) }))
  }
  if (content) return appendEntry(closeAssistant(state), { kind: "assistant", id: "", content: boundText(content), turnId })
  return closeAssistant(state)
}

function reduceTool(state: ConversationState, envelope: RuntimeEvent, update: (tool: ToolEntry) => Partial<ToolEntry>): ConversationState {
  const closed = closeAssistant(state)
  const toolCallId = asString(envelope.event.tool_call_id)
  const toolName = asString(envelope.event.tool_name) || "Tool"
  const existing = toolCallId ? closed.entries.find((entry): entry is ToolEntry => entry.kind === "tool" && entry.toolCallId === toolCallId) : undefined
  if (existing) return replaceEntry(closed, existing.id, { ...existing, ...update(existing) })
  const empty: ToolEntry = { kind: "tool", id: "", toolCallId, toolName, argsPreview: "", status: "pending", output: "", errorType: "", durationMs: 0 }
  return appendEntry(closed, { ...empty, ...update(empty) })
}

function appendReplayTool(state: ConversationState, value: unknown): ConversationState {
  const toolCall = asRecord(value)
  const functionInfo = asRecord(toolCall.function)
  const toolCallId = asString(toolCall.id)
  if (!toolCallId) return state
  return appendEntry(state, { kind: "tool", id: "", toolCallId, toolName: asString(functionInfo.name) || "Tool", argsPreview: clipLine(asString(functionInfo.arguments), 120), status: "completed", output: "", errorType: "", durationMs: 0 })
}

function completeReplayTool(state: ConversationState, record: Record<string, unknown>): ConversationState {
  const toolCallId = asString(record.tool_call_id)
  if (!toolCallId) return state
  const existing = state.entries.find((entry): entry is ToolEntry => entry.kind === "tool" && entry.toolCallId === toolCallId)
  if (existing) return replaceEntry(state, existing.id, { ...existing, output: boundText(asString(record.content)) })
  return appendEntry(state, { kind: "tool", id: "", toolCallId, toolName: asString(record.tool_name) || "Tool", argsPreview: "", status: "completed", output: boundText(asString(record.content)), errorType: "", durationMs: 0 })
}

function appendEntry(state: ConversationState, entry: Entry): ConversationState {
  const id = entry.id || `entry-${state.nextEntryId}`
  return { ...state, entries: trimEntries([...state.entries, { ...entry, id } as Entry]), nextEntryId: state.nextEntryId + 1 }
}

function replaceEntry(state: ConversationState, id: string, next: Entry): ConversationState {
  return { ...state, entries: state.entries.map((entry) => entry.id === id ? next : entry) }
}

function closeAssistant(state: ConversationState): ConversationState {
  return state.openAssistantId ? { ...state, openAssistantId: "" } : state
}

function finishTurn(state: ConversationState, turnId: string): ConversationState {
  const cleared = !turnId || state.activeTurnId === turnId ? { activeTurnId: "", turnStartedAt: 0 } : {}
  const question = state.question && (!turnId || state.question.turnId === turnId) ? { question: undefined } : {}
  return { ...closeAssistant(state), ...cleared, ...question }
}

function markRunningTools(state: ConversationState, status: ToolStatus): ConversationState {
  if (!state.entries.some((entry) => entry.kind === "tool" && (entry.status === "running" || entry.status === "pending"))) return state
  return { ...state, entries: state.entries.map((entry) => entry.kind === "tool" && (entry.status === "running" || entry.status === "pending") ? { ...entry, status } : entry) }
}

function trimEntries(entries: Entry[]) { return entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries }
function summarizeProgress(payload: unknown) {
  const record = asRecord(payload)
  const text = ["output", "text", "message", "chunk"].map((key) => record[key]).find((value): value is string => typeof value === "string" && value.length > 0)
  return text ? `${clipLine(text, 200)}\n` : ""
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function asString(value: unknown) { return typeof value === "string" ? value : "" }
function asInt(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0 }

export function clipLine(value: string, limit: number) { const line = value.replace(/\s+/g, " ").trim(); return line.length > limit ? `${line.slice(0, limit - 1)}…` : line }
export function formatDuration(ms: number) {
  if (ms <= 0) return ""
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
}
export function relativeTime(iso: string, now = Date.now()) {
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
