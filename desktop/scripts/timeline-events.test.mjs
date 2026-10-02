import assert from "node:assert/strict"
import test from "node:test"

import { createConversation, reduceEvent } from "../src/renderer/timeline-model.ts"
import {
  backgroundWaitFrom,
  compactionLine,
} from "../src/renderer/timeline-system.ts"

function event(type, data = {}, turnId = "turn-1") {
  return { type, sequence: 1, durability: "incremental", sessionId: "session", turnId, event: data }
}

function run(events, state = createConversation()) {
  return events.reduce((current, envelope) => reduceEvent(current, envelope), state)
}

test("tool events before assistant completion finalize the original prose without duplicates", () => {
  const state = run([
    event("turn_started"),
    event("assistant_delta", { text: "Reading files." }),
    event("tool_input_started", { tool_call_id: "c1", tool_name: "read_file" }),
    event("tool_requested", { tool_call_id: "c1", tool_name: "read_file", arguments: { path: "README.md" } }),
    event("assistant_message_completed", { content: "Reading files.", ts: "2026-09-29T06:34:10Z" }),
    event("tool_result", { tool_call_id: "c1", result: "contents" }),
    event("assistant_delta", { text: "The answer." }),
    event("assistant_message_completed", { content: "The answer." }),
  ])
  assert.deepEqual(state.entries.map((entry) => entry.kind), ["assistant", "tool", "assistant"])
  assert.equal(state.entries[0].content, "Reading files.")
  assert.equal(state.entries[0].time, "2026-09-29T06:34:10Z")
  assert.equal(state.entries[0].pendingCompletion, false)
})

test("turn_step_retry drops the in-flight step and adds a warning system line", () => {
  const state = run([
    event("turn_started"),
    event("assistant_delta", { text: "kept, the tool call closed it" }),
    event("tool_requested", { tool_call_id: "call-1", tool_name: "read_file", arguments: { path: "a.ts" } }),
    event("turn_step_retry", { attempt: 2, reason: "rate limited" }),
  ])
  assert.equal(state.entries.some((entry) => entry.kind === "assistant"), true)
  assert.equal(state.entries.some((entry) => entry.kind === "tool"), false)
  const streaming = run([event("turn_started"), event("assistant_delta", { text: "partial" }), event("turn_step_retry", {})])
  assert.deepEqual(streaming.entries.map((entry) => entry.kind), ["system"])
  assert.equal(streaming.entries[0].content, "Retrying step")
  const line = state.entries.at(-1)
  assert.equal(line.kind, "system")
  assert.equal(line.tone, "warning")
  assert.equal(line.content, "Retrying step (attempt 2): rate limited")
  assert.ok(line.id)
})

test("compaction lines distinguish auto, manual and fallback summaries", () => {
  assert.deepEqual(compactionLine({ record: { reason: "auto", strategy: "llm_inline" } }), { content: "Context compacted automatically", tone: "info" })
  assert.deepEqual(compactionLine({ record: { reason: "manual", strategy: "llm_inline" } }), { content: "Context compacted", tone: "info" })
  assert.deepEqual(compactionLine({ record: { reason: "auto", strategy: "deterministic_fallback" } }), { content: "Context compacted automatically (summary fallback)", tone: "warning" })
  const state = run([event("context_compacted", { record: { reason: "manual" } })])
  assert.equal(state.entries.at(-1).kind, "system")
})

test("context_built stores a snapshot and usage without adding lines by default", () => {
  const state = run([event("context_built", {
    message_count: 12,
    stats: { estimated_input_tokens: 5000, context_window_tokens: 200000, auto_compact_token_limit: 160000, context_usage_percent: 0.025 },
    decisions: {},
  })])
  assert.equal(state.entries.length, 0)
  assert.deepEqual(state.contextSnapshot, {
    messageCount: 12, estimatedTokens: 5000, contextWindowTokens: 200000, autoCompactTokenLimit: 160000, usagePercent: 0.025,
  })
  assert.equal(state.contextUsagePercent, 0.025)
})

test("context_built keeps the previous usage when stats are missing and surfaces image notices", () => {
  const start = { ...createConversation(), contextUsagePercent: 0.4 }
  const state = run([event("context_built", { message_count: 3, decisions: { image_notice: "Images were dropped", image_notice_level: "warning" } })], start)
  assert.equal(state.contextUsagePercent, 0.4)
  assert.equal(state.contextSnapshot.usagePercent, null)
  assert.deepEqual({ kind: state.entries[0].kind, content: state.entries[0].content, tone: state.entries[0].tone }, { kind: "system", content: "Images were dropped", tone: "warning" })
})

test("background_wait_changed sets and clears the wait", () => {
  const waiting = run([event("background_wait_changed", { background_wait: { count: 2, started_at: "2026-09-29T10:00:00Z" } }, "")])
  assert.deepEqual(waiting.backgroundWait, { count: 2, startedAt: "2026-09-29T10:00:00Z" })
  const cleared = run([event("background_wait_changed", { background_wait: null }, "")], waiting)
  assert.equal(cleared.backgroundWait, null)
  assert.equal(backgroundWaitFrom({ background_wait: { count: 0 } }), null)
})

test("task_continuation_failed is an error that cannot be retried", () => {
  const state = run([event("task_continuation_failed", { error: "worker gone" }, "")])
  const entry = state.entries.at(-1)
  assert.equal(entry.kind, "error")
  assert.equal(entry.source, "Background task")
  assert.equal(entry.content, "worker gone")
  assert.notEqual(entry.retryable, true)
  const fallback = run([event("task_continuation_failed", {}, "")])
  assert.match(fallback.entries.at(-1).content, /background task/i)
})

test("turn_failed errors are retryable", () => {
  const state = run([event("turn_started"), event("turn_failed", { error: "boom" })])
  const entry = state.entries.at(-1)
  assert.equal(entry.kind, "error")
  assert.equal(entry.retryable, true)
})
