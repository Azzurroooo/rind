import assert from "node:assert/strict";
import test from "node:test";

import { createModelMenuState } from "../lib/model-menu-state.js";

test("model menu defaults to the current model", () => {
  const state = createModelMenuState(["model-a", "model-b", "model-c"], "model-b");

  assert.equal(state.selectedIndex(), 1);
  assert.equal(state.selectedModel().name, "model-b");
  assert.equal(state.selectedModel().current, true);
});

test("model menu includes current model when missing from server list", () => {
  const state = createModelMenuState(["model-a", "model-b"], "custom-model");

  assert.deepEqual(state.items().map((item) => item.name), ["custom-model", "model-a", "model-b"]);
  assert.equal(state.selectedModel().name, "custom-model");
});

test("model menu can select beyond the first visible window", () => {
  const models = Array.from({ length: 10 }, (_, index) => `model-${index}`);
  const state = createModelMenuState(models, "model-0");

  for (let index = 0; index < 8; index += 1) {
    assert.equal(state.handleKey({ name: "down" }), true);
  }

  assert.equal(state.selectedIndex(), 8);
  assert.equal(state.selectedModel().name, "model-8");
});

test("model menu wraps around at list edges", () => {
  const state = createModelMenuState(["model-a", "model-b"], "model-a");

  assert.equal(state.handleKey({ name: "up" }), true);
  assert.equal(state.selectedModel().name, "model-b");

  assert.equal(state.handleKey({ name: "down" }), true);
  assert.equal(state.selectedModel().name, "model-a");
});
