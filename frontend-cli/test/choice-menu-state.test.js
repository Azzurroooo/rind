import assert from "node:assert/strict";
import test from "node:test";

import { createChoiceMenuState } from "../lib/choice-menu-state.js";
import { createQuestionMenuState } from "../lib/question-menu-state.js";

test("choice menu defaults to the requested value", () => {
  const state = createChoiceMenuState(["a", "b", "c"], "b");

  assert.equal(state.selectedIndex(), 1);
  assert.equal(state.selectedOption(), "b");
});

test("choice menu defaults to the first option without a requested value", () => {
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

test("choice menu stores only string options", () => {
  const state = createChoiceMenuState(["a", "", "a", "b"]);

  assert.deepEqual(state.options(), ["a", "b"]);
});

test("question menu enters custom editing and discards its draft on navigation", () => {
  const state = createQuestionMenuState([
    { label: "fast", description: "Less analysis" },
    { label: "thorough (Recommended)", description: "More analysis" },
  ]);

  assert.equal(state.selectedIndex(), 0);
  assert.equal(state.handleNavigation({ name: "down" }), true);
  assert.equal(state.handleNavigation({ name: "down" }), true);
  assert.equal(state.selectedIndex(), 2);
  assert.equal(state.enterEditing(), true);
  assert.equal(state.isEditing(), true);
  assert.equal(state.handleNavigation({ name: "up" }), true);
  assert.equal(state.selectedIndex(), 1);
  assert.equal(state.isEditing(), false);
  assert.equal(state.handleNavigation({ text: "j" }), true);
  assert.equal(state.selectedIndex(), 2);
  assert.equal(state.enterEditing(), true);
  assert.equal(state.handleNavigation({ text: "j" }), false);
});
