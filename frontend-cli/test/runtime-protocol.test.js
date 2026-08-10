import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createRuntimeRequest,
  runtimeEventType,
  runtimeRequestId,
  turnInputMethod,
} from "../lib/runtime-protocol.js";

test("runtime requests use request_id", () => {
  assert.deepEqual(createRuntimeRequest(4, "turn.start", { input: "hello" }), {
    request_id: 4,
    method: "turn.start",
    params: { input: "hello" },
  });
});

test("runtime protocol reads response and event metadata", () => {
  assert.equal(runtimeRequestId({ request_id: 4 }), 4);
  assert.equal(runtimeEventType({ event_type: "turn_completed", event: {} }), "turn_completed");
  assert.equal(runtimeEventType({ event: { type: "turn_started" } }), "turn_started");
  assert.equal(runtimeEventType({ event: { type: "unknown" }, extra: true }), "unknown");
});

test("runtime protocol recognizes the shared golden event fixture", () => {
  const fixture = readFileSync(new URL("../../test/fixtures/runtime_protocol.golden.jsonl", import.meta.url), "utf8");
  const messages = fixture.trim().split("\n").map((line) => JSON.parse(line));
  const events = messages.filter((message) => message.kind === "event");
  const responses = messages.filter((message) => message.kind === "response");

  assert.deepEqual(events.map(runtimeEventType), [
    "turn_started",
    "assistant_delta",
    "tool_requested",
    "tool_result",
    "turn_completed",
  ]);
  assert.deepEqual(events.map((message) => message.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(responses.map(runtimeRequestId), ["turn-1", "interrupt-2"]);
});

test("active input routes to follow-up without a client-side turn queue", () => {
  assert.equal(turnInputMethod(false), "turn.start");
  assert.equal(turnInputMethod(true), "turn.follow_up");
  assert.equal(turnInputMethod(false), "turn.start");
});
