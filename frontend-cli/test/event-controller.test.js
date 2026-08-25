import test from "node:test";
import assert from "node:assert/strict";

import { createEventController } from "../lib/event-controller.js";

test("event controller forwards assistant deltas and every announce event to the output layer", async () => {
  const assistant = [];
  const begun = [];
  const controller = createEventController({
    output: {
      assistantAppend: (text) => assistant.push(text),
      beginTool: (event) => begun.push(event),
      closeAssistant() {},
    },
  });

  await controller.handle({ kind: "event", event: { type: "assistant_delta", text: "hello" } });
  await controller.handle({ kind: "event", event: {
    type: "tool_input_started",
    tool_name: "bash",
    tool_call_id: "call-1",
  } });
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
  // The output layer owns dedup (Map on TTY / Set on legacy stdout); the
  // controller forwards every announce so late-arriving args can enrich.
  assert.deepEqual(begun.map((event) => event.type), ["tool_input_started", "tool_requested", "tool_call_started"]);
});

test("event controller emits tool result and resets turn state", async () => {
  const finished = [];
  const completed = [];
  const controller = createEventController({
    output: {
      finishTool: (event, fileChange) => finished.push({ event, fileChange }),
      turnCompleted: undefined,
      log: (text) => completed.push(text),
      closeAssistant() {},
      clearCompactContext() {},
      clearQueuedInputs() {},
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

  assert.equal(finished.length, 1);
  assert.equal(finished[0].event.tool_call_id, "call-2");
  assert.equal(completed.length, 1);
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

test("event controller delivers queued input and clears pending input on terminal events", async () => {
  const delivered = [];
  let clears = 0;
  const controller = createEventController({
    output: {
      deliverQueuedInput: (input, mode, inputId) => delivered.push({ input, mode, inputId }),
      clearQueuedInputs: () => { clears += 1; },
      clearCompactContext() {},
      closeAssistant() {},
      log() {},
    },
  });

  await controller.handle({ kind: "event", event: {
    type: "queued_input_delivered",
    input: "continue with tests",
    mode: "follow_up",
    input_id: "queued-1",
  } });
  await controller.handle({ kind: "event", event: { type: "turn_completed" } });

  assert.deepEqual(delivered, [{ input: "continue with tests", mode: "follow_up", inputId: "queued-1" }]);
  assert.equal(clears, 1);
});
