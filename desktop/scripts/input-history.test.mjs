import assert from "node:assert/strict"
import test from "node:test"

import { createInputHistory } from "../src/renderer/input-history.ts"

test("older walks from the newest entry backwards", () => {
  const history = createInputHistory()
  history.record("first")
  history.record("second")
  assert.equal(history.older(""), "second")
  assert.equal(history.older("second"), "first")
  assert.equal(history.older("first"), "first")
})

test("newer returns to the parked draft at the end", () => {
  const history = createInputHistory()
  history.record("first")
  history.record("second")
  assert.equal(history.newer(), undefined)
  history.older("live draft")
  assert.equal(history.older("live draft"), "first")
  assert.equal(history.newer(), "second")
  assert.equal(history.newer(), "live draft")
  assert.equal(history.newer(), undefined)
})

test("consecutive duplicates are recorded once", () => {
  const history = createInputHistory()
  history.record("same")
  history.record("same")
  assert.equal(history.older(""), "same")
  assert.equal(history.older("same"), "same")
})

test("empty values are ignored and the cursor resets after sending", () => {
  const history = createInputHistory()
  history.record("  ")
  assert.equal(history.older(""), undefined)
  history.record("first")
  history.older("")
  history.record("second")
  assert.equal(history.older(""), "second")
  assert.equal(history.older("second"), "first")
})

test("history is capped at the limit, oldest dropped", () => {
  const history = createInputHistory(3)
  for (const value of ["a", "b", "c", "d"]) history.record(value)
  assert.equal(history.older(""), "d")
  assert.equal(history.older("d"), "c")
  assert.equal(history.older("c"), "b")
  assert.equal(history.older("b"), "b")
})
