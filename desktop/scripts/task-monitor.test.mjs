import assert from "node:assert/strict"
import test from "node:test"

import {
  createTaskMonitorState,
  mergeTasks,
  normalizeTask,
  runningTaskCount,
  taskStatusClass,
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
