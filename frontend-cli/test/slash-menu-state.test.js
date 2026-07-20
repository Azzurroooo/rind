import assert from "node:assert/strict";
import test from "node:test";

import { createSlashMenuState } from "../lib/slash-menu-state.js";

const commands = [
  { name: "status", description: "Show status" },
  { name: "sessions", description: "List sessions" },
  { name: "clear", description: "Clear screen" },
];

const fullCommandDeck = [
  "clear",
  "compact",
  "config",
  "doctor",
  "draft",
  "exit",
  "help",
  "init",
  "model",
  "skill",
  "status",
].map((name) => ({ name, description: `/${name}` }));

test("slash menu opens only for a slash command prefix", () => {
  const state = createSlashMenuState(commands);

  assert.equal(state.handleKey("/", {}), true);
  assert.deepEqual(state.matches().map((command) => command.name), ["status", "sessions", "clear"]);

  assert.equal(state.handleKey("s", {}), true);
  assert.deepEqual(state.matches().map((command) => command.name), ["status", "sessions"]);

  assert.equal(state.handleKey(" ", {}), true);
  assert.deepEqual(state.matches(), []);
});

test("slash menu arrows select commands without changing input text", () => {
  const state = createSlashMenuState(commands);
  state.setInput("/");

  assert.equal(state.input(), "/");
  assert.equal(state.selectedCommand().name, "status");

  assert.equal(state.handleKey("", { name: "down" }), true);
  assert.equal(state.input(), "/");
  assert.equal(state.selectedCommand().name, "sessions");

  assert.equal(state.handleKey("", { name: "up" }), true);
  assert.equal(state.input(), "/");
  assert.equal(state.selectedCommand().name, "status");
});

test("slash menu keeps selection when input is synced unchanged", () => {
  const state = createSlashMenuState(commands);
  state.setInput("/");
  state.handleKey("", { name: "down" });

  state.setInput("/");

  assert.equal(state.selectedCommand().name, "sessions");
});

test("slash menu escape dismisses immediately and typing reopens it", () => {
  const state = createSlashMenuState(commands);
  state.setInput("/");

  assert.equal(state.handleKey("", { name: "escape" }), true);
  assert.deepEqual(state.matches(), []);
  assert.equal(state.input(), "/");

  assert.equal(state.handleKey("s", {}), true);
  assert.equal(state.input(), "/s");
  assert.deepEqual(state.matches().map((command) => command.name), ["status", "sessions"]);
});

test("slash menu leaves backspace to the editor", () => {
  const state = createSlashMenuState(commands);
  state.setInput("/");

  assert.equal(state.handleKey("", { name: "backspace" }), false);
  assert.equal(state.input(), "/");
  assert.deepEqual(state.matches().map((command) => command.name), ["status", "sessions", "clear"]);
});

test("slash menu ignores modified keypresses", () => {
  const state = createSlashMenuState(commands);
  state.setInput("/");

  assert.equal(state.handleKey("x", { ctrl: true }), false);
  assert.equal(state.input(), "/");
});

test("slash menu keeps all matching commands for renderer windowing", () => {
  const state = createSlashMenuState(fullCommandDeck);
  state.setInput("/");

  assert.deepEqual(state.matches().map((command) => command.name), [
    "clear",
    "compact",
    "config",
    "doctor",
    "draft",
    "exit",
    "help",
    "init",
    "model",
    "skill",
    "status",
  ]);
});

test("slash menu can select commands beyond the first visible window", () => {
  const state = createSlashMenuState(fullCommandDeck);
  state.setInput("/");

  for (let index = 0; index < 8; index += 1) {
    assert.equal(state.handleKey("", { name: "down" }), true);
  }

  assert.equal(state.selectedIndex(), 8);
  assert.equal(state.selectedCommand().name, "model");

  assert.equal(state.handleKey("", { name: "down" }), true);
  assert.equal(state.selectedIndex(), 9);
  assert.equal(state.selectedCommand().name, "skill");
});

test("slash menu returns later selected commands for submission", () => {
  const state = createSlashMenuState(fullCommandDeck);
  state.setInput("/");

  for (let index = 0; index < 9; index += 1) {
    state.handleKey("", { name: "down" });
  }

  const command = state.selectedCommand();
  const submitted = command ? `/${command.name}` : state.input();

  assert.equal(submitted, "/skill");
});
