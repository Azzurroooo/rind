import assert from "node:assert/strict";
import test from "node:test";

import { createChoiceMenuState } from "../lib/choice-menu-state.js";

test("choice menu defaults to the recommended option", () => {
  const state = createChoiceMenuState(["a", "b", "c"], "b");

  assert.equal(state.selectedIndex(), 1);
  assert.equal(state.selectedOption(), "b");
});

test("choice menu defaults to the first option without a recommendation", () => {
  const state = createChoiceMenuState(["a", "b"], "");

  assert.equal(state.selectedIndex(), 0);
  assert.equal(state.selectedOption(), "a");
});

test("choice menu moves with arrow and vim keys and wraps around", () => {
  const state = createChoiceMenuState(["a", "b", "c"], "a");

  assert.equal(state.handleKey({ name: "down" }), true);
  assert.equal(state.selectedOption(), "b");

  assert.equal(state.handleKey({ text: "j" }), true);
  assert.equal(state.selectedOption(), "c");

  assert.equal(state.handleKey({ name: "down" }), true);
  assert.equal(state.selectedOption(), "a");

  assert.equal(state.handleKey({ name: "up" }), true);
  assert.equal(state.selectedOption(), "c");

  assert.equal(state.handleKey({ text: "k" }), true);
  assert.equal(state.selectedOption(), "b");
});

test("choice menu ignores unrelated keys", () => {
  const state = createChoiceMenuState(["a", "b"], "a");

  assert.equal(state.handleKey({ name: "enter" }), false);
  assert.equal(state.selectedIndex(), 0);
});
