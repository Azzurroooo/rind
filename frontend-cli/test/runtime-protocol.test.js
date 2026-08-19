import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createRuntimeRequest,
  isRuntimeEvent,
  isRuntimeResponse,
  requireRuntimeInitialization,
  runtimeMethods,
  runtimeProtocolVersion,
  runtimeEventType,
  runtimeRequestId,
} from "../lib/runtime-protocol.js";

test("runtime requests use request_id", () => {
  assert.deepEqual(createRuntimeRequest(4, runtimeMethods.sessionPrompt, { input: "hello" }), {
    kind: "request",
    request_id: 4,
    method: runtimeMethods.sessionPrompt,
    params: { input: "hello" },
  });
});

test("runtime protocol reads response and event metadata", () => {
  assert.equal(runtimeRequestId({ request_id: 4 }), 4);
  assert.equal(runtimeEventType({ event: {} }), "");
  assert.equal(runtimeEventType({ event: { type: "turn_started" } }), "turn_started");
  assert.equal(runtimeEventType({ event: { type: "unknown" }, extra: true }), "unknown");
});

test("runtime protocol validates response, event, and initialization schemas", () => {
  assert.equal(isRuntimeResponse({ kind: "response", request_id: 4, result: {} }), true);
  assert.equal(isRuntimeResponse({ kind: "response", request_id: null, result: {} }), false);
  assert.equal(isRuntimeEvent({
    kind: "event",
    method: "session/update",
    sequence: 1,
    durability: "incremental",
    session_id: "s1",
    turn_id: "t1",
    event: { type: "assistant_delta" },
  }), true);
  assert.equal(isRuntimeEvent({ kind: "event", event: { type: "assistant_delta" } }), false);
  assert.deepEqual(requireRuntimeInitialization({
    protocol_version: runtimeProtocolVersion,
    capabilities: [],
    methods: [],
  }), {
    protocol_version: runtimeProtocolVersion,
    capabilities: [],
    methods: [],
  });
  assert.throws(() => requireRuntimeInitialization({ protocol_version: "1" }), /Unsupported Runtime protocol/);
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

test("runtime protocol exposes separate steering and follow-up methods", () => {
  assert.equal(runtimeMethods.sessionSteer, "rind/session/steer");
  assert.equal(runtimeMethods.sessionFollowUp, "rind/session/follow_up");
});
