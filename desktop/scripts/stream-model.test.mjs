import assert from "node:assert/strict"
import test from "node:test"

import {
  addUserMessage,
  activePlan,
  addCommandResult,
  boundText,
  clipLine,
  conversationFromReplay,
  createConversation,
  fileMutationPreview,
  formatDuration,
  latestPlan,
  maxEntries,
  parseToolResult,
  reduceEvent,
  relativeTime,
} from "../src/renderer/timeline-model.ts"
import { composerRegionMarkup, syncPlanDockSession } from "../src/renderer/composer-region.ts"
import { highlightFile } from "../src/renderer/syntax-highlight.ts"

function event(type, data = {}, turnId = "turn-1") {
  return { type, sequence: 1, durability: "incremental", sessionId: "session", turnId, event: data }
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

test("slash command output stays outside the persisted conversation timeline", () => {
  const state = addCommandResult(createConversation(), "/status", "Session is ready.", { type: "status", session: "s1" })
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].kind, "command")
  assert.equal(state.entries[0].content, "Session is ready.")
})

test("completion without content preserves streamed assistant text", () => {
  let state = createConversation()
  state = reduceEvent(state, event("turn_started"))
  state = reduceEvent(state, event("assistant_delta", { text: "Streamed response" }))
  state = reduceEvent(state, event("assistant_message_completed", { content_chars: 17 }))
  const assistant = state.entries.find((entry) => entry.kind === "assistant")
  assert.equal(assistant.content, "Streamed response")
})

test("assistant text remains chronological around a tool call", () => {
  let state = createConversation()
  state = reduceEvent(state, event("turn_started"))
  state = reduceEvent(state, event("assistant_delta", { text: "I will inspect it." }))
  state = reduceEvent(state, event("tool_requested", { tool_call_id: "call-1", tool_name: "read_file", args_preview: "README.md" }))
  state = reduceEvent(state, event("tool_result", { tool_call_id: "call-1", tool_name: "read_file", status: "completed", result: "done" }))
  state = reduceEvent(state, event("assistant_delta", { text: "The file is ready." }))
  assert.deepEqual(state.entries.map((entry) => entry.kind), ["assistant", "tool", "assistant"])
  assert.equal(state.entries[0].content, "I will inspect it.")
  assert.equal(state.entries[2].content, "The file is ready.")
})

test("replay preserves tool calls and results between assistant messages", () => {
  const state = conversationFromReplay([
    { role: "user", content: "Inspect the project" },
    {
      role: "assistant",
      content: "Checking now.",
      tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
    },
    { role: "tool", tool_call_id: "call-1", content: "contents" },
    { role: "assistant", content: "The README is present." },
  ])
  assert.deepEqual(state.entries.map((entry) => entry.kind), ["user", "assistant", "tool", "assistant"])
  const tool = state.entries[2]
  assert.equal(tool.kind, "tool")
  assert.equal(tool.output, "contents")
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

test("tool requests backfill structured arguments after streamed input", () => {
  let state = createConversation()
  state = reduceEvent(state, event("tool_input_started", { tool_call_id: "edit-1", tool_name: "edit_file" }))
  state = reduceEvent(state, event("tool_requested", {
    tool_call_id: "edit-1",
    tool_name: "edit_file",
    arguments: { file_path: "src/app.py", old_str: "old", new_str: "new" },
  }))
  const tool = state.entries.find((entry) => entry.kind === "tool")
  assert.equal(tool?.kind, "tool")
  if (!tool || tool.kind !== "tool") return
  assert.deepEqual(tool.arguments, { file_path: "src/app.py", old_str: "old", new_str: "new" })
  assert.deepEqual(fileMutationPreview(tool.toolName, tool.arguments), {
    filePath: "src/app.py",
    removed: ["old"],
    added: ["new"],
  })
})

test("tool errors surface error status and type", () => {
  let state = createConversation()
  state = reduceEvent(state, event("tool_result", { tool_call_id: "c", tool_name: "read_file", error_type: "NotFound", result: "missing" }))
  const tool = state.entries.find((entry) => entry.kind === "tool")
  assert.equal(tool.status, "error")
  assert.equal(tool.errorType, "NotFound")
})

test("tool results retain structured output instead of only a JSON blob", () => {
  let state = createConversation()
  state = reduceEvent(state, event("tool_requested", {
    tool_call_id: "read-1", tool_name: "read_file", arguments: { path: "README.md" },
  }))
  state = reduceEvent(state, event("tool_result", {
    tool_call_id: "read-1", tool_name: "read_file", result: JSON.stringify({
      ok: true, tool: "read_file", data: { path: "README.md", lines: 18 }, meta: { truncated: false },
    }),
  }))
  const tool = state.entries.find((entry) => entry.kind === "tool")
  assert.deepEqual(tool.arguments, { path: "README.md" })
  assert.equal(tool.result.ok, true)
  assert.deepEqual(tool.result.data, { path: "README.md", lines: 18 })
  assert.equal(tool.argsPreview, "README.md")
})

test("plan updates stay separate from chronological message entries", () => {
  let state = createConversation()
  state = reduceEvent(state, event("assistant_delta", { text: "I will make a plan." }))
  state = reduceEvent(state, event("tool_requested", {
    tool_call_id: "plan-1", tool_name: "update_plan", arguments: { plan: [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" },
    ] },
  }))
  state = reduceEvent(state, event("tool_result", {
    tool_call_id: "plan-1", tool_name: "update_plan", result: JSON.stringify({ ok: true, tool: "update_plan", data: "Plan updated" }),
  }))
  state = reduceEvent(state, event("assistant_delta", { text: "Starting implementation." }))
  assert.deepEqual(state.entries.map((entry) => entry.kind), ["assistant", "assistant"])
  const plan = latestPlan(state)
  assert.deepEqual(plan.steps.map((step) => step.status), ["completed", "in_progress"])
})

test("live plan snapshots do not depend on tool-request arguments", () => {
  let state = createConversation()
  state = reduceEvent(state, event("tool_requested", {
    tool_call_id: "plan-1", tool_name: "update_plan", args_preview: "streamed later",
  }))
  assert.equal(latestPlan(state), undefined)
  state = reduceEvent(state, event("plan_updated", {
    tool_call_id: "plan-1", plan: [{ step: "Inspect", status: "in_progress" }],
  }))
  assert.deepEqual(latestPlan(state)?.steps, [{ step: "Inspect", status: "in_progress" }])
})

test("plan snapshots remove streamed placeholder tools", () => {
  let state = createConversation()
  state = reduceEvent(state, event("tool_input_started", { tool_call_id: "plan-1" }))
  assert.deepEqual(state.entries.map((entry) => entry.kind), ["tool"])
  state = reduceEvent(state, event("plan_updated", {
    tool_call_id: "plan-1", plan: [{ step: "Inspect", status: "in_progress" }],
  }))
  assert.deepEqual(state.entries, [])
  assert.deepEqual(latestPlan(state)?.steps, [{ step: "Inspect", status: "in_progress" }])
})

test("latest plan selects the current progress snapshot", () => {
  let state = createConversation()
  state = reduceEvent(state, event("tool_requested", {
    tool_call_id: "plan-1", tool_name: "update_plan", arguments: { plan: [{ step: "Inspect", status: "in_progress" }] },
  }))
  state = reduceEvent(state, event("tool_requested", {
    tool_call_id: "plan-2", tool_name: "update_plan", arguments: { plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }] },
  }))
  assert.deepEqual(latestPlan(state)?.steps.map((step) => step.status), ["completed", "in_progress"])
})

test("active plan hides completed and cancelled snapshots", () => {
  let state = createConversation()
  state = reduceEvent(state, event("plan_updated", {
    tool_call_id: "plan-1",
    plan: [{ step: "Inspect", status: "completed" }, { step: "Cleanup", status: "cancelled" }],
  }))
  assert.equal(activePlan(state), undefined)
})

test("active plan keeps pending, running, and error snapshots visible", () => {
  let state = createConversation()
  state = reduceEvent(state, event("turn_started"))
  state = reduceEvent(state, event("plan_updated", {
    tool_call_id: "plan-1",
    plan: [{ step: "Inspect", status: "pending" }],
  }))
  assert.equal(activePlan(state)?.steps[0].status, "pending")

  state = reduceEvent(state, event("tool_result", {
    tool_call_id: "plan-1",
    tool_name: "update_plan",
    status: "error",
    error_type: "RuntimeError",
    result: JSON.stringify({ ok: false, tool: "update_plan", error: "Unable to continue" }),
  }))
  assert.equal(activePlan(state)?.status, "error")

  state = reduceEvent(state, event("turn_started", {}, "turn-2"))
  assert.equal(activePlan(state), undefined)
})

test("replay reconstructs structured tool arguments and plans", () => {
  const state = conversationFromReplay([
    { role: "assistant", tool_calls: [{ id: "plan-1", function: { name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Ship", status: "pending" }] }) } }] },
    { role: "tool", tool_call_id: "plan-1", content: JSON.stringify({ ok: true, tool: "update_plan", data: "Plan updated" }) },
  ])
  assert.equal(latestPlan(state)?.status, "completed")
  assert.equal(activePlan(state), undefined)
})

test("file mutation previews expose bounded plus and minus source", () => {
  assert.deepEqual(fileMutationPreview("edit_file", {
    file_path: "src/app.py",
    old_str: "old\nline",
    new_str: "new\nline",
  }), {
    filePath: "src/app.py",
    removed: ["old", "line"],
    added: ["new", "line"],
  })
  assert.deepEqual(fileMutationPreview("write_file", {
    file_path: "README.md",
    content: "hello",
  }), {
    filePath: "README.md",
    removed: [],
    added: ["hello"],
  })
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
  assert.equal(parseToolResult('{"ok":false,"tool":"bash","error":"failed","error_type":"ExitCode"}').errorType, "ExitCode")
})

test("composer region keeps plan dock above a persistent input form", () => {
  const markup = composerRegionMarkup()
  assert.equal(markup.indexOf('class="composer-region"') < markup.indexOf('id="plan-dock-shell"'), true)
  assert.equal(markup.indexOf('id="plan-dock-shell"') < markup.indexOf('id="composer"'), true)
  assert.match(markup, /id="prompt" rows="2"/)
  assert.match(markup, /id="slash-command-menu" class="slash-command-menu" role="listbox"/)
  assert.match(markup, /aria-controls="slash-command-menu"/)
  assert.match(markup, /class="send-spinner"/)
})

test("plan dock keeps a manual collapse through plan updates but resets for another session", () => {
  const presentation = { collapsed: true, sessionId: "session-1", dismissedPlanErrors: new Set() }
  syncPlanDockSession(presentation, "session-1")
  assert.equal(presentation.collapsed, true)
  syncPlanDockSession(presentation, "session-2")
  assert.equal(presentation.collapsed, false)
})

test("file syntax highlighting escapes unknown files and colors known files", () => {
  const javascript = highlightFile("app.ts", "const answer = 42")
  assert.equal(javascript.language, "typescript")
  assert.match(javascript.html, /hljs-keyword/)

  const plain = highlightFile("notes.txt", "<not markup>")
  assert.equal(plain.language, "text")
  assert.equal(plain.html, "&lt;not markup&gt;")
})
