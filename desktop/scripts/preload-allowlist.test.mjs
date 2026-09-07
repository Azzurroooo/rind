import assert from "node:assert/strict"
import test from "node:test"

import { runtimeMethods, sessionScopedMethods } from "../src/preload/types.ts"

// Mirrors the main-process allowlist construction (src/main/index.ts).
const allowedRuntimeMethods = new Set(Object.values(runtimeMethods))

function isRuntimeMethod(method) {
  return allowedRuntimeMethods.has(method)
}

test("unblocked desktop methods pass the runtime allowlist", () => {
  const required = [
    "model/effort",
    "session/delete",
    "file/write",
    "file/list",
    "file/read",
    "rind/session/promote_follow_up",
    "rind/session/unsteer",
    "rind/session/dequeue_follow_up",
    "rind/goal/get",
    "rind/goal/set",
    "rind/goal/status",
    "rind/goal/clear",
    "rind/background/list",
    "rind/background/output",
  ]
  for (const method of required) {
    assert.equal(isRuntimeMethod(method), true, `${method} must pass isRuntimeMethod`)
  }
})

test("unknown methods are still rejected", () => {
  assert.equal(isRuntimeMethod("nope"), false)
  assert.equal(isRuntimeMethod("session/switch"), false)
  assert.equal(isRuntimeMethod("session/subscribe"), false)
  assert.equal(isRuntimeMethod(""), false)
  assert.equal(isRuntimeMethod("initialize"), false, "lifecycle methods are not runtime methods")
})

test("session-scoped new methods receive session_id automatically", () => {
  for (const method of [
    runtimeMethods.sessionDelete,
    runtimeMethods.modelEffort,
    runtimeMethods.backgroundList,
    runtimeMethods.backgroundOutput,
    runtimeMethods.goalGet,
    runtimeMethods.goalSet,
    runtimeMethods.goalStatus,
    runtimeMethods.goalClear,
  ]) {
    assert.equal(sessionScopedMethods.has(method), true, `${method} must be session-scoped`)
  }
  // file/* methods are workspace-scoped, not session-scoped.
  for (const method of [runtimeMethods.fileList, runtimeMethods.fileRead, runtimeMethods.fileWrite]) {
    assert.equal(sessionScopedMethods.has(method), false, `${method} must not be session-scoped`)
  }
})
