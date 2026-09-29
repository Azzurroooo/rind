import assert from "node:assert/strict"
import test from "node:test"

import {
  createTaskMonitorState,
  mergeTasks,
  normalizeTask,
  runningTaskCount,
  taskStatusClass,
  refreshTaskPages,
  readTaskOutput,
} from "../src/renderer/task-monitor.ts"

test("mergeTasks adds listed tasks and drops vanished running tasks", () => {
  const current = [
    { bg_id: "bg-1", status: "running" },
    { bg_id: "bg-gone", status: "running" },
  ]
  const listed = [
    { bg_id: "bg-1", status: "running", stdout: "tick" },
    { bg_id: "bg-2", status: "completed", exit_code: 0 },
  ]
  const merged = mergeTasks(current, listed)
  assert.deepEqual(merged.map((task) => task.bg_id), ["bg-1", "bg-2"])
  assert.equal(merged[0].stdout, "tick")
  assert.equal(runningTaskCount(merged), 1)
})

test("mergeTasks keeps settled tasks that left the listing", () => {
  const current = [{ bg_id: "bg-9", status: "completed", exit_code: 3 }]
  const merged = mergeTasks(current, [])
  assert.deepEqual(merged.map((task) => task.bg_id), ["bg-9"])
})

test("mergeTasks ignores malformed rows", () => {
  assert.deepEqual(mergeTasks([], [{}, null, { status: "running" }, "junk"]), [])
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
  assert.equal(taskStatusClass({ bg_id: "a", status: "error" }), "pip-error")
  assert.equal(taskStatusClass({ bg_id: "a", status: "completed" }), "pip-done")
  assert.equal(runningTaskCount(createTaskMonitorState().tasks), 0)
})

test("task polling preserves loaded pages and output cursor", async () => {
  const state = createTaskMonitorState()
  const list = async (token) => token ? { tasks: [{ task_id: "b", status: "running" }] }
    : { tasks: [{ task_id: "a", status: "running" }], next_page_token: "page2" }
  await refreshTaskPages(state, list)
  await refreshTaskPages(state, list, true)
  await refreshTaskPages(state, list)
  assert.deepEqual(state.tasks.map((task) => task.bg_id), ["a", "b"])
  assert.equal(state.pagesLoaded, 2)
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
