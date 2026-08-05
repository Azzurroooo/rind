import test from "node:test";
import assert from "node:assert/strict";

import { createCommandController } from "../lib/command-controller.js";

test("command controller separates text, steering, goal, and slash commands", async () => {
  const calls = [];
  const logs = [];
  const turn = {
    submit: (...args) => calls.push({ method: "turn.submit", args }),
    submitSteering: (...args) => calls.push({ method: "turn.steer", args }),
  };
  const controller = createCommandController({
    request: async (method, params) => {
      calls.push({ method, params });
      return { text: "status" };
    },
    turn,
    input: {
      isTerminal: false,
      runGoalCommand: (goal) => calls.push({ method: "goal", goal }),
    },
    state: { slashCommands: [] },
    output: { log: (text) => logs.push(text) },
  });

  assert.equal(await controller.handle("hello"), false);
  assert.equal(await controller.handle("/steer use tests"), true);
  assert.equal(await controller.handle("/goal ship it"), true);
  assert.equal(await controller.handle("/status"), true);
  await controller.handle("?");

  assert.equal(calls[0].method, "turn.steer");
  assert.equal(calls[1].method, "goal");
  assert.equal(calls[2].method, "slash.execute");
  assert.equal(logs.length, 2);
});

test("command normalization keeps aliases and ignores invalid names", () => {
  const controller = createCommandController({
    request: async () => ({}),
    turn: { submit() {}, submitSteering() {} },
  });

  assert.deepEqual(controller.normalizeCommands([
    { name: " Status ", description: "show status", aliases: ["s"] },
    { name: "bad name" },
  ]), [
    { name: "s", description: "alias for /status" },
    { name: "status", description: "show status" },
  ]);
});

test("slash result can start a turn and request shutdown", async () => {
  const calls = [];
  const controller = createCommandController({
    request: async () => ({}),
    turn: { submit: (...args) => calls.push(args), submitSteering() {} },
    output: {
      setInputPrefill: (value) => calls.push(["prefill", value]),
      shutdown: async () => calls.push(["shutdown"]),
      exit: () => calls.push(["exit"]),
    },
  });

  await controller.applyResult({
    input_prefill: "draft",
    run_turn_input: "continue",
    should_exit: true,
  });
  assert.deepEqual(calls, [
    ["prefill", "draft"],
    ["continue", { transient_system_messages: undefined }],
    ["shutdown"],
    ["exit"],
  ]);
});
