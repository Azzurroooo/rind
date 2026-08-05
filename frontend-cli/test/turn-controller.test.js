import test from "node:test";
import assert from "node:assert/strict";

import { createTurnController } from "../lib/turn-controller.js";

function createHarness({ activeTurn = false } = {}) {
  const calls = [];
  const logs = [];
  const state = {
    activeTurn,
    interruptRequested: false,
    runtimeClosing: false,
    turnTools: { completed: 0, failed: 0 },
  };
  const output = {
    logQueuedInput: (text) => logs.push(`queued:${text}`),
    restoreInputText: (text) => logs.push(`restore:${text}`),
    writeError: (text) => logs.push(`error:${text}`),
    refreshInputState: () => logs.push("refresh"),
    resetTurnTools: () => logs.push("reset-tools"),
    closeAssistant: () => logs.push("close-assistant"),
    cancelInput: () => logs.push("cancel-input"),
    logInterrupt: () => logs.push("interrupt"),
  };
  let resolveRequest;
  const request = (method, params) => {
    calls.push({ method, params });
    if (method === "turn.start") {
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    }
    return Promise.resolve({});
  };
  const controller = createTurnController({
    request,
    state,
    output,
  });
  return { calls, logs, state, controller, resolveRequest: () => resolveRequest?.({}) };
}

test("turn controller starts a turn and clears active state when it settles", async () => {
  const harness = createHarness();
  harness.controller.submit("hello");
  assert.equal(harness.state.activeTurn, true);
  assert.equal(harness.calls[0].method, "turn.start");
  assert.deepEqual(harness.calls[0].params, { input: "hello" });

  harness.resolveRequest();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.state.activeTurn, false);
});

test("active turns send follow-ups and steering through the same controller", async () => {
  const harness = createHarness({ activeTurn: true });
  harness.controller.submit("follow up");
  harness.controller.submitSteering("focus on tests", "/steer focus on tests");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.calls.map(({ method, params }) => ({ method, params })), [
    { method: "turn.follow_up", params: { input: "follow up" } },
    { method: "turn.steer", params: { input: "focus on tests" } },
  ]);
  assert.deepEqual(harness.logs.slice(0, 1), ["queued:follow up"]);
});

test("interrupt marks the turn and sends an interrupt request", async () => {
  const harness = createHarness({ activeTurn: true });
  harness.controller.interrupt();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.state.interruptRequested, true);
  assert.equal(harness.calls[0].method, "turn.interrupt");
  assert.deepEqual(harness.logs.slice(0, 3), ["cancel-input", "close-assistant", "interrupt"]);
});
