import assert from "node:assert/strict"
import test from "node:test"

import {
  INSPECTOR_TABS,
  clampInspectorWidth,
  formatDuration,
  inspectorFits,
  isInspectorTab,
  nextInspectorTab,
  normalizeUsageSummary,
  renderUsageSummary,
} from "../src/renderer/inspector-model.ts"
import { planProgress, renderPlanSection } from "../src/renderer/plan-section.ts"
import { createConversation, reduceEvent } from "../src/renderer/timeline-model.ts"

test("inspector tabs follow the spec order", () => {
  assert.deepEqual([...INSPECTOR_TABS], ["context", "activity", "files"])
  assert.equal(isInspectorTab("usage"), false)
  assert.equal(isInspectorTab("activity"), true)
  assert.equal(isInspectorTab("tasks"), false)
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
  assert.equal(nextInspectorTab("context", "ArrowRight"), "activity")
  assert.equal(nextInspectorTab("files", "ArrowRight"), "context")
  assert.equal(nextInspectorTab("context", "ArrowLeft"), "files")
  assert.equal(nextInspectorTab("activity", "Home"), "context")
  assert.equal(nextInspectorTab("activity", "End"), "files")
  assert.equal(nextInspectorTab("activity", "Enter"), undefined)
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

test("formatDuration uses ms, seconds, and minutes", () => {
  assert.equal(formatDuration(450), "450ms")
  assert.equal(formatDuration(4200), "4s")
  assert.equal(formatDuration(125000), "2m 5s")
})

test("renderPlanSection shows the active plan and escapes step text", () => {
  const event = (type, payload) => ({ type, sequence: 1, durability: "durable", sessionId: "s", turnId: "t", event: payload })
  let state = createConversation()
  state = reduceEvent(state, event("turn_started", { turn_id: "t" }))
  state = reduceEvent(state, event("plan_updated", { plan: [{ step: "Run <tests>", status: "completed" }, { step: "Ship it", status: "in_progress" }] }))
  const html = renderPlanSection(state)
  assert.match(html, /Plan/)
  assert.match(html, /1\/2/)
  assert.match(html, /Run &lt;tests&gt;/)
  assert.match(html, /plan-completed/)
  assert.match(html, /plan-in_progress/)
  assert.equal(planProgress({ steps: [{ status: "completed" }, { status: "cancelled" }], status: "pending" }).status, "completed")
})

test("renderPlanSection stays empty without a live plan", () => {
  assert.equal(renderPlanSection(createConversation()), "")
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
