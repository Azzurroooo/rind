import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { SegmentPresentation, reconcileToolElement } from "../src/renderer/segment-presentation.ts"

test("automatic folds settle once, reopen immediately, and honor manual choices", () => {
  const state = new SegmentPresentation()
  assert.equal(state.mode("a", "closed", false, 0), "closed")
  assert.equal(state.mode("b", "trimmed", false, 0), "trimmed")
  assert.equal(state.mode("b", "closed", false, 10), "trimmed")
  assert.equal(state.mode("b", "closed", false, 500), "trimmed")
  assert.equal(state.deadline(), 610)
  assert.equal(state.mode("b", "trimmed", false, 590), "trimmed")
  assert.equal(state.deadline(), null)
  assert.equal(state.mode("b", "closed", false, 600), "trimmed")
  assert.equal(state.mode("b", "closed", false, 1200), "closed")
  assert.equal(state.mode("b", "all", true, 1300), "all")
  assert.equal(state.mode("b", "closed", true, 1301), "closed")
  state.prune(new Set())
  assert.equal(state.deadline(), null)
})

test("stream updates preserve focused keyed rows and mounted fold shells", () => {
  const dom = new JSDOM('<section><div class="segment-calls-shell"><div class="segment-calls-clip"><div data-tool-id="one"><button>Running</button></div></div></div></section>')
  globalThis.Element = dom.window.Element
  try {
    const root = dom.window.document.querySelector("section")
    const shell = root.firstElementChild
    const button = root.querySelector("button")
    button.focus()
    const next = root.cloneNode(true)
    next.querySelector("button").textContent = "Completed"
    reconcileToolElement(root, next)
    assert.equal(root.querySelector("button"), button)
    assert.equal(dom.window.document.activeElement, button)
    const closed = root.cloneNode(true)
    closed.firstElementChild.setAttribute("aria-hidden", "true")
    closed.firstElementChild.setAttribute("inert", "")
    closed.querySelector(".segment-calls-clip").replaceChildren()
    reconcileToolElement(root, closed)
    assert.equal(root.firstElementChild, shell)
    assert.equal(root.querySelector("button"), button)
    assert.ok(shell.hasAttribute("inert"))
  } finally { delete globalThis.Element; dom.window.close() }
})
