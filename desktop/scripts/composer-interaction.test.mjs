import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { composerRegionMarkup, renderComposer } from "../src/renderer/composer-region.ts"
import { questionCardMarkup, syncQuestionCard } from "../src/renderer/question-card.ts"
import { createQuestionSelection, selectQuestionOption, updateQuestionInput } from "../src/renderer/question-state.ts"
import { conversationFromLiveTurn, createConversation, reduceEvent } from "../src/renderer/timeline-model.ts"

test("primary action switches between send, stop and queue without replacing controls", () => {
  const dom = new JSDOM()
  globalThis.document = dom.window.document
  try {
    document.body.innerHTML = composerRegionMarkup()
    const el = (id) => document.getElementById(id)
    const elements = { prompt: el("prompt"), send: el("send"), steer: el("steer"), interrupt: el("interrupt"), menuTrigger: el("composer-menu-trigger"), menu: el("composer-menu"), compactContext: el("compact-context"), slashCommandMenu: el("slash-command-menu"), contextMeter: el("context-meter") }
    const view = { ready: true, active: false, readOnly: false, starting: false, controllingTurn: false, runtimeSessionId: "s", compacting: false, composerMenuOpen: false, slashCommandPending: false, contextUsagePercent: null }
    renderComposer(elements, view)
    assert.ok(elements.send.disabled)
    renderComposer(elements, { ...view, active: true, controllingTurn: true })
    assert.equal(elements.send.dataset.action, "stop")
    elements.prompt.value = "follow-up"
    renderComposer(elements, { ...view, active: true, controllingTurn: true })
    assert.equal(elements.send.dataset.action, "queue")
    assert.equal(elements.steer.disabled, false)
    renderComposer(elements, { ...view, active: true, controllingTurn: true, compacting: true })
    assert.equal(elements.send.dataset.action, "stop")
    assert.equal(elements.steer.disabled, true)
    assert.equal(elements.prompt.value, "follow-up")
    assert.equal(elements.prompt.disabled, false)
    assert.equal(document.getElementById("prompt"), elements.prompt)
    assert.ok(el("send-actions-menu").contains(elements.interrupt))
  } finally { dom.window.close(); delete globalThis.document }
})

test("question updates retain the input, caret and draft; failed submissions can retry", () => {
  const dom = new JSDOM()
  globalThis.document = dom.window.document
  try {
    const question = { toolCallId: "q1", question: "Choose a plan", options: [{ label: "Small", description: "One change" }] }
    let selection = selectQuestionOption(createQuestionSelection("q1", 1), 1, 1)
    document.body.innerHTML = questionCardMarkup(question, selection)
    const card = document.querySelector("section")
    const input = document.querySelector("textarea")
    syncQuestionCard(card, selection, 1)
    input.focus()
    input.value = "my own plan"
    input.setSelectionRange(3, 6)
    selection = updateQuestionInput(selection, input.value)
    syncQuestionCard(card, selection, 1)
    assert.equal(document.activeElement, input)
    assert.equal(input.selectionStart, 3)
    assert.equal(document.querySelector("textarea"), input)
    syncQuestionCard(card, { ...selection, submitting: true }, 1)
    assert.ok(document.querySelector("button").disabled)
    syncQuestionCard(card, { ...selection, error: "Try again" }, 1)
    assert.equal(document.querySelector("button").disabled, false)
    assert.equal(input.value, "my own plan")
    assert.match(card.textContent, /Try again/)
  } finally { dom.window.close(); delete globalThis.document }
})

test("compaction operation survives a live snapshot and clears on completion", () => {
  const live = conversationFromLiveTurn({ turn_id: "c1", status: "running", operation: "compact" })
  assert.equal(live.operation, "compact")
  const ended = reduceEvent(live, { type: "turn_completed", turnId: "c1", event: {} })
  assert.equal(ended.operation, "")
  assert.equal(ended.activeTurnId, "")
})
