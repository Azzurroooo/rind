import test from "node:test";
import assert from "node:assert/strict";

import { createEventController } from "../lib/event-controller.js";

test("event controller forwards assistant deltas and suppresses duplicate tool announcements", async () => {
  const assistant = [];
  const logs = [];
  const controller = createEventController({
    output: {
      assistantAppend: (text) => assistant.push(text),
      log: (text) => logs.push(text),
      closeAssistant() {},
    },
  });

  await controller.handle({ kind: "event", event: { type: "assistant_delta", text: "hello" } });
  await controller.handle({ kind: "event", event: {
    type: "tool_requested",
    tool_name: "bash",
    tool_call_id: "call-1",
    args_preview: '{"command":"pwd"}',
  } });
  await controller.handle({ kind: "event", event: {
    type: "tool_call_started",
    tool_name: "bash",
    tool_call_id: "call-1",
  } });

  assert.deepEqual(assistant, ["hello"]);
  assert.equal(logs.length, 1);
});

test("event controller emits tool result and resets turn state", async () => {
  const logs = [];
  let resets = 0;
  const controller = createEventController({
    output: {
      log: (text) => logs.push(text),
      closeAssistant() {},
      resetTurnTools: () => { resets += 1; },
      clearCompactContext() {},
    },
  });

  await controller.handle({ kind: "event", event: {
    type: "tool_result",
    tool_name: "bash",
    tool_call_id: "call-2",
    status: "completed",
    result: "done",
  } });
  await controller.handle({ kind: "event", event: {
    type: "turn_completed",
    duration_ms: 12,
  } });

  assert.equal(logs.length, 2);
  assert.equal(resets, 1);
});

test("event controller forwards delegate lifecycle to the task monitor", async () => {
  const requests = [];
  const results = [];
  let clears = 0;
  const controller = createEventController({
    monitor: {
      recordDelegateRequest: (event) => requests.push(event),
      recordDelegateResult: (event) => results.push(event),
      clearDelegates: () => { clears += 1; },
    },
    output: {
      log() {},
      closeAssistant() {},
      clearCompactContext() {},
      resetTurnTools() {},
    },
  });

  await controller.handle({ kind: "event", event: {
    type: "tool_requested",
    tool_name: "delegate",
    tool_call_id: "delegate-1",
    args_preview: '{"agent_id":"builder-agent","task":"build it"}',
  } });
  await controller.handle({ kind: "event", event: {
    type: "tool_result",
    tool_name: "delegate",
    tool_call_id: "delegate-1",
    status: "completed",
    result: '{"data":{"status":"completed","summary":"done"}}',
  } });
  await controller.handle({ kind: "event", event: {
    type: "turn_completed",
  } });

  assert.equal(requests.length, 1);
  assert.equal(results.length, 1);
  assert.equal(clears, 1);
});
