import assert from "node:assert/strict"
import test from "node:test"

import { isDesktopRuntimeMethod as isRuntimeMethod, isRemoteRuntimeMethod } from "../src/main/method-policy.ts"
import { runtimeMethods, sessionScopedMethods } from "../src/preload/types.ts"

test("unblocked desktop methods pass the runtime allowlist", () => {
  const required = [
    "model/effort",
    "session/delete",
    "session/create",
    "session/open",
    "rind/session/deliver",
    "rind/folder_defaults/get",
    "rind/folder_defaults/set",
    "rind/folder_defaults/unset",
    "rind/folder_defaults/apply",
    "rind/folder_defaults/resolve",
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
  // session/open is local-only because external_tools must be configured on the trusted host.
  assert.equal(isRemoteRuntimeMethod("session/open"), false)
  assert.equal(isRemoteRuntimeMethod("session/create"), true)
  assert.equal(isRemoteRuntimeMethod("rind/folder_defaults/get"), true)
})

test("unknown methods are still rejected", () => {
  assert.equal(isRuntimeMethod("nope"), false)
  assert.equal(isRuntimeMethod("session/switch"), true)
  assert.equal(isRuntimeMethod("session/subscribe"), true)
  assert.equal(isRuntimeMethod(""), false)
  assert.equal(isRuntimeMethod("initialize"), false, "lifecycle methods are not runtime methods")
})

test("session-scoped new methods receive session_id automatically", () => {
  for (const method of [
    runtimeMethods.sessionDelete,
    runtimeMethods.sessionDeliver,
    runtimeMethods.folderDefaultsApply,
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
  // file/* and folder_defaults/{get,set,unset,resolve} methods are workspace-scoped, not session-scoped.
  for (const method of [
    runtimeMethods.fileList,
    runtimeMethods.fileRead,
    runtimeMethods.fileWrite,
    runtimeMethods.folderDefaultsGet,
    runtimeMethods.folderDefaultsSet,
    runtimeMethods.folderDefaultsUnset,
    runtimeMethods.folderDefaultsResolve,
  ]) {
    assert.equal(sessionScopedMethods.has(method), false, `${method} must not be session-scoped`)
  }
})
