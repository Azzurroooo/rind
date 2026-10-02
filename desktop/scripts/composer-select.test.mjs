import assert from "node:assert/strict"
import test from "node:test"

import {
  findModelOption,
  formatContextWindow,
  groupModelOptions,
  modelChoices,
  modelSelectionTarget,
  normalizeModelList,
  providerDisplayName,
  stringModelOptions,
} from "../src/renderer/composer-select.ts"

test("normalizeModelList parses provider-aware entries and the current selection", () => {
  const listing = normalizeModelList({
    models: [
      { provider_id: "anthropic", id: "claude-sonnet-4", context_window: 200000, image_input: true },
      { provider_id: "openai", id: "gpt-5" },
      { provider_id: "openai", id: "gpt-5" },
      "legacy",
      { provider_id: "", id: "" },
    ],
    current: { provider_id: "anthropic", model_id: "claude-sonnet-4" },
  })
  assert.deepEqual(listing.models, [
    { id: "claude-sonnet-4", providerId: "anthropic", contextWindow: 200000, imageInput: true },
    { id: "gpt-5", providerId: "openai" },
    { id: "legacy", providerId: "" },
  ])
  assert.deepEqual(
    { currentProviderId: listing.currentProviderId, currentModelId: listing.currentModelId },
    { currentProviderId: "anthropic", currentModelId: "claude-sonnet-4" },
  )
  assert.deepEqual(normalizeModelList(null).models, [])
  assert.deepEqual(normalizeModelList({ models: "junk" }).models, [])
})

test("stringModelOptions flattens the settings catalog and drops blanks", () => {
  assert.deepEqual(stringModelOptions(["gpt-5", " gpt-5 ", "", "  ", "gpt-5-mini"]), [
    { id: "gpt-5", providerId: "" },
    { id: "gpt-5-mini", providerId: "" },
  ])
})

test("model choices keep the current model visible and remove duplicates", () => {
  const options = stringModelOptions(["gpt-5", "gpt-5-mini", "gpt-5"])
  assert.deepEqual(
    modelChoices(options, "gpt-5-mini").map((option) => option.id),
    ["gpt-5-mini", "gpt-5"],
  )
})

test("model choices prefer the option that matches the current provider", () => {
  const options = [
    { id: "shared", providerId: "openai" },
    { id: "shared", providerId: "anthropic" },
  ]
  assert.equal(modelChoices(options, "shared", "anthropic")[0].providerId, "anthropic")
})

test("groupModelOptions groups in first-seen order with known names", () => {
  const groups = groupModelOptions([
    { id: "a1", providerId: "anthropic" },
    { id: "o1", providerId: "openai" },
    { id: "a2", providerId: "anthropic" },
    { id: "flat", providerId: "" },
  ], { anthropic: "Anthropic" })
  assert.deepEqual(groups.map((group) => group.name), ["Anthropic", "Openai", "Provider"])
  assert.deepEqual(groups[0].models.map((option) => option.id), ["a1", "a2"])
})

test("providerDisplayName title-cases dashed ids", () => {
  assert.equal(providerDisplayName("deepseek"), "Deepseek")
  assert.equal(providerDisplayName("zai-coding"), "Zai Coding")
  assert.equal(providerDisplayName(""), "Provider")
})

test("formatContextWindow formats thousands and millions", () => {
  assert.equal(formatContextWindow(128000), "128K ctx")
  assert.equal(formatContextWindow(1500000), "1.5M ctx")
  assert.equal(formatContextWindow(undefined), "")
  assert.equal(formatContextWindow(0), "")
})

test("findModelOption matches exactly first, then by substring", () => {
  const options = [
    { id: "claude-sonnet-4", providerId: "anthropic" },
    { id: "gpt-5", providerId: "openai" },
  ]
  assert.equal(findModelOption(options, "gpt-5")?.providerId, "openai")
  assert.equal(findModelOption(options, "sonnet")?.id, "claude-sonnet-4")
  assert.equal(findModelOption(options, "nope"), undefined)
  assert.equal(findModelOption(options, ""), undefined)
})

test("model selection updates the ready session or the saved default as appropriate", () => {
  assert.equal(modelSelectionTarget("ready", false), "runtime")
  assert.equal(modelSelectionTarget("stopped", false), "settings")
  assert.equal(modelSelectionTarget("error", false), "settings")
  assert.equal(modelSelectionTarget("starting", false), "unavailable")
  assert.equal(modelSelectionTarget("ready", true), "unavailable")
})
