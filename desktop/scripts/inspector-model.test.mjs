import assert from "node:assert/strict"
import test from "node:test"

import {
  INSPECTOR_TABS,
  clampInspectorWidth,
  formatDuration,
  inspectorFits,
  isInspectorTab,
  nextInspectorTab,
  normalizeBackgroundList,
  normalizeBackgroundOutput,
  normalizeUsageSummary,
  renderBackgroundHistory,
  renderUsageSummary,
} from "../src/renderer/inspector-model.ts"

test("inspector tabs follow the spec order", () => {
  assert.deepEqual([...INSPECTOR_TABS], ["context", "tasks", "files", "goal", "usage"])
  assert.equal(isInspectorTab("usage"), true)
  assert.equal(isInspectorTab("plan"), false)
  assert.equal(isInspectorTab(3), false)
})

test("clampInspectorWidth keeps the 320-640 range with a 360 fallback", () => {
  assert.equal(clampInspectorWidth(480), 480)
  assert.equal(clampInspectorWidth(200), 320)
  assert.equal(clampInspectorWidth(900), 640)
  assert.equal(clampInspectorWidth(Number.NaN), 360)
  assert.equal(clampInspectorWidth(undefined), 360)
})

test("inspectorFits leaves the conversation at least 420px", () => {
  assert.equal(inspectorFits(1280, 264, 360), true)
  assert.equal(inspectorFits(1000, 264, 360), false)
  assert.equal(inspectorFits(800, 0, 360), true)
})

test("nextInspectorTab wraps with arrow keys and jumps with Home and End", () => {
  assert.equal(nextInspectorTab("context", "ArrowRight"), "tasks")
  assert.equal(nextInspectorTab("usage", "ArrowRight"), "context")
  assert.equal(nextInspectorTab("context", "ArrowLeft"), "usage")
  assert.equal(nextInspectorTab("goal", "Home"), "context")
  assert.equal(nextInspectorTab("goal", "End"), "usage")
  assert.equal(nextInspectorTab("goal", "Enter"), undefined)
})

test("normalizeUsageSummary reads rind/usage/summary and drops malformed rows", () => {
  const summary = normalizeUsageSummary({
    days: 7,
    totals: { input: 1200, cached: 300, output: 400, reasoning: 50, total: 1650, samples: 3, compactions: 1 },
    by_day: [{ day: "2026-09-29", tokens: 1000 }, { day: "", tokens: 5 }, "junk"],
    by_model: [{ model: "gpt-5", tokens: 1650, samples: 3 }, { tokens: 1 }],
  })
  assert.equal(summary.totals.total, 1650)
  assert.equal(summary.totals.compactions, 1)
  assert.deepEqual(summary.byDay, [{ day: "2026-09-29", tokens: 1000 }])
  assert.deepEqual(summary.byModel, [{ model: "gpt-5", tokens: 1650, samples: 3 }])
  assert.deepEqual(normalizeUsageSummary(null).totals, { input: 0, cached: 0, output: 0, reasoning: 0, total: 0, samples: 0, compactions: 0 })
})

test("renderUsageSummary shows totals, days, and escaped model names", () => {
  const html = renderUsageSummary(normalizeUsageSummary({
    days: 7,
    totals: { total: 2000, samples: 2 },
    by_day: [{ day: "2026-09-29", tokens: 2000 }],
    by_model: [{ model: "<m>", tokens: 2000, samples: 2 }],
  }))
  assert.match(html, /2,000/)
  assert.match(html, /By day/)
  assert.match(html, /&lt;m&gt;/)
  assert.doesNotMatch(html, /<m>/)
  assert.match(renderUsageSummary(normalizeUsageSummary({ days: 7 })), /No token usage recorded in the last 7 days/)
})

test("normalizeBackgroundList keeps finished tasks newest first", () => {
  const records = normalizeBackgroundList({
    tasks: [
      { bg_id: "bg-1", status: "completed", command: "npm test", elapsed_ms: 4200 },
      { bg_id: "bg-2", status: "running", command: "sleep 9" },
      { bg_id: "bg-3", status: "failed", command: "make" },
      { status: "completed" },
    ],
  })
  assert.deepEqual(records.map((record) => record.bgId), ["bg-3", "bg-1"])
  assert.equal(records[1].elapsedMs, 4200)
  assert.deepEqual(normalizeBackgroundList(undefined), [])
})

test("normalizeBackgroundOutput joins streams and keeps the exit code", () => {
  assert.deepEqual(normalizeBackgroundOutput({ task: { stdout: "ok", stderr: "warn", exit_code: 2, truncated: true } }), { text: "ok\nwarn", exitCode: 2, truncated: true })
  assert.deepEqual(normalizeBackgroundOutput({}), { text: "", truncated: false })
})

test("renderBackgroundHistory expands one record and escapes output", () => {
  const records = normalizeBackgroundList({ tasks: [{ bg_id: "bg-1", status: "completed", command: "echo <b>" }] })
  const collapsed = renderBackgroundHistory({ records, expandedId: "", outputs: {}, reading: new Set(), loading: false, error: "" })
  assert.match(collapsed, /data-history-task="bg-1"/)
  assert.match(collapsed, /aria-expanded="false"/)
  assert.match(collapsed, /echo &lt;b&gt;/)
  const expanded = renderBackgroundHistory({ records, expandedId: "bg-1", outputs: { "bg-1": { text: "<done>", exitCode: 0, truncated: false } }, reading: new Set(), loading: false, error: "" })
  assert.match(expanded, /aria-expanded="true"/)
  assert.match(expanded, /&lt;done&gt;/)
  assert.match(expanded, /exit 0/)
  assert.match(renderBackgroundHistory({ records: [], expandedId: "", outputs: {}, reading: new Set(), loading: false, error: "" }), /No finished background tasks yet/)
  assert.match(renderBackgroundHistory({ records: [], expandedId: "", outputs: {}, reading: new Set(), loading: false, error: "boom" }), /role="alert"/)
})

test("formatDuration uses ms, seconds, and minutes", () => {
  assert.equal(formatDuration(450), "450ms")
  assert.equal(formatDuration(4200), "4s")
  assert.equal(formatDuration(125000), "2m 5s")
})

test("contextMeterMarkup draws a 16px ring with the rounded percentage", async () => {
  const { contextMeterMarkup } = await import("../src/renderer/composer-region.ts")
  const half = contextMeterMarkup(0.5)
  assert.match(half, /width="16" height="16"/)
  assert.match(half, /aria-hidden="true"/)
  assert.match(half, /<span>50%<\/span>/)
  assert.match(contextMeterMarkup(1.4), /<span>100%<\/span>/)
  assert.match(contextMeterMarkup(1), /stroke-dashoffset="0.00"/)
})
