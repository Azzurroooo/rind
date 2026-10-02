import assert from "node:assert/strict"
import test from "node:test"
import { RuntimeInputs } from "../src/main/runtime-inputs.ts"
import { addUserMessage, createConversation, reduceEvent } from "../src/renderer/timeline-model.ts"

const started = (session_id, turn_id = "t1", chars = 5) => ({ kind: "event", method: "session/update", sequence: 1, durability: "durable", session_id, turn_id, event: { type: "turn_started", user_message_chars: chars } })
const desktop = (event) => ({ ...event, type: event.event.type, sessionId: event.session_id, turnId: event.turn_id })

test("accepted prompts reach every viewer at turn start and reconcile by input id", () => {
  const inputs = new RuntimeInputs()
  inputs.begin("r1", "session/prompt", { session_id: "s1", input: "hello", client_input_id: "local-1" })
  const envelope = inputs.enrich(started("s1"))
  assert.equal(envelope.sequence, 1)
  assert.equal(envelope.event.input, "hello")
  const local = addUserMessage(createConversation(), "hello", "local-1")
  assert.equal(reduceEvent(local, desktop(envelope)).entries.length, 1)
  const remote = reduceEvent(createConversation(), desktop(envelope))
  assert.equal(remote.entries[0].content, "hello")
  assert.equal(inputs.enrich(started("s1")).event.input, undefined)
})

test("prompt correlation isolates sessions, ignores empty continuations, clears rejected requests", () => {
  const inputs = new RuntimeInputs()
  inputs.begin("r1", "session/prompt", { session_id: "s1", input: "one" })
  inputs.begin("r2", "session/prompt", { session_id: "s2", input: "two" })
  assert.equal(inputs.enrich(started("s1", "compact", 0)).event.input, undefined)
  assert.equal(inputs.enrich(started("s2")).event.input, "two")
  inputs.finish("r1")
  assert.equal(inputs.enrich(started("s1")).event.input, undefined)
  inputs.begin("r3", "session/prompt", { session_id: "s1", input: "stale" })
  inputs.clear()
  assert.equal(inputs.enrich(started("s1")).event.input, undefined)
})

test("remote queued delivery appears without a local queue and repeated text remains distinct", () => {
  const event = { type: "queued_input_delivered", turnId: "t1", event: { input: "again", input_id: "q1" } }
  let state = reduceEvent(createConversation(), event)
  state = reduceEvent(state, event)
  assert.equal(state.entries.length, 1)
  state = reduceEvent(state, { ...event, event: { input: "again", input_id: "q2" } })
  assert.equal(state.entries.length, 2)
})
