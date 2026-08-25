import test from "node:test";
import assert from "node:assert/strict";

import { createCommandController } from "../lib/command-controller.js";
import { executeLocalSlashCommand } from "../lib/local-slash-commands.js";

test("command controller separates text, goal, and slash commands", async () => {
  const calls = [];
  const logs = [];
  const turn = {
    submit: (...args) => calls.push({ method: "turn.submit", args }),
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
    output: { log: (text) => logs.push(typeof text === "function" ? text() : text) },
  });

  assert.equal(await controller.handle("hello"), false);
  assert.equal(await controller.handle("/goal ship it"), true);
  assert.equal(await controller.handle("/status"), true);
  assert.equal(await controller.handle("/steer use tests"), true);
  await controller.handle("?");

  assert.equal(calls[0].method, "goal");
  assert.equal(calls[1].method, "rind/command/execute");
  assert.deepEqual(calls[2], {
    method: "rind/command/execute",
    params: { input: "/steer use tests" },
  });
  assert.equal(logs.length, 3);
});

test("command normalization keeps aliases and ignores invalid names", () => {
  const controller = createCommandController({
    request: async () => ({}),
    turn: { submit() {} },
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
    turn: { submit: (...args) => calls.push(args) },
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

test("team blueprint menu selection reuses the slash command path", async () => {
  const calls = [];
  const controller = createCommandController({
    request: async (method, params) => {
      calls.push({ method, params });
      return { text: "created" };
    },
    turn: { submit() {} },
    input: {
      askTeamBlueprint: async (blueprints) => blueprints[1],
    },
    output: { log: (text) => calls.push({ log: typeof text === "function" ? text() : text }) },
  });

  await controller.applyResult({
    text: "Available Team blueprints:",
    display: {
      type: "team_blueprints",
      blueprints: [
        { id: "research", name: "Research" },
        { id: "weather", name: "Weather" },
      ],
    },
  });

  assert.deepEqual(calls, [
    { log: "Available Team blueprints:" },
    {
      method: "rind/command/execute",
      params: { input: "/team blueprint weather" },
    },
    { log: "created" },
  ]);
});

test("slash result ignores malformed next prompts", async () => {
  let submitted = false;
  const controller = createCommandController({
    request: async () => ({}),
    turn: { submit: () => { submitted = true; } },
    output: { log() {} },
  });

  await controller.applyResult({ next_prompt: { input: { invalid: true } } });
  await controller.applyResult({ next_prompt: { input: "   " } });

  assert.equal(submitted, false);
});

test("exit remains a Surface-local command", async () => {
  const calls = [];
  const controller = createCommandController({
    request: async () => {
      throw new Error("local commands must not call Runtime");
    },
    turn: { submit() {} },
    output: {
      log: (text) => calls.push(typeof text === "function" ? text() : text),
      shutdown: async () => calls.push("shutdown"),
      exit: () => calls.push("exit"),
    },
  });

  await controller.handle("/quit");
  assert.deepEqual(calls, ["Goodbye.", "shutdown", "exit"]);
});

test("local slash results do not call Runtime", async () => {
  const calls = [];
  const controller = createCommandController({
    request: async () => {
      throw new Error("local slash commands must not call Runtime");
    },
    turn: { submit() {} },
    input: {
      runLocalCommand: async (text) => text === "/status" ? { text: "local status" } : null,
    },
    output: { log: (text) => calls.push(typeof text === "function" ? text() : text) },
  });

  await controller.handle("/status");
  assert.deepEqual(calls, ["local status"]);
});

test("local command catalog stays complete before the runtime starts", async () => {
  const controller = createCommandController({
    request: async () => ({}),
    turn: { submit() {} },
  });
  const names = controller.localCommands().map((command) => command.name);
  assert.deepEqual(names, [
    "exit",
    "quit",
    "compact",
    "config",
    "doctor",
    "help",
    "init",
    "login",
    "model",
    "sessions",
    "skill",
    "status",
    "team",
    "theme",
  ]);
  for (const name of ["compact", "init", "sessions", "skill", "team"]) {
    const result = await executeLocalSlashCommand(`/${name}`, {
      settings: { model: "m" },
      sessionInfo: {},
      cwd: ".",
      runtimeStarted: false,
      runtimeInitialized: false,
      interactive: true,
      commands: [],
    });
    assert.equal(result, null, `/${name} must fall through to the runtime`);
  }
});
