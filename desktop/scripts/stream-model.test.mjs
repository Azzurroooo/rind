import assert from "node:assert/strict"
import test from "node:test"

import {
  addUserMessage,
  boundText,
  clipLine,
  createConversation,
  formatDuration,
  maxEntries,
  reduceEvent,
  relativeTime,
} from "../src/renderer/stream-model.ts"

function event(type, data = {}, turnId = "turn-1") {
  return { type, sequence: 1, sessionId: "session", turnId, event: data }
}

test("assistant deltas accumulate into one entry per turn", () => {
  let state = createConversation()
  state = reduceEvent(state, event("turn_started"))
  state = reduceEvent(state, event("assistant_delta", { text: "Hello" }))
  state = reduceEvent(state, event("assistant_delta", { text: " world" }))
  const assistants = state.entries.filter((entry) => entry.kind === "assistant")
  assert.equal(assistants.length, 1)
  assert.equal(assistants[0].content, "Hello world")
  assert.equal(state.activeTurnId, "turn-1")
})

test("tool lifecycle correlates by tool_call_id into a single row", () => {
  let state = createConversation()
  state = reduceEvent(state, event("turn_started"))
  state = reduceEvent(state, event("tool_requested", { tool_call_id: "call-1", tool_name: "shell", args_preview: "ls -la" }))
  state = reduceEvent(state, event("tool_call_started", { tool_call_id: "call-1", tool_name: "shell" }))
  state = reduceEvent(state, event("tool_result", { tool_call_id: "call-1", tool_name: "shell", status: "completed", result: "ok", duration_ms: 120 }))
  const tools = state.entries.filter((entry) => entry.kind === "tool")
  assert.equal(tools.length, 1)
  assert.equal(tools[0].toolName, "shell")
  assert.equal(tools[0].argsPreview, "ls -la")
  assert.equal(tools[0].status, "completed")
  assert.equal(tools[0].output, "ok")
  assert.equal(tools[0].durationMs, 120)
})

test("tool errors surface error status and type", () => {
  let state = createConversation()
  state = reduceEvent(state, event("tool_result", { tool_call_id: "c", tool_name: "read_file", error_type: "NotFound", result: "missing" }))
  const tool = state.entries.find((entry) => entry.kind === "tool")
  assert.equal(tool.status, "error")
  assert.equal(tool.errorType, "NotFound")
})

test("turn completion clears active turn and settles running tools", () => {
  let state = createConversation()
  state = reduceEvent(state, event("turn_started"))
  state = reduceEvent(state, event("tool_call_started", { tool_call_id: "c", tool_name: "shell" }))
  state = reduceEvent(state, event("turn_completed", { duration_ms: 900 }))
  assert.equal(state.activeTurnId, "")
  const tool = state.entries.find((entry) => entry.kind === "tool")
  assert.equal(tool.status, "completed")
})

test("turn failure appends an error entry and clears the question", () => {
  let state = createConversation()
  state = reduceEvent(state, event("turn_started"))
  state = reduceEvent(state, event("user_question_requested", { tool_call_id: "q1", question: "Proceed?", options: ["yes", "no"], recommended: "yes" }))
  assert.equal(state.question.question, "Proceed?")
  state = reduceEvent(state, event("turn_failed", { error: "boom", error_source: "provider" }))
  assert.equal(state.question, undefined)
  assert.equal(state.activeTurnId, "")
  const error = state.entries.find((entry) => entry.kind === "error")
  assert.equal(error.content, "boom")
  assert.equal(error.source, "provider")
})

test("token stats update context usage percent", () => {
  let state = createConversation()
  state = reduceEvent(state, event("token_stats_updated", { stats: { context_usage_percent: 0.42 } }))
  assert.equal(state.contextUsagePercent, 0.42)
  state = reduceEvent(state, event("token_stats_updated", { stats: {} }))
  assert.equal(state.contextUsagePercent, 0.42)
})

test("file change events produce file entries", () => {
  let state = createConversation()
  state = reduceEvent(state, event("file_change", { file_path: "src/main.ts" }))
  const file = state.entries.find((entry) => entry.kind === "file")
  assert.equal(file.filePath, "src/main.ts")
})

test("entries are bounded and user messages append immutably", () => {
  let state = createConversation()
  for (let index = 0; index < maxEntries + 10; index += 1) state = addUserMessage(state, `m${index}`)
  assert.equal(state.entries.length, maxEntries)
  assert.equal(state.entries.at(-1).content, `m${maxEntries + 9}`)
})

test("helper formatting stays compact", () => {
  assert.equal(clipLine("a\nb   c", 80), "a b c")
  assert.equal(clipLine("x".repeat(50), 10), "xxxxxxxxx…")
  assert.equal(formatDuration(0), "")
  assert.equal(formatDuration(120), "120ms")
  assert.equal(formatDuration(1500), "1.5s")
  assert.equal(formatDuration(65_000), "1m5s")
  assert.equal(boundText("abcd", 3).includes("[Output truncated]"), true)
  assert.equal(relativeTime("not a date"), "")
})
