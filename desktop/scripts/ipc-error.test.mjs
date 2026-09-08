import assert from "node:assert/strict"
import test from "node:test"

import { unwrapRuntimeIpcResult, wrapRuntimeIpcError } from "../src/shared/ipc-error.ts"

test("wrapped worker errors unwrap back into Error with name and message", () => {
  const original = new Error("The requested turn is no longer active.")
  original.name = "TurnNotActive"

  let caught = null
  try {
    unwrapRuntimeIpcResult(wrapRuntimeIpcError(original))
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error)
  assert.equal(caught.name, "TurnNotActive")
  assert.equal(caught.message, "The requested turn is no longer active.")
})

test("worker errors round-trip their own name faithfully", () => {
  let caught = null
  try {
    unwrapRuntimeIpcResult(wrapRuntimeIpcError(new Error("boom")))
  } catch (error) {
    caught = error
  }
  assert.equal(caught.name, "Error")
  assert.equal(caught.message, "boom")
})

test("non-Error values wrap without throwing", () => {
  let caught = null
  try {
    unwrapRuntimeIpcResult(wrapRuntimeIpcError("weird failure"))
  } catch (error) {
    caught = error
  }
  assert.equal(caught.name, "RuntimeError")
  assert.equal(caught.message, "weird failure")
})

test("plain results pass through untouched", () => {
  const result = { ok: true, session_id: "s1" }
  assert.equal(unwrapRuntimeIpcResult(result), result)
})
