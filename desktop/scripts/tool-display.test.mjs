import assert from "node:assert/strict"
import test from "node:test"

import { editCounts, projectRelativePath, toolError, toolView } from "../src/renderer/tool-display.ts"
import { appendInput, partialArguments } from "../src/renderer/tool-input.ts"

function result(data, meta = {}, ok = true, extra = {}) {
  return { raw: JSON.stringify({ ok, data, meta }), ok, toolName: "", data, meta, error: "", errorType: "", ...extra }
}

function tool(toolName, args = {}, overrides = {}) {
  return {
    kind: "tool", id: "t1", toolCallId: "c1", toolName, argsPreview: "", arguments: args,
    status: "completed", output: "", errorType: "", durationMs: 0, ...overrides,
  }
}

const metaText = (view) => view.meta.map((part) => part.text)

test("read_file shows the path, the line range and no file contents", () => {
  const view = toolView(tool("read_file", { path: "src/app.ts", offset: 10, limit: 20 }, { result: result("secret body") }))
  assert.equal(view.verb, "Read")
  assert.equal(view.target, "src/app.ts")
  assert.equal(view.path, true)
  assert.deepEqual(metaText(view), ["lines 10-29"])
  assert.equal(view.body, undefined)
  assert.equal(view.opensFile, "src/app.ts")
  const shown = toolView(tool("read_file", { path: "a.ts" }, { result: result("Showing lines 4 to 4 of 9") }))
  assert.deepEqual(metaText(shown), ["line 4"])
})

test("write_file counts added lines and previews the code", () => {
  const view = toolView(tool("write_file", { path: "b.ts", content: "one\ntwo\nthree\n" }, { result: result(null) }))
  assert.equal(view.verb, "Wrote")
  assert.deepEqual(view.meta, [{ text: "+3", tone: "success" }])
  assert.equal(view.body.type, "code")
  assert.equal(view.body.preview, 20)
})

test("edit_file shows +A -R and a diff body", () => {
  const edit = tool("edit_file", { path: "c.ts", old_str: "a\nb", new_str: "c" }, { result: result(null) })
  const view = toolView(edit)
  assert.deepEqual(metaText(view), ["+1", "-2"])
  assert.equal(view.body.type, "diff")
  assert.deepEqual(editCounts(edit), { added: 1, removed: 2 })
  const fromMeta = tool("edit_file", { path: "c.ts" }, { result: result(null, { files: [{ path: "c.ts", added_lines: 7, removed_lines: 3 }] }) })
  assert.deepEqual(editCounts(fromMeta), { added: 7, removed: 3 })
})

test("grep reports matches per file, or No matches", () => {
  const matches = [{ file: "a.ts", line: 1 }, { file: "a.ts", line: 4 }, { file: "b.ts", line: 2 }]
  const view = toolView(tool("grep", { pattern: "TODO" }, { result: result(matches) }))
  assert.equal(view.target, "TODO")
  assert.deepEqual(metaText(view), ["3 matches in 2 files"])
  assert.deepEqual(view.body.items, [{ label: "a.ts", detail: "2" }, { label: "b.ts", detail: "1" }])
  const none = toolView(tool("grep", { pattern: "x" }, { result: result([]) }))
  assert.deepEqual(metaText(none), ["No matches"])
  assert.equal(none.body, undefined)
  const running = toolView(tool("grep", { pattern: "x" }, { status: "running" }))
  assert.deepEqual(running.meta, [])
})

test("glob lists paths and marks a truncated result", () => {
  const view = toolView(tool("glob", { glob: "**/*.ts" }, { result: result([{ path: "a.ts" }, { path: "b.ts" }], { truncated: true }) }))
  assert.equal(view.verb, "Found")
  assert.deepEqual(metaText(view), ["2 files+"])
  assert.equal(view.body.type, "list")
})

test("bash shows the first command line, a failing exit and the duration", () => {
  const data = { command: "npm test", stdout: "a\nb\n", stderr: "boom", exit_code: 1 }
  const view = toolView(tool("bash", { command: "npm test\necho done" }, { result: result(data), durationMs: 2500 }))
  assert.equal(view.target, "npm test")
  assert.deepEqual(view.meta, [{ text: "exit 1", tone: "danger" }, { text: "2.5s" }])
  assert.deepEqual(view.body.lines, ["a", "b", "boom"])
  assert.equal(view.body.preview, 5)
  const clean = toolView(tool("bash", { command: "true" }, { result: result({ exit_code: 0 }) }))
  assert.deepEqual(clean.meta, [])
  assert.equal(clean.body, undefined)
})

test("running rows show the latest progress line instead of meta", () => {
  const view = toolView(tool("bash", { command: "make" }, { status: "running", progress: "compiling 3/9", output: "x\n" }))
  assert.deepEqual(metaText(view), ["compiling 3/9"])
  assert.deepEqual(view.body.lines, ["x"])
})

test("task_control list shows each task with its status", () => {
  const data = { tasks: [{ task_id: "t-1", command: "npm run dev", status: "running" }, { task_id: "t-2", status: "exited" }] }
  const view = toolView(tool("task_control", { action: "list" }, { result: result(data) }))
  assert.equal(view.verb, "Listed tasks")
  assert.deepEqual(metaText(view), ["2 tasks"])
  assert.deepEqual(view.body.items, [{ label: "npm run dev", detail: "running" }, { label: "t-2", detail: "exited" }])
  const stop = toolView(tool("bash_output", { bg_id: "t-3", kill: true }, { result: result({ status: "cancelled" }) }))
  assert.equal(stop.verb, "Stopped")
  assert.equal(stop.target, "t-3")
})

test("search_web lists titles with domains", () => {
  const data = [{ title: "Docs", url: "https://www.example.com/a" }, { url: "https://b.dev/x" }]
  const view = toolView(tool("search_web", { query: "electron ipc" }, { result: result(data) }))
  assert.equal(view.target, "electron ipc")
  assert.deepEqual(metaText(view), ["2 results"])
  assert.deepEqual(view.body.items, [{ label: "Docs", detail: "example.com" }, { label: "https://b.dev/x", detail: "b.dev" }])
  assert.deepEqual(metaText(toolView(tool("search_web", { query: "q" }, { result: result([]) }))), ["No results"])
})

test("fetch_web_page shows domain/path, the title and a lead paragraph only", () => {
  const page = "# Release notes\n\n- item\n\nFirst real paragraph.\n\nSecond paragraph."
  const view = toolView(tool("fetch_web_page", { url: "https://www.example.com/notes" }, { result: result(page) }))
  assert.equal(view.target, "example.com/notes")
  assert.deepEqual(metaText(view), ["Release notes"])
  assert.equal(view.body.type, "markdown")
  assert.equal(view.body.text, "**Release notes**\n\nFirst real paragraph.")
})

test("delegate shows agent and task, status, duration and the summary", () => {
  const view = toolView(tool("delegate", { agent_id: "reviewer", task: "Review the diff" }, { result: result({ status: "completed", summary: "Looks good." }), durationMs: 800 }))
  assert.equal(view.target, "reviewer: Review the diff")
  assert.deepEqual(metaText(view), ["completed", "800ms"])
  assert.equal(view.body.text, "Looks good.")
})

test("agent_create and skill_create describe what was created", () => {
  const agent = toolView(tool("agent_create", { agent_id: "qa", description: "Runs checks" }, { result: result({}) }))
  assert.equal(agent.verb, "Created agent")
  assert.equal(agent.target, "qa")
  assert.equal(agent.body.text, "**qa**\n\nRuns checks")
  const skill = toolView(tool("skill_create", { name: "deploy", description: "Ship it" }, { result: result({ overwritten: true }) }))
  assert.deepEqual(metaText(skill), ["replaced"])
  const bare = toolView(tool("agent_create", { agent_id: "x" }, { result: result({}) }))
  assert.equal(bare.body, undefined)
})

test("skill and update_goal stay compact", () => {
  const skill = toolView(tool("skill", { name: "lint" }, { result: result({ name: "lint", content: "long body" }) }))
  assert.equal(skill.verb, "Loaded skill")
  assert.equal(skill.target, "lint")
  assert.equal(skill.body, undefined)
  const goal = toolView(tool("update_goal", { status: "blocked" }, { result: result({ objective: "Ship v2" }) }))
  assert.deepEqual(goal.meta, [{ text: "blocked", tone: "danger" }])
  assert.equal(goal.body.text, "Ship v2")
})

test("unknown tools show fields, never private arguments, with raw behind a toggle", () => {
  const view = toolView(tool("custom_thing", { query: "x", depth: 2, _secret: "hidden" }, { result: result("line one\nline two"), output: "{raw}" }))
  assert.equal(view.verb, "custom_thing")
  assert.equal(view.body.type, "fields")
  assert.deepEqual(view.body.fields, [{ key: "query", value: "x" }, { key: "depth", value: "2" }])
  assert.deepEqual(view.body.result, ["line one", "line two"])
  assert.equal(view.body.raw, "{raw}")
  assert.equal(toolView(tool("custom_thing")).body, undefined)
})

test("ask_user_question and update_plan are hidden", () => {
  assert.equal(toolView(tool("ask_user_question", { question: "?" })).hidden, true)
  assert.equal(toolView(tool("update_plan", { plan: [] })).hidden, true)
})

test("toolError keeps six lines in the message and moves the rest to details", () => {
  const error = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n")
  const failed = tool("bash", {}, { status: "error", errorType: "Timeout", result: result(null, {}, false, { error }) })
  const view = toolView(failed)
  assert.equal(view.error.message.split("\n").length, 6)
  assert.equal(view.error.details, "line 7\nline 8\nType: Timeout")
  assert.deepEqual(toolError(tool("bash", {}, { status: "error" })), { message: "The tool failed.", details: "" })
  assert.equal(toolView(tool("bash")).error, undefined)
})

test("partialArguments reads finished and unfinished argument JSON", () => {
  assert.deepEqual(partialArguments('{"path":"a.ts","limit":5}'), { path: "a.ts", limit: 5 })
  assert.deepEqual(partialArguments('{"path":"src/ma'), { path: "src/ma" })
  assert.deepEqual(partialArguments('{"command":"echo \\"hi\\" \\'), { command: 'echo "hi" ' })
  assert.deepEqual(partialArguments(""), {})
  assert.deepEqual(partialArguments("[1,2]"), {})
})

test("appendInput keeps the buffer bounded", () => {
  assert.equal(appendInput("ab", "cd"), "abcd")
  assert.equal(appendInput("abc", "def", 4), "abcd")
})

test("projectRelativePath keeps paths inside the project only", () => {
  assert.equal(projectRelativePath("/repo/src/a.ts", "/repo"), "src/a.ts")
  assert.equal(projectRelativePath("./src/a.ts", "/repo"), "src/a.ts")
  assert.equal(projectRelativePath("C:\\Repo\\src\\a.ts", "c:/repo/"), "src/a.ts")
  assert.equal(projectRelativePath("/other/a.ts", "/repo"), undefined)
  assert.equal(projectRelativePath("/repository/a.ts", "/repo"), undefined)
  assert.equal(projectRelativePath("../a.ts", "/repo"), undefined)
  assert.equal(projectRelativePath("", "/repo"), undefined)
})
