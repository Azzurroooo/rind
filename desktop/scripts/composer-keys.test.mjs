import assert from "node:assert/strict"
import test from "node:test"

import { composerKeyAction } from "../src/renderer/composer-keys.ts"
import { contextDisplayFrom, contextReportText, renderContextDisplay } from "../src/renderer/context-report.ts"
import { desktopSlashAction, desktopSlashCommands, mergeSlashCatalog } from "../src/renderer/desktop-slash.ts"
import { fallbackSlashCommands } from "../src/renderer/slash-commands.ts"

const key = (overrides = {}) => ({
  key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, ...overrides,
})
const idle = { running: false, empty: false, canRecall: true }
const running = { running: true, empty: false, canRecall: true }

test("Enter sends when idle and queues while a turn runs", () => {
  assert.equal(composerKeyAction(key(), idle), "send")
  assert.equal(composerKeyAction(key(), running), "queue")
  assert.equal(composerKeyAction(key({ ctrlKey: true }), idle), "send")
  assert.equal(composerKeyAction(key({ metaKey: true }), running), "queue")
})

test("Alt+Enter steers only while running, Shift+Enter inserts a newline", () => {
  assert.equal(composerKeyAction(key({ altKey: true }), running), "steer")
  assert.equal(composerKeyAction(key({ altKey: true }), idle), "send")
  assert.equal(composerKeyAction(key({ shiftKey: true }), idle), "default")
  assert.equal(composerKeyAction(key({ shiftKey: true, altKey: true }), running), "default")
})

test("IME composition never sends", () => {
  assert.equal(composerKeyAction(key({ isComposing: true }), idle), "default")
  assert.equal(composerKeyAction(key({ keyCode: 229 }), running), "default")
})

test("ArrowUp recalls the last prompt only in an empty composer", () => {
  const up = key({ key: "ArrowUp", keyCode: 38 })
  assert.equal(composerKeyAction(up, { ...idle, empty: true }), "recall")
  assert.equal(composerKeyAction(up, { ...idle, empty: false }), "default")
  assert.equal(composerKeyAction(up, { ...idle, empty: true, canRecall: false }), "default")
  assert.equal(composerKeyAction({ ...up, shiftKey: true }, { ...idle, empty: true }), "default")
  assert.equal(composerKeyAction(key({ key: "a" }), idle), "default")
})

test("desktopSlashAction only maps conversational actions", () => {
  for (const name of ["config", "context", "doctor", "login", "logout", "model", "effort", "session", "sessions", "theme"]) {
    assert.equal(desktopSlashAction(`/${name}`), undefined)
    assert.equal(desktopSlashAction(`/${name} value`), undefined)
  }
  assert.deepEqual(desktopSlashAction("/goal ship it"), { type: "goal", objective: "ship it" })
  assert.deepEqual(desktopSlashAction("/fork"), { type: "fork" })
  assert.equal(desktopSlashAction("/compact"), undefined)
})

test("mergeSlashCatalog layers fallback, runtime and desktop commands", () => {
  const runtime = [
    { name: "compact", description: "Runtime compact", usage: "/compact", aliases: [] },
    { name: "theme", description: "Runtime theme", usage: "/theme x", aliases: [] },
    { name: "review", description: "Review", usage: "/review", aliases: ["goal", "rv"] },
  ]
  const merged = mergeSlashCatalog(runtime)
  const names = merged.map((command) => command.name)
  assert.deepEqual(names, [...names].sort())
  assert.equal(new Set(names).size, names.length)
  assert.equal(merged.find((command) => command.name === "compact")?.description, "Runtime compact")
  assert.equal(merged.find((command) => command.name === "theme"), undefined)
  assert.deepEqual(merged.find((command) => command.name === "review")?.aliases, ["rv"])
  for (const command of [...fallbackSlashCommands, ...desktopSlashCommands]) assert.ok(names.includes(command.name))
})

test("mergeSlashCatalog does not mutate its inputs", () => {
  const runtime = [{ name: "review", description: "Review", usage: "/review", aliases: ["model", "rv"] }]
  const snapshot = structuredClone(runtime)
  const fallback = structuredClone(fallbackSlashCommands)
  mergeSlashCatalog(runtime)
  assert.deepEqual(runtime, snapshot)
  assert.deepEqual(fallbackSlashCommands, fallback)
})

test("contextDisplayFrom summarises the inspect record", () => {
  const display = contextDisplayFrom({
    breakdown: {
      captured_at: "2026-09-29T10:00:00Z",
      estimated_total: 5000,
      context_window_tokens: 20000,
      sections: [{ key: "system", label: "System prompt", tokens: 3000, messages: 1 }, { label: "" }, "bad"],
    },
    latest_usage: { input_tokens: 6000, cached_input_tokens: 1000, output_tokens: 200 },
  })
  assert.equal(display.total, 5000)
  assert.equal(display.window, 20000)
  assert.equal(display.percent, 0.3)
  assert.deepEqual(display.sections.map((section) => section.label), ["System prompt"])
  assert.match(contextReportText(display), /5,000 of 20,000 tokens \(30%\)/)
  const html = renderContextDisplay({ ...display, sections: [{ key: "x", label: "<b>", tokens: 10, messages: 1 }] })
  assert.match(html, /&lt;b&gt;/)
  assert.doesNotMatch(html, /<b>&lt;/)
})

test("contextDisplayFrom handles a session with nothing captured", () => {
  const display = contextDisplayFrom({ breakdown: null, latest_usage: null })
  assert.equal(display.percent, null)
  assert.match(contextReportText(display), /nothing captured/)
  assert.match(renderContextDisplay(display), /Nothing captured yet/)
})
