import assert from "node:assert/strict"
import test from "node:test"

import { isStreamingAssistant, latestAssistantId, messageActions, STARTER_PROMPTS } from "../src/renderer/message-view.ts"

const user = (id) => ({ kind: "user", id, content: "hi" })
const assistant = (id, content) => ({ kind: "assistant", id, content, turnId: "t" })

test("latestAssistantId skips blank assistant entries and later tool rows", () => {
  const entries = [user("u1"), assistant("a1", "First."), user("u2"), assistant("a2", "Second."), assistant("a3", "  "), { kind: "tool", id: "t1" }]
  assert.equal(latestAssistantId(entries), "a2")
  assert.equal(latestAssistantId([user("u1")]), "")
  assert.equal(latestAssistantId([]), "")
})

test("isStreamingAssistant needs an active turn and the open assistant id", () => {
  assert.equal(isStreamingAssistant("a1", "a1", true), true)
  assert.equal(isStreamingAssistant("a1", "a1", false), false)
  assert.equal(isStreamingAssistant("a1", "a2", true), false)
  assert.equal(isStreamingAssistant("", "", true), false)
})

test("messageActions follow the spec per role", () => {
  assert.deepEqual(messageActions("user"), ["copy", "edit"])
  assert.deepEqual(messageActions("assistant"), ["copy"])
})

test("the empty state offers three to four suggestion chips with plain labels", () => {
  assert.ok(STARTER_PROMPTS.length >= 3 && STARTER_PROMPTS.length <= 4)
  for (const starter of STARTER_PROMPTS) {
    assert.ok(starter.label.trim() && starter.prompt.trim())
    assert.doesNotMatch(starter.label, /[^\x20-\x7e]/)
  }
})
