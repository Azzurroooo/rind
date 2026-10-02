import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { renderGoalPanel } from "../src/renderer/goal-panel.ts"

test("Activity shows only existing goals and preserves controls across updates", () => {
  const dom = new JSDOM("<section></section>")
  const panel = dom.window.document.querySelector("section")
  renderGoalPanel(panel, { busy: false })
  assert.equal(panel.hidden, true)
  assert.equal(panel.childElementCount, 0)
  const goal = { objective: "Review <tests>", status: "active" }
  renderGoalPanel(panel, { goal, busy: false })
  assert.equal(panel.hidden, false)
  assert.equal(panel.querySelector(".goal-objective").textContent, goal.objective)
  assert.equal(panel.querySelector("input, textarea, [data-goal-submit], [data-toggle-goal-set]"), null)
  const pause = panel.querySelector("[data-goal-pause]")
  pause.focus()
  renderGoalPanel(panel, { goal, busy: false })
  assert.equal(panel.querySelector("[data-goal-pause]"), pause)
  assert.equal(dom.window.document.activeElement, pause)
  renderGoalPanel(panel, { goal: { ...goal, status: "paused" }, busy: true })
  assert.equal(panel.querySelector("[data-goal-resume]").disabled, true)
  renderGoalPanel(panel, { busy: false })
  assert.equal(panel.hidden, true)
  assert.equal(panel.childElementCount, 0)
  dom.window.close()
})
