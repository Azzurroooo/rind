import assert from "node:assert/strict";
import test from "node:test";

import { createThemeMenuState } from "../lib/theme-menu-state.js";
import { resetTheme, setTheme } from "../lib/theme.js";

test("theme menu lists all flavors and defaults to the current theme", () => {
  resetTheme();
  const state = createThemeMenuState();

  assert.deepEqual(state.items().map((item) => item.name), ["latte", "frappe", "macchiato", "mocha"]);
  assert.equal(state.selectedIndex(), 3);
  assert.equal(state.selectedTheme().name, "mocha");
  assert.equal(state.selectedTheme().current, true);
});

test("theme menu selection follows the active theme", () => {
  resetTheme();
  setTheme("latte");
  const state = createThemeMenuState();

  assert.equal(state.selectedIndex(), 0);
  assert.equal(state.selectedTheme().label, "Latte");
  resetTheme();
});

test("theme menu wraps around at list edges", () => {
  resetTheme();
  const state = createThemeMenuState();

  assert.equal(state.handleKey({ name: "down" }), true);
  assert.equal(state.selectedTheme().name, "latte");

  assert.equal(state.handleKey({ name: "up" }), true);
  assert.equal(state.selectedTheme().name, "mocha");

  assert.equal(state.handleKey({ name: "up" }), true);
  assert.equal(state.selectedTheme().name, "macchiato");
});
