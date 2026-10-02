import assert from "node:assert/strict"
import test from "node:test"

import { createConversation, reduceEvent } from "../src/renderer/timeline-model.ts"
import { foldWorkSegments, samePath, segmentOpenMode, segmentSummary, trimmedCalls } from "../src/renderer/work-segments.ts"

function tool(id, toolName, args = {}, overrides = {}) {
  return {
    kind: "tool", id, toolCallId: `call-${id}`, toolName, argsPreview: "", arguments: args,
    status: "completed", output: "", errorType: "", durationMs: 0, ...overrides,
  }
}
const user = (id) => ({ kind: "user", id, content: "hi" })
const assistant = (id, content) => ({ kind: "assistant", id, content })
const kinds = (items) => items.map((item) => item.kind)

test("segmentSummary groups calls by kind in first-seen order", () => {
  const summary = segmentSummary([
    tool("1", "read_file", { path: "src/a.ts" }),
    tool("2", "read_file", { path: "src/b.ts" }),
    tool("3", "grep", { pattern: "x" }),
    tool("4", "glob", { glob: "*.ts" }),
    tool("5", "bash", { command: "ls" }, { durationMs: 1200 }),
    tool("6", "edit_file", { path: "src/app.ts", old_str: "a", new_str: "b\nc" }),
    tool("7", "edit_file", { path: "src/app.ts", old_str: "d", new_str: "e" }),
  ])
  assert.equal(summary.text, "Read 2 files, searched 2 patterns, ran 1 command, edited app.ts +3 -2")
  assert.equal(summary.durationMs, 1200)
  assert.equal(summary.failed, 0)
})

test("segmentSummary phrases the remaining kinds", () => {
  const phrase = (...tools) => segmentSummary(tools).text
  assert.equal(phrase(tool("1", "read_file", { path: "a/x.md" }), tool("2", "read_file", { path: "a/x.md" })), "Read x.md")
  assert.equal(phrase(tool("1", "fetch_web_page"), tool("2", "fetch_web_page")), "Read 2 pages")
  assert.equal(phrase(tool("1", "search_web")), "Searched the web")
  assert.equal(phrase(tool("1", "search_web"), tool("2", "search_web")), "Searched the web 2 times")
  assert.equal(phrase(tool("1", "task_control"), tool("2", "bash_output")), "Checked 2 tasks")
  assert.equal(phrase(tool("1", "delegate"), tool("2", "agent_create")), "Delegated 1 task, created 1 agent")
  assert.equal(phrase(tool("1", "skill_create"), tool("2", "skill"), tool("3", "skill")), "Created 1 skill, loaded 2 skills")
  assert.equal(phrase(tool("1", "update_goal")), "Updated the goal")
  assert.equal(phrase(tool("1", "mcp_lookup"), tool("2", "mcp_lookup")), "Used mcp_lookup 2 times")
  assert.equal(phrase(tool("1", "write_file", { path: "a.ts" }), tool("2", "write_file", { path: "b.ts" })), "Edited 2 files")
})

test("segmentSummary counts failures and cancellations", () => {
  const summary = segmentSummary([tool("1", "bash", {}, { status: "error" }), tool("2", "bash", {}, { status: "cancelled" }), tool("3", "bash")])
  assert.equal(summary.failed, 1)
  assert.equal(summary.cancelled, 1)
})

test("foldWorkSegments folds every call between two pieces of prose", () => {
  const items = foldWorkSegments([
    user("u1"),
    tool("1", "read_file"),
    assistant("a0", "  "),
    tool("2", "grep"),
    tool("3", "bash"),
    assistant("a1", "Done."),
    tool("4", "bash"),
  ], { activeTurn: false })
  // The blank assistant entry is not a boundary; it trails the segment.
  assert.deepEqual(kinds(items), ["user", "segment", "assistant", "assistant", "segment"])
  assert.equal(items[1].id, "segment:1")
  assert.deepEqual(items[1].tools.map((entry) => entry.id), ["1", "2", "3"])
  assert.equal(items[1].live, false)
})

test("foldWorkSegments drops hidden tools and duplicate file changes", () => {
  const items = foldWorkSegments([
    tool("1", "edit_file", { path: "/repo/src/a.ts" }),
    tool("2", "ask_user_question", {}, { status: "completed" }),
    tool("3", "bash"),
    { kind: "file", id: "f1", filePath: "src/a.ts" },
    { kind: "file", id: "f2", filePath: "src/other.ts" },
  ], { activeTurn: false })
  assert.deepEqual(kinds(items), ["segment", "file"])
  assert.equal(items[0].tools.length, 2)
  assert.equal(items[1].filePath, "src/other.ts")
  const only = foldWorkSegments([tool("1", "update_plan")], { activeTurn: false })
  assert.deepEqual(only, [])
})

test("foldWorkSegments marks live and awaiting segments", () => {
  const running = foldWorkSegments([tool("1", "read_file"), tool("2", "bash", {}, { status: "running" })], { activeTurn: false })
  assert.equal(running[0].live, true)
  const active = foldWorkSegments([tool("1", "read_file"), tool("2", "grep")], { activeTurn: true })
  assert.equal(active[0].live, true)
  const earlier = foldWorkSegments([tool("1", "read_file"), tool("2", "grep"), assistant("a", "ok")], { activeTurn: true })
  assert.equal(earlier[0].live, false)
  const asking = foldWorkSegments([
    tool("1", "read_file"), tool("2", "grep"), tool("3", "ask_user_question", {}, { status: "running" }),
  ], { activeTurn: true })
  assert.equal(asking[0].awaiting, true)
  const approval = foldWorkSegments([tool("1", "read_file"), tool("2", "bash", {}, { status: "pending" })], { activeTurn: true, awaitingToolCallId: "call-2" })
  assert.equal(approval[0].awaiting, true)
})

test("samePath matches exact paths and path suffixes on a separator", () => {
  assert.equal(samePath("/repo/src/a.ts", "src/a.ts"), true)
  assert.equal(samePath("C:\\repo\\a.ts", "a.ts"), true)
  assert.equal(samePath("/repo/xa.ts", "a.ts"), false)
  assert.equal(samePath("", "a.ts"), false)
})

test("segmentOpenMode: choice wins, then live trims, failed or awaiting open, else closed", () => {
  const segment = (tools, live = false, awaiting = false) => ({ kind: "segment", id: "s", tools, live, awaiting })
  const done = segment([tool("1", "bash"), tool("2", "bash")])
  assert.equal(segmentOpenMode(done, undefined), "closed")
  assert.equal(segmentOpenMode(done, true), "all")
  assert.equal(segmentOpenMode(segment(done.tools, true), undefined), "trimmed")
  assert.equal(segmentOpenMode(segment(done.tools, true), false), "closed")
  assert.equal(segmentOpenMode(segment([tool("1", "bash", {}, { status: "error" }), tool("2", "bash")]), undefined), "all")
  assert.equal(segmentOpenMode(segment(done.tools, false, true), undefined), "all")
})

test("trimmedCalls keeps running calls and the last two finished ones", () => {
  const tools = ["1", "2", "3", "4"].map((id) => tool(id, "bash")).concat(tool("5", "bash", {}, { status: "running" }))
  const { shown, earlier } = trimmedCalls(tools)
  assert.deepEqual(shown.map((entry) => entry.id), ["3", "4", "5"])
  assert.equal(earlier, 2)
  assert.equal(trimmedCalls(tools.slice(0, 2)).earlier, 0)
})

// ---------- timeline-model tool lifecycle ----------

function event(type, data = {}) {
  return { type, sequence: 1, durability: "incremental", sessionId: "session", turnId: "turn-1", event: data }
}
const run = (events) => events.reduce((state, envelope) => reduceEvent(state, envelope), createConversation())
const firstTool = (state) => state.entries.find((entry) => entry.kind === "tool")

test("interrupted turns mark running calls as cancelled", () => {
  const state = run([
    event("turn_started"),
    event("tool_requested", { tool_call_id: "c1", tool_name: "bash", arguments: { command: "sleep 9" } }),
    event("tool_call_started", { tool_call_id: "c1" }),
    event("tool_progress", { tool_call_id: "c1", payload: { message: "waiting" } }),
    event("turn_cancelled", { reason: "Stopped" }),
  ])
  assert.equal(firstTool(state).status, "cancelled")
  assert.equal(firstTool(state).progress, undefined)
  const result = run([
    event("tool_requested", { tool_call_id: "c1", tool_name: "bash", arguments: {} }),
    event("tool_result", { tool_call_id: "c1", status: "error", error_type: "Cancelled", result: "" }),
  ])
  assert.equal(firstTool(result).status, "cancelled")
})

test("tool_progress replaces the progress line and appends streamed output", () => {
  const state = run([
    event("tool_requested", { tool_call_id: "c1", tool_name: "bash", arguments: { command: "make" } }),
    event("tool_call_started", { tool_call_id: "c1" }),
    event("tool_progress", { tool_call_id: "c1", payload: { output: "step 1\n" } }),
    event("tool_progress", { tool_call_id: "c1", payload: { output: "step 2" } }),
  ])
  const entry = firstTool(state)
  assert.equal(entry.progress, "step 2")
  assert.equal(entry.output, "step 1\nstep 2\n")
})

test("tool_input_delta fills arguments before tool_requested arrives", () => {
  const state = run([
    event("tool_input_started", { tool_call_id: "c1", tool_name: "read_file" }),
    event("tool_input_delta", { tool_call_id: "c1", delta: '{"path":"src/ma' }),
    event("tool_input_delta", { tool_call_id: "c1", delta: 'in.ts"' }),
  ])
  assert.equal(firstTool(state).arguments.path, "src/main.ts")
  const requested = run([
    event("tool_input_started", { tool_call_id: "c1", tool_name: "read_file" }),
    event("tool_input_delta", { tool_call_id: "c1", delta: '{"path":"a.ts"}' }),
    event("tool_requested", { tool_call_id: "c1", tool_name: "read_file" }),
  ])
  assert.equal(firstTool(requested).arguments.path, "a.ts")
  assert.equal(firstTool(requested).inputText, undefined)
})
