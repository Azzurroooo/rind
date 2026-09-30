import assert from "node:assert/strict"
import test from "node:test"
import { messageTime } from "../src/renderer/message-time.ts"
import { addUserMessage, conversationFromReplay, createConversation, reduceEvent } from "../src/renderer/timeline-model.ts"

const ts = "2026-09-29T06:34:10Z"
test("message clocks format real timestamps and reject unavailable history", () => {
  assert.equal(messageTime(ts).iso, "2026-09-29T06:34:10.000Z")
  assert.match(messageTime(ts).full, /2026/)
  assert.deepEqual(messageTime(Date.parse(ts)), messageTime(Date.parse(ts) / 1000))
  for (const value of [undefined, "", "invalid", Infinity]) assert.equal(messageTime(value), null)
})
test("replay preserves persistence time without assigning today to legacy messages", () => {
  const state = conversationFromReplay([{ id: "u", role: "user", content: "hi", ts }, { id: "a", role: "assistant", content: "answer", ts }, { id: "old", role: "user", content: "old" }])
  assert.deepEqual(state.entries.map((entry) => entry.time), [ts, ts, undefined])
})
test("live events use remote clocks; streaming keeps its time and local input is not duplicated", () => {
  let state = createConversation()
  const send = (type, event) => { state = reduceEvent(state, { type, turnId: "t", sessionId: "s", sequence: 1, durability: "durable", event: { ts, ...event } }) }
  send("turn_started", { input: "remote", client_input_id: "r" })
  send("assistant_delta", { text: "first" })
  send("assistant_delta", { text: " second", ts: "2026-09-29T06:34:12Z" })
  assert.equal(state.entries.at(-1).time, ts)
  send("assistant_message_completed", { content: "first second" })
  send("queued_input_delivered", { input: "queue", input_id: "q" })
  assert.deepEqual(state.entries.map((entry) => entry.time), [ts, ts, ts])
  state = addUserMessage(state, "local", "l", 1000)
  send("turn_started", { input: "local", client_input_id: "l" })
  assert.equal(state.entries.filter((entry) => entry.inputId === "l").length, 1)
  assert.equal(state.entries.at(-1).time, 1000)
})
