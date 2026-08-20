import assert from "node:assert/strict"
import test from "node:test"

import { syncPendingInputDock } from "../src/renderer/composer-region.ts"

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.children = []
    this.dataset = {}
    this.hidden = false
    this.disabled = false
    this.textContent = ""
    this.listeners = new Map()
  }

  append(...children) {
    this.children.push(...children)
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler)
  }

  click() {
    this.listeners.get("click")?.()
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }

  querySelectorAll(selector) {
    const matches = []
    const visit = (element) => {
      if (
        (selector === "[data-pending-input-id]" && element.dataset.pendingInputId)
        || (selector.startsWith(".") && String(element.className || "").split(/\s+/).includes(selector.slice(1)))
      ) matches.push(element)
      for (const child of element.children) visit(child)
    }
    for (const child of this.children) visit(child)
    return matches
  }
}

test("pending input dock exposes recall for every row and preserves its input id", () => {
  const previousDocument = globalThis.document
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) }
  try {
    const dock = new FakeElement("section")
    const recalled = []
    syncPendingInputDock(
      dock,
      [
        { inputId: "queue-1", input: "first queue", mode: "follow_up", promoting: false, recalling: false },
        { inputId: "queue-2", input: "second queue", mode: "follow_up", promoting: false, recalling: false },
        { inputId: "steer-1", input: "steer now", mode: "steering", promoting: false, recalling: false },
      ],
      () => {},
      (inputId) => recalled.push(inputId),
    )

    assert.equal(dock.children.length, 3)
    const rows = dock.children
    assert.equal(rows.every((row) => row.querySelector(".pending-input-recall").hidden === false), true)
    rows[0].querySelector(".pending-input-recall").click()
    rows[1].querySelector(".pending-input-recall").click()
    rows[2].querySelector(".pending-input-recall").click()
    assert.deepEqual(recalled, ["queue-1", "queue-2", "steer-1"])
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})
