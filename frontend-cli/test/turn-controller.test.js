import test from "node:test";
import assert from "node:assert/strict";

import { createTurnController } from "../lib/turn-controller.js";
import { observeRuntime } from "../lib/agents-session.js";

function createHarness({ activeTurn = false } = {}) {
  const calls = [];
  const logs = [];
  const state = {
    activeTurn,
    interruptRequested: false,
    runtimeClosing: false,
  };
  const output = {
    queueInput: (text, mode, result) => logs.push(`queued:${mode}:${text}${result?.echoed ? ":echoed" : ""}`),
    writeUserInput: (text) => logs.push(`user:${text}`),
    restoreInputText: (text) => logs.push(`restore:${text}`),
    writeError: (text) => logs.push(`error:${text}`),
    refreshInputState: () => logs.push("refresh"),
    closeAssistant: () => logs.push("close-assistant"),
    cancelInput: () => logs.push("cancel-input"),
    logInterrupt: () => logs.push("interrupt"),
  };
  let resolveRequest;
  const request = (method, params) => {
    calls.push({ method, params });
    if (method === "session/prompt") {
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
  return { calls, logs, state, output, controller, resolveRequest: (value = {}) => resolveRequest?.(value) };
}

test("turn controller keeps activity until the runtime emits a terminal event", async () => {
  const harness = createHarness();
  harness.controller.submit("hello");
  assert.equal(harness.state.activeTurn, true);
  assert.equal(harness.calls[0].method, "session/prompt");
  assert.deepEqual(harness.calls[0].params, { input: "hello" });

  harness.resolveRequest();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.state.activeTurn, true);
});

test("active turns steer by default and queue follow-ups explicitly", async () => {
  const harness = createHarness({ activeTurn: true });
  harness.controller.submit("steer now");
  harness.controller.submitFollowUp("follow up");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.calls.map(({ method, params }) => ({ method, params })), [
    { method: "rind/session/steer", params: { input: "steer now" } },
    { method: "rind/session/follow_up", params: { input: "follow up" } },
  ]);
  assert.deepEqual(harness.logs.slice(0, 2), [
    "queued:steering:steer now",
    "queued:follow_up:follow up",
  ]);
});

test("interrupt marks the turn and sends an interrupt request", async () => {
  const harness = createHarness({ activeTurn: true });
  harness.controller.interrupt();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.state.interruptRequested, true);
  assert.equal(harness.calls[0].method, "session/cancel");
  assert.deepEqual(harness.logs.slice(0, 3), ["cancel-input", "close-assistant", "interrupt"]);
});

test("observeRuntime preserves interactive turn completion scope", async () => {
  const seen = [];
  const wrapped = observeRuntime(
    {
      child: null,
      async request(method, params) {
        seen.push({ method, params });
        return { ok: true };
      },
      async shutdown() {},
    },
    {
      async before() {},
      async after() {},
      async close() {},
    },
  );
  await wrapped.request("session/prompt", { session_id: "s-1", input: "hi" });
  assert.deepEqual(seen, [
    { method: "session/prompt", params: { session_id: "s-1", input: "hi" } },
  ]);
});

test("steer that races with turn completion falls back to starting a new turn", async () => {
  const calls = [];
  const logs = [];
  const state = { activeTurn: true, interruptRequested: false, runtimeClosing: false };
  const controller = createTurnController({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "rind/session/steer") {
        state.activeTurn = false;
        throw Object.assign(new Error("No active turn accepts queued input."), { code: "TurnNotActive" });
      }
      return { ok: true };
    },
    state,
    output: {
      queueInput: (text, mode) => logs.push(`queued:${mode}:${text}`),
      writeUserInput: (text) => logs.push(`user:${text}`),
      restoreInputText: (text) => logs.push(`restore:${text}`),
      writeError: (text) => logs.push(`error:${text}`),
      refreshInputState: () => logs.push("refresh"),
      closeAssistant: () => logs.push("close-assistant"),
      cancelInput: () => {},
      logInterrupt: () => {},
    },
  });

  controller.submit("next turn input");
  await new Promise((resolve) => setImmediate(resolve));
  await controller.waitForIdle();

  assert.deepEqual(calls, [
    { method: "rind/session/steer", params: { input: "next turn input" } },
    { method: "session/prompt", params: { input: "next turn input" } },
  ]);
  assert.ok(logs.includes("user:next turn input"));
  assert.ok(!logs.some((item) => item.startsWith("error:")));
});

test("prompt converted to steering by runtime queues input without closing active turn", async () => {
  const harness = createHarness({ activeTurn: false });
  harness.controller.submit("auto-steered");
  harness.resolveRequest({ ok: true, steered: true, mode: "steering", input_id: "in-1" });
  await harness.controller.waitForIdle();

  assert.equal(harness.state.activeTurn, true);
  assert.ok(harness.logs.includes("queued:steering:auto-steered:echoed"));
  assert.ok(!harness.logs.includes("close-assistant"));
});
