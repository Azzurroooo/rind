import assert from "node:assert/strict"
import test from "node:test"
import { replayMarkdown, restoreFailedDraft } from "../src/renderer/session-actions.ts"

test("export retains long messages and the full history", () => {
  const long = "long response ".repeat(10000)
  const messages = Array.from({ length: 501 }, (_, i) => ({ role: "user", content: `Message ${i}` }))
  messages.push({ role: "assistant", content: [{ type: "text", text: long }] })
  messages.push({ role: "tool", content: "private tool details" })
  const markdown = replayMarkdown(messages, "Conversation")
  assert.ok(markdown.includes("Message 0"))
  assert.ok(markdown.includes("Message 500"))
  assert.ok(markdown.includes(long))
  assert.ok(!markdown.includes("private tool details"))
})

test("a failed send restores only its own draft and preserves later typing", () => {
  const drafts = { "first:draft": "typed later", "second:draft": "another session" }
  restoreFailedDraft(drafts, "first:draft", "failed message")
  assert.equal(drafts["first:draft"], "failed message\ntyped later")
  assert.equal(drafts["second:draft"], "another session")
})
