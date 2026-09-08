import assert from "node:assert/strict"
import test from "node:test"

import { renderEmptyState, starterPrompts } from "../src/renderer/empty-state.ts"

const usable = { hasProject: true, ready: true, hasApiKey: true, runtimeStatus: "ready" }

test("missing API key asks for setup with a settings action", () => {
  const html = renderEmptyState({ ...usable, hasApiKey: false, ready: false, runtimeStatus: "ready" }, "brand.svg")
  assert.match(html, /Connect a model provider/)
  assert.match(html, /data-empty-action="settings"/)
})

test("missing project asks for a folder with an add action", () => {
  const html = renderEmptyState({ ...usable, hasProject: false, ready: false }, "brand.svg")
  assert.match(html, /Add a project/)
  assert.match(html, /data-empty-action="add-project"/)
})

test("an errored runtime explains itself and offers retry", () => {
  const html = renderEmptyState({ ...usable, ready: false, runtimeStatus: "error" }, "brand.svg")
  assert.match(html, /Runtime needs attention/)
  assert.match(html, /data-empty-action="retry"/)
})

test("a stopped runtime offers a way to start it", () => {
  const html = renderEmptyState({ ...usable, ready: false, runtimeStatus: "stopped" }, "brand.svg")
  assert.match(html, /Runtime isn't running/)
  assert.match(html, /data-empty-action="retry"/)
})

test("a starting runtime explains the wait without a premature action", () => {
  const html = renderEmptyState({ ...usable, ready: false, runtimeStatus: "starting" }, "brand.svg")
  assert.match(html, /Starting…/)
  assert.doesNotMatch(html, /data-empty-action/)
})

test("the ready state lists starter prompts as clickable prompts", () => {
  const html = renderEmptyState(usable, "brand.svg")
  assert.match(html, /Start a task/)
  const prompts = [...html.matchAll(/data-empty-prompt="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(prompts, starterPrompts.map((starter) => starter.prompt))
})
