import test from "node:test";
import assert from "node:assert/strict";

import { createEventController } from "../lib/event-controller.js";

test("background waits replace only the pending turn's completion line", async () => {
  const lines = [];
  const waits = [];
  const controller = createEventController({
    state: { sessionInfo: { background_count: 3 } },
    output: {
      log: (line) => lines.push(typeof line === "function" ? line() : line),
      setBackgroundWait: (waiting) => waits.push(waiting),
    },
  });
  const waiting = { count: 1, started_at: 100 };
  await controller.handle({ event: { type: "turn_completed", background_wait: waiting } });
  assert.match(lines[0], /Waiting for background task/);
  assert.match(lines[0], /Will continue automatically when finished. You can keep typing./);
  assert.doesNotMatch(lines[0], /Worked for/);
  assert.deepEqual(waits.at(-1), waiting);
  await controller.handle({ event: { type: "turn_started" } });
  assert.equal(waits.at(-1), null);
  await controller.handle({ event: { type: "background_wait_changed", background_wait: waiting } });
  assert.deepEqual(waits.at(-1), waiting);
  assert.equal(lines.length, 1, "state updates do not append transcript lines");
  await controller.handle({ event: { type: "turn_cancelled" } });
  assert.equal(waits.at(-1), null);
  await controller.handle({ event: { type: "turn_completed", duration_ms: 2120, background_wait: null } });
  assert.match(lines.at(-1), /Worked for/);
});

test("image notices use normal output without changing the input buffer", async () => {
  const state = { inputBuffer: "未发送内容", cursorIndex: 3 };
  const before = { ...state };
  const lines = [];
  const controller = createEventController({ state, output: { log: (line) => lines.push(line()) } });
  await controller.handle({ event: { type: "context_built", decisions: { image_notice: "Images not sent: unsupported model." } } });
  assert.deepEqual(lines, ["  · System: Images not sent: unsupported model."]);
  assert.deepEqual(state, before);
});

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

test("event controller ignores legacy goal continuation events", async () => {
  const logged = [];
  const chasing = [];
  const controller = createEventController({
    output: {
      log: (text) => logged.push(typeof text === "function" ? text() : text),
      closeAssistant() {},
      clearQueuedInputs() {},
      clearCompactContext() {},
    },
  });

  await controller.handle({ kind: "event", event: { type: "goal_continued", round: 2 } });
  await controller.handle({ kind: "event", event: { type: "turn_completed" } });

  assert.deepEqual(logged, ["─ Worked for 0ms"]);
  assert.deepEqual(chasing, []);
});

test("event controller exposes stream recovery as a working status", async () => {
  const labels = [];
  const controller = createEventController({
    output: {
      setActivityLabel: (label) => labels.push(label),
      assistantAppend() {},
    },
  });

  await controller.handle({ kind: "event", event: { type: "turn_step_retry", attempt: 2 } });
  await controller.handle({ kind: "event", event: { type: "assistant_delta", text: "continued" } });

  assert.deepEqual(labels, ["Retrying 2", "Working"]);
});


test("image notices deduplicate by session, model, severity and newly seen images", async () => {
  const state = { sessionInfo: { model: "unknown", provider: "fake", base_url: "local" } };
  const lines = [];
  const controller = createEventController({ state, output: { log: (line) => lines.push(line()) } });
  const send = (images, level = "info", session = "s1") => controller.handle({ session_id: session,
    event: { type: "context_built", decisions: { image_notice: "Image notice", image_notice_level: level, image_notice_images: images } } });
  await send(["a"]);
  await send(["a"]);
  assert.equal(lines.length, 1);
  await send(["a", "b"]);
  await send(["a"]);
  await send(["b"]);
  assert.equal(lines.length, 2);
  await send(["a"], "warning");
  assert.equal(lines.length, 3);
  await send(["a"], "warning", "s2");
  await send(["a"], "warning");
  assert.equal(lines.length, 4);
  state.sessionInfo.model = "vision";
  await controller.handle({ session_id: "s1", event: { type: "context_built", decisions: {} } });
  state.sessionInfo.model = "unknown";
  await send(["a"], "warning");
  assert.equal(lines.length, 5);
  state.sessionInfo.base_url = "another";
  await send(["a"], "warning");
  assert.equal(lines.length, 6);
});
