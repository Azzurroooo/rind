import assert from "node:assert/strict"
import test from "node:test"

import {
  createTaskMonitorState,
  mergeTasks,
  normalizeTask,
  refreshTasks,
  renderTaskMonitor,
  runningTaskCount,
  taskStatusClass,
  readTaskOutput,
} from "../src/renderer/task-monitor.ts"

test("mergeTasks keeps only yielded tasks that are still running", () => {
  const current = [
    { bg_id: "bg-1", status: "running", handoff: true },
    { bg_id: "bg-gone", status: "running", handoff: true },
  ]
  const listed = [
    { bg_id: "bg-1", status: "running", handoff: true, stdout: "tick" },
    { bg_id: "bg-2", status: "running", handoff: false },
    { bg_id: "bg-3", status: "completed", handoff: true, exit_code: 0 },
    { bg_id: "bg-4", status: "running", handoff: true, command: "npm test" },
  ]
  const merged = mergeTasks(current, listed)
  assert.deepEqual(merged.map((task) => task.bg_id), ["bg-1", "bg-4"])
  assert.equal(merged[0].stdout, "tick")
  assert.equal(runningTaskCount(merged), 2)
})

test("mergeTasks keeps the fuller command across polls", () => {
  const current = [{ bg_id: "bg-1", status: "running", handoff: true, command: "npm run dev --watch" }]
  const merged = mergeTasks(current, [{ task_id: "bg-1", status: "running", handoff: true, command: "npm run d…" }])
  assert.equal(merged[0].command, "npm run dev --watch")
})

test("mergeTasks ignores malformed rows", () => {
  assert.deepEqual(mergeTasks([], [{}, null, { status: "running", handoff: true }, "junk"]), [])
})

test("normalizeTask coerces kernel task records", () => {
  const task = normalizeTask({ bg_id: " bg-3 ", status: "running", exit_code: -1, stdout: "out", truncated: true })
  assert.equal(task.bg_id, "bg-3")
  assert.equal(task.status, "running")
  assert.equal(task.exit_code, -1)
  assert.equal(task.truncated, true)
  assert.equal(normalizeTask(null).bg_id, "")
  assert.equal(normalizeTask({}).status, "unknown")
})

test("task status styling maps to pip classes", () => {
  assert.equal(taskStatusClass({ bg_id: "a", status: "running" }), "pip-running")
  assert.equal(taskStatusClass({ bg_id: "a", status: "cancelling" }), "pip-paused")
  assert.equal(runningTaskCount(createTaskMonitorState().tasks), 0)
})

test("refreshTasks loads one page and drops the expanded row when it finishes", async () => {
  const state = createTaskMonitorState()
  state.expandedId = "bg-done"
  await refreshTasks(state, async () => ({ tasks: [
    { task_id: "bg-run", status: "running", handoff: true, command: "npm test" },
    { task_id: "bg-done", status: "completed", handoff: true },
  ] }))
  assert.deepEqual(state.tasks.map((task) => task.bg_id), ["bg-run"])
  assert.equal(state.expandedId, "")
  assert.equal(state.error, "")
  await refreshTasks(state, async () => { throw new Error("offline") })
  assert.equal(state.error, "offline")
})

test("renderTaskMonitor shows commands and the running count", () => {
  const state = createTaskMonitorState()
  state.tasks = [{ bg_id: "bg-1", status: "running", handoff: true, command: "npm test", elapsed_ms: 4200 }]
  state.expandedId = "bg-1"
  const dock = { innerHTML: "" }
  renderTaskMonitor(dock, state)
  assert.match(dock.innerHTML, /npm test/)
  assert.match(dock.innerHTML, /1 running/)
  assert.match(dock.innerHTML, /4s/)
  assert.match(dock.innerHTML, /Stop task/)
  state.tasks = []
  state.expandedId = ""
  renderTaskMonitor(dock, state)
  assert.match(dock.innerHTML, /No background commands are running/)
})

test("task polling reads the remembered output cursor", async () => {
  const state = createTaskMonitorState()
  const seen = []
  const read = async (id, cursor) => {
    seen.push(cursor)
    return { task_id: id, stdout: cursor ? "second page" : "first page", meta: { truncated: true }, next_cursor: "next" }
  }
  await readTaskOutput(state, read, "a", "page2")
  await readTaskOutput(state, read, "a")
  assert.deepEqual(seen, ["page2", "page2"])
  assert.equal(state.outputs.a.stdout, "second page")
  assert.equal(state.outputs.a.truncated, true)
  assert.equal(state.outputs.a.next_cursor, "next")
})

test("late output cannot overwrite a newer output page", async () => {
  const state = createTaskMonitorState()
  let resolveFirst
  const first = readTaskOutput(state, () => new Promise((resolve) => { resolveFirst = resolve }), "a")
  await readTaskOutput(state, async () => ({ task_id: "a", stdout: "new" }), "a", "next")
  resolveFirst({ task_id: "a", stdout: "old" })
  await first
  assert.equal(state.outputs.a.stdout, "new")
  assert.equal(state.cursors.a, "next")
  assert.equal(state.reading.size, 0)
})
