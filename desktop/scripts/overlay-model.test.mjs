import assert from "node:assert/strict"
import test from "node:test"

import { dropToast, pushToast, TOAST_LIMIT, tooltipPosition } from "../src/renderer/overlay-model.ts"

const toast = (id, message = `m${id}`, tone = "info") => ({ id, message, tone })

test("pushToast keeps at most three and drops the oldest", () => {
  const list = [1, 2, 3, 4].reduce((acc, id) => pushToast(acc, toast(id)), [])
  assert.equal(TOAST_LIMIT, 3)
  assert.deepEqual(list.map((item) => item.id), [2, 3, 4])
})

test("pushToast collapses a repeated message and never mutates", () => {
  const before = [toast(1, "Saved"), toast(2, "Other")]
  const snapshot = structuredClone(before)
  const after = pushToast(before, toast(3, "Saved"))
  assert.deepEqual(before, snapshot)
  assert.deepEqual(after.map((item) => item.id), [2, 3])
  assert.deepEqual(dropToast(after, 2).map((item) => item.id), [3])
})

test("tooltipPosition prefers below, flips above and clamps to the viewport", () => {
  const viewport = { width: 800, height: 600 }
  const tip = { width: 100, height: 24 }
  assert.deepEqual(tooltipPosition({ top: 10, left: 350, width: 28, height: 28 }, tip, viewport), { top: 44, left: 314, placement: "below" })
  assert.equal(tooltipPosition({ top: 570, left: 350, width: 28, height: 28 }, tip, viewport).placement, "above")
  assert.equal(tooltipPosition({ top: 10, left: 780, width: 28, height: 28 }, tip, viewport).left, 692)
  assert.equal(tooltipPosition({ top: 10, left: 0, width: 28, height: 28 }, tip, viewport).left, 8)
})
