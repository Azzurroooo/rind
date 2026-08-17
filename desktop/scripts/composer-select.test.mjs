import assert from "node:assert/strict"
import test from "node:test"

import { modelChoices, modelSelectionTarget } from "../src/renderer/composer-select.ts"

test("model choices keep the current model visible and remove duplicates", () => {
  assert.deepEqual(
    modelChoices(["gpt-5", "gpt-5-mini", "gpt-5"], "gpt-5-mini"),
    ["gpt-5-mini", "gpt-5"],
  )
})

test("model choices ignore empty values returned by the provider", () => {
  assert.deepEqual(modelChoices(["", "  ", "gpt-5"], "  "), ["gpt-5"])
})

test("model selection updates the ready session or the saved default as appropriate", () => {
  assert.equal(modelSelectionTarget("ready", false), "runtime")
  assert.equal(modelSelectionTarget("stopped", false), "settings")
  assert.equal(modelSelectionTarget("error", false), "settings")
  assert.equal(modelSelectionTarget("starting", false), "unavailable")
  assert.equal(modelSelectionTarget("ready", true), "unavailable")
})
