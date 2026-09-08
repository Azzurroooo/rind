import assert from "node:assert/strict"
import test from "node:test"

import { decideTurnEvent, isTurnNotActive } from "../src/renderer/turn-state.ts"

// User-seat regression matrix for desktop turn-state reconciliation.
// Each case maps to a real timing race observed from the user's seat.

test("settled event with a mismatched turn_id still settles the session", () => {
  // The renderer remembered turn T1 but missed its terminal; the worker has
  // since run and finished T2. The stale memory used to wedge the composer in
  // follow-up mode forever (every send failed with TurnNotActive).
  const decision = decideTurnEvent("turn_completed", "turn-t2", "turn-t1")
  assert.equal(decision.apply, true)
  assert.equal(decision.settle, true)
  assert.equal(decision.retired, false)
})

test("a new turn_started supersedes the remembered generation", () => {
  // Goal continuation / post-restart turns start a fresh turn_id while the
  // renderer still remembers the previous one — the new generation must win.
  const decision = decideTurnEvent("turn_started", "turn-t2", "turn-t1")
  assert.equal(decision.adopt, true)
  assert.equal(decision.retired, false)
})

test("late deltas from a retired generation archive without mutating state", () => {
  const decision = decideTurnEvent("assistant_delta", "turn-t1", "turn-t2")
  assert.equal(decision.apply, true)
  assert.equal(decision.settle, false)
  assert.equal(decision.adopt, false)
  assert.equal(decision.retired, true)
})

test("events for the active turn are the normal path", () => {
  const decision = decideTurnEvent("tool_requested", "turn-t1", "turn-t1")
  assert.deepEqual(decision, { apply: true, adopt: false, settle: false, retired: false })
})

test("events for an unknown turn (late replay) archive without adopting", () => {
  const decision = decideTurnEvent("tool_result", "turn-t9", "")
  assert.equal(decision.apply, true)
  assert.equal(decision.adopt, false)
  assert.equal(decision.settle, false)
})

test("all three terminal types settle", () => {
  for (const type of ["turn_completed", "turn_failed", "turn_cancelled"]) {
    assert.equal(decideTurnEvent(type, "t", "t").settle, true, type)
  }
})

test("isTurnNotActive keys on the worker error type", () => {
  const notActive = new Error("The requested turn is no longer active.")
  notActive.name = "TurnNotActive"
  assert.equal(isTurnNotActive(notActive), true)

  const other = new Error("Session execution is not active.")
  other.name = "SessionNotFound"
  assert.equal(isTurnNotActive(other), false)
  assert.equal(isTurnNotActive("TurnNotActive"), false)
})
