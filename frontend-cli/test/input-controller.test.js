import test from "node:test";
import assert from "node:assert/strict";

import { createInputController } from "../lib/input-controller.js";

test("input controller starts and closes terminal input through one boundary", () => {
  let started = 0;
  let stopped = 0;
  const terminalUi = {
    start() {
      started += 1;
    },
    stop() {
      stopped += 1;
    },
  };
  const controller = createInputController({
    terminalUi,
    askInput: async () => "",
  });

  controller.start();
  controller.close();
  assert.equal(started, 1);
  assert.equal(stopped, 1);
});

test("input controller pauses, resumes, and submits prompt text", async () => {
  const state = { runtimeClosing: false, promptPaused: false };
  const submitted = [];
  const controller = createInputController({
    state,
    askInput: async () => "hello",
    onSubmit: (text) => {
      submitted.push(text);
      state.runtimeClosing = true;
    },
    onCommand: async () => false,
    prompt: () => "prompt",
    placeholder: () => "placeholder",
  });

  controller.pause();
  const loop = controller.promptLoop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted.length, 0);
  controller.resume();
  await loop;
  assert.deepEqual(submitted, ["hello"]);
});

test("input controller passes the live prompt callback to the input boundary", async () => {
  let receivedPrompt;
  const state = { runtimeClosing: false, promptPaused: false };
  const controller = createInputController({
    state,
    askInput: async (prompt) => {
      receivedPrompt = prompt;
      state.runtimeClosing = true;
      return "hello";
    },
    onSubmit: () => {},
    prompt: () => "live prompt",
    placeholder: () => "placeholder",
  });

  await controller.promptLoop();
  assert.equal(typeof receivedPrompt, "function");
  assert.equal(receivedPrompt(), "live prompt");
});
