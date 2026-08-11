import type { RuntimeEvent } from "../preload/types"

export type ToolStatus = "pending" | "running" | "completed" | "error"
export type ToolResult = {
  raw: string
  ok: boolean | null
  toolName: string
  data: unknown
  meta: Record<string, unknown>
  error: string
  errorType: string
}
export type ToolEntry = {
  kind: "tool"
  id: string
  toolCallId: string
  toolName: string
  argsPreview: string
  arguments: Record<string, unknown>
  status: ToolStatus
  output: string
  errorType: string
  durationMs: number
  result?: ToolResult
}
export type PlanEntry = {
  kind: "plan"
  id: string
  toolCallId: string
  toolName: "update_plan"
  status: ToolStatus
  steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" | "cancelled" }>
  error: string
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
  plan?: PlanEntry
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
    case "plan_updated": return reducePlanSnapshot(state, envelope)
    case "tool_requested": return reduceTool(state, envelope, (tool) => ({
      status: "pending",
      toolName: asString(event.tool_name),
      ...(tool.kind === "tool" ? {
        arguments: asRecord(event.arguments),
        argsPreview: toolArgumentPreview(asString(event.tool_name), asRecord(event.arguments), asString(event.args_preview)),
      } : {}),
    }))
    case "tool_input_started": return reduceTool(state, envelope, () => ({ status: "pending", toolName: asString(event.tool_name) }))
    case "tool_input_delta": return reduceTool(state, envelope, (tool) => ({
      toolName: tool.toolName || asString(event.tool_name),
      ...(tool.kind === "tool" ? { argsPreview: clipLine(tool.argsPreview + asString(event.delta), 120) } : {}),
    }))
    case "tool_input_ended": return reduceTool(state, envelope, (tool) => ({ toolName: tool.toolName || asString(event.tool_name) }))
    case "tool_call_started": return reduceTool(state, envelope, (tool) => ({ status: "running", toolName: tool.toolName || asString(event.tool_name) }))
    case "tool_progress": return reduceTool(state, envelope, (tool) => tool.kind === "tool"
      ? { output: boundText(tool.output + summarizeProgress(event.payload)) }
      : {})
    case "tool_result": return reduceTool(state, envelope, (tool) => {
      const result = parseToolResult(asString(event.result) || (tool.kind === "tool" ? tool.output : ""))
      const errorType = asString(event.error_type) || result.errorType
      const status = asString(event.status) === "error" || errorType || result.ok === false ? "error" : "completed"
      if (tool.kind === "plan") {
        return { status, error: result.error, errorType, durationMs: asInt(event.duration_ms) }
      }
      return {
        status,
        output: result.raw, result, errorType, durationMs: asInt(event.duration_ms), error: result.error,
      }
    })
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

export function latestPlan(state: ConversationState): PlanEntry | undefined {
  return state.plan
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

type ToolUpdate = Partial<ToolEntry & Pick<PlanEntry, "error">>

function reducePlanSnapshot(state: ConversationState, envelope: RuntimeEvent): ConversationState {
  const toolCallId = asString(envelope.event.tool_call_id)
  const closed = removeToolCall(closeAssistant(state), toolCallId)
  const plan = envelope.event.plan
  if (!Array.isArray(plan)) return closed
  if (!plan.length) return { ...closed, plan: undefined }
  const steps = planSteps("update_plan", { plan })
  if (!steps) return closed
  const previous = closed.plan
  return {
    ...closed,
    plan: {
      kind: "plan",
      id: previous?.id || `plan-${toolCallId || closed.nextEntryId}`,
      toolCallId,
      toolName: "update_plan",
      status: "pending",
      steps,
      error: "",
      errorType: "",
      durationMs: 0,
    },
  }
}

function removeToolCall(state: ConversationState, toolCallId: string): ConversationState {
  if (!toolCallId || !state.entries.some((entry) => entry.kind === "tool" && entry.toolCallId === toolCallId)) return state
  return { ...state, entries: state.entries.filter((entry) => entry.kind !== "tool" || entry.toolCallId !== toolCallId) }
}

function reduceTool(state: ConversationState, envelope: RuntimeEvent, update: (tool: ToolEntry | PlanEntry) => ToolUpdate): ConversationState {
  const closed = closeAssistant(state)
  const toolCallId = asString(envelope.event.tool_call_id)
  const toolName = asString(envelope.event.tool_name) || "Tool"
  if (closed.plan && toolCallId && closed.plan.toolCallId === toolCallId) {
    return { ...closed, plan: { ...closed.plan, ...update(closed.plan) } as PlanEntry }
  }
  const existing = toolCallId ? closed.entries.find((entry): entry is ToolEntry => entry.kind === "tool" && entry.toolCallId === toolCallId) : undefined
  if (existing) return replaceEntry(closed, existing.id, { ...existing, ...update(existing) } as ToolEntry)
  const argumentsValue = asRecord(envelope.event.arguments)
  const steps = planSteps(toolName, argumentsValue)
  if (steps) {
    const plan: PlanEntry = { kind: "plan", id: "", toolCallId, toolName: "update_plan", status: "pending", steps, error: "", errorType: "", durationMs: 0 }
    return { ...closed, plan: { ...plan, ...update(plan), id: `plan-${toolCallId || closed.nextEntryId}` } as PlanEntry }
  }
  if (toolName === "update_plan") return closed
  const empty: ToolEntry = { kind: "tool", id: "", toolCallId, toolName, argsPreview: toolArgumentPreview(toolName, argumentsValue, asString(envelope.event.args_preview)), arguments: argumentsValue, status: "pending", output: "", errorType: "", durationMs: 0 }
  return appendEntry(closed, { ...empty, ...update(empty) } as ToolEntry)
}

function appendReplayTool(state: ConversationState, value: unknown): ConversationState {
  const toolCall = asRecord(value)
  const functionInfo = asRecord(toolCall.function)
  const toolCallId = asString(toolCall.id)
  if (!toolCallId) return state
  const toolName = asString(functionInfo.name) || "Tool"
  const argumentsValue = parseArguments(asString(functionInfo.arguments))
  const steps = planSteps(toolName, argumentsValue)
  if (steps) return { ...state, plan: { kind: "plan", id: `plan-${toolCallId}`, toolCallId, toolName: "update_plan", status: "completed", steps, error: "", errorType: "", durationMs: 0 } }
  if (toolName === "update_plan") return Array.isArray(argumentsValue.plan) ? { ...state, plan: undefined } : state
  return appendEntry(state, { kind: "tool", id: "", toolCallId, toolName, argsPreview: toolArgumentPreview(toolName, argumentsValue, asString(functionInfo.arguments)), arguments: argumentsValue, status: "completed", output: "", errorType: "", durationMs: 0 })
}

function completeReplayTool(state: ConversationState, record: Record<string, unknown>): ConversationState {
  const toolCallId = asString(record.tool_call_id)
  if (!toolCallId) return state
  const result = parseToolResult(asString(record.content))
  if (state.plan?.toolCallId === toolCallId) return {
    ...state,
    plan: {
      ...state.plan,
      status: result.ok === false ? "error" : "completed",
      error: result.error,
      errorType: result.errorType,
    },
  }
  const existing = state.entries.find((entry): entry is ToolEntry => entry.kind === "tool" && entry.toolCallId === toolCallId)
  if (existing) return replaceEntry(state, existing.id, {
    ...existing,
    output: result.raw,
    result,
    status: result.ok === false ? "error" : "completed",
    errorType: result.errorType,
  } as ToolEntry)
  return appendEntry(state, { kind: "tool", id: "", toolCallId, toolName: asString(record.tool_name) || "Tool", argsPreview: "", arguments: {}, status: result.ok === false ? "error" : "completed", output: result.raw, result, errorType: result.errorType, durationMs: 0 })
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

function parseArguments(value: string): Record<string, unknown> {
  try { return asRecord(JSON.parse(value)) } catch { return {} }
}

export function parseToolResult(value: string): ToolResult {
  const raw = boundText(value)
  try {
    const payload = asRecord(JSON.parse(value))
    if (typeof payload.ok === "boolean" && typeof payload.tool === "string") {
      return { raw, ok: payload.ok, toolName: payload.tool, data: payload.data, meta: asRecord(payload.meta), error: asString(payload.error), errorType: asString(payload.error_type) }
    }
  } catch { /* Raw tool output remains available as a fallback. */ }
  return { raw, ok: null, toolName: "", data: undefined, meta: {}, error: "", errorType: "" }
}

function planSteps(toolName: string, argumentsValue: Record<string, unknown>): PlanEntry["steps"] | undefined {
  if (toolName !== "update_plan" || !Array.isArray(argumentsValue.plan)) return undefined
  const steps = argumentsValue.plan.flatMap((item) => {
    const value = asRecord(item)
    const step = asString(value.step).trim()
    const status = asString(value.status)
    if (!step || !["pending", "in_progress", "completed", "cancelled"].includes(status)) return []
    return [{ step, status: status as PlanEntry["steps"][number]["status"] }]
  })
  return steps.length ? steps : undefined
}

export function toolArgumentPreview(toolName: string, argumentsValue: Record<string, unknown>, fallback = ""): string {
  const key = ["path", "file_path", "command", "query", "pattern", "task", "objective", "url"].find((name) => typeof argumentsValue[name] === "string")
  return clipLine(key ? asString(argumentsValue[key]) : fallback || (Object.keys(argumentsValue).length ? JSON.stringify(argumentsValue) : ""), 120)
}

export type FileMutationPreview = {
  filePath: string
  removed: string[]
  added: string[]
}

export function fileMutationPreview(toolName: string, argumentsValue: Record<string, unknown>): FileMutationPreview | undefined {
  const filePath = asString(argumentsValue.file_path)
  if (toolName === "edit_file") {
    const oldText = argumentsValue.old_str
    const newText = argumentsValue.new_str
    if (typeof oldText !== "string" || typeof newText !== "string") return undefined
    return { filePath, removed: previewDiffLines(oldText), added: previewDiffLines(newText) }
  }
  if (toolName === "write_file" && typeof argumentsValue.content === "string") {
    return { filePath, removed: [], added: previewDiffLines(argumentsValue.content) }
  }
  return undefined
}

function previewDiffLines(value: string): string[] {
  const source = value.replace(/\r\n?/g, "\n").split("\n")
  const lines: string[] = []
  let chars = 0
  for (const line of source) {
    if (lines.length >= 120 || chars + line.length > 12_000) {
      lines.push("…")
      break
    }
    lines.push(line)
    chars += line.length
  }
  return lines
}

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
