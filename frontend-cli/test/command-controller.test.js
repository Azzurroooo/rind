import test from "node:test";
import assert from "node:assert/strict";

import { createCommandController } from "../lib/command-controller.js";

test("command controller separates text, steering, goal, and slash commands", async () => {
  const calls = [];
  const logs = [];
  const turn = {
    submit: (...args) => calls.push({ method: "turn.submit", args }),
    submitSteering: (...args) => calls.push({ method: "rind/session/steer", args }),
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

  assert.equal(calls[0].method, "rind/session/steer");
  assert.equal(calls[1].method, "goal");
  assert.equal(calls[2].method, "rind/command/execute");
  assert.equal(logs.length, 2);
});

test("readonly slash commands do not wait for their background result", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  let completed = false;
  const controller = createCommandController({
    request: async () => ({}),
    turn: { submit() {}, submitSteering() {} },
    input: {
      isTerminal: true,
      startReadonlySlashCommand: () => {
        started += 1;
        return pending;
      },
    },
  });

  const handling = controller.handle("/status").then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(started, 1);
  assert.equal(completed, true);
  release();
  await handling;
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

test("slash result can prefill input and start a follow-up turn", async () => {
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
    prompt_prefill: "draft",
    next_prompt: {
      input: "continue",
      transient_system_messages: [{ role: "system", content: "context" }],
    },
  });
  assert.deepEqual(calls, [
    ["prefill", "draft"],
    ["continue", { transient_system_messages: [{ role: "system", content: "context" }] }],
  ]);
});

test("clear and exit remain Surface-local commands", async () => {
  const calls = [];
  const controller = createCommandController({
    request: async () => {
      throw new Error("local commands must not call Runtime");
    },
    turn: { submit() {}, submitSteering() {} },
    output: {
      clearScreen: () => calls.push("clear"),
      log: (text) => calls.push(text),
      shutdown: async () => calls.push("shutdown"),
      exit: () => calls.push("exit"),
    },
  });

  await controller.handle("/clear");
  await controller.handle("/quit");
  assert.deepEqual(calls, ["clear", "Goodbye.", "shutdown", "exit"]);
});

test("local slash results do not call Runtime and removed commands stay local", async () => {
  const calls = [];
  const controller = createCommandController({
    request: async () => {
      throw new Error("local slash commands must not call Runtime");
    },
    turn: { submit() {}, submitSteering() {} },
    input: {
      runLocalCommand: async (text) => text === "/status"
        ? { text: "local status" }
        : text === "/plan" ? { text: "Unknown command: /plan" } : null,
    },
    output: { log: (text) => calls.push(text) },
  });

  await controller.handle("/status");
  await controller.handle("/plan");
  assert.deepEqual(calls, ["local status", "Unknown command: /plan"]);
});

test("runtime catalog excludes plan and draft", () => {
  const controller = createCommandController({
    request: async () => ({}),
    turn: { submit() {}, submitSteering() {} },
  });
  assert.deepEqual(controller.normalizeCommands([
    { name: "plan", aliases: ["draft"] },
    { name: "status" },
  ]), [{ name: "status", description: "" }]);
});
