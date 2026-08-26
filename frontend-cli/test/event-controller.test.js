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
    state: { get activeTurn() { return true; } },
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

test("turn completion summary aggregates file changes and token spend", async () => {
  const logged = [];
  const controller = createEventController({
    state: { get activeTurn() { return true; } },
    output: {
      setStats: () => {},
      closeAssistant() {},
      clearQueuedInputs() {},
      clearCompactContext() {},
      log: (text) => logged.push(typeof text === "function" ? text() : text),
    },
  });

  await controller.handle({ kind: "event", event: { type: "turn_started" } });
  await controller.handle({ kind: "event", event: {
    type: "token_stats_updated",
    stats: { input_tokens: 1000 },
  } });
  await controller.handle({ kind: "event", event: {
    type: "file_change",
    tool_call_id: "c1",
    file_path: "src/a.py",
    lines: [{ kind: "added" }, { kind: "added" }, { kind: "removed" }],
  } });
  await controller.handle({ kind: "event", event: {
    type: "file_change",
    tool_call_id: "c2",
    file_path: "src/b.py",
    lines: [{ kind: "added" }],
  } });
  await controller.handle({ kind: "event", event: {
    type: "token_stats_updated",
    stats: { input_tokens: 43000 },
  } });
  await controller.handle({ kind: "event", event: {
    type: "turn_completed",
    duration_ms: 72000,
  } });

  assert.match(logged.at(-1), /Worked for 1m 12s/);
  assert.match(logged.at(-1), /\+3 -1 2 files/);
  assert.match(logged.at(-1), /~42\.0k tokens/);
});

test("event controller logs goal continuation and toggles the chasing state", async () => {
  const logged = [];
  const chasing = [];
  const controller = createEventController({
    output: {
      log: (text) => logged.push(typeof text === "function" ? text() : text),
      setGoalChasing: (enabled) => chasing.push(enabled),
      closeAssistant() {},
      clearQueuedInputs() {},
      clearCompactContext() {},
    },
  });

  await controller.handle({ kind: "event", event: { type: "goal_continued", round: 2 } });
  await controller.handle({ kind: "event", event: { type: "turn_completed" } });

  assert.match(logged[0], /Goal continued/);
  assert.match(logged[0], /round 2/);
  assert.deepEqual(chasing, [true, false]);
});
