// /settings: a two-level menu for global brief output, color theme, and
// conversation skill imports. Before the first message the window keeps the
// skill import choice; afterwards it is applied only once the prompt-cache
// cost is accepted.
import test from "node:test";
import assert from "node:assert/strict";

import { createCliRuntimeController } from "../lib/cli-runtime-controller.js";
import { createCliState } from "../lib/cli-state.js";
import { settingsMenuText } from "../lib/rendering.js";
import { runtimeMethods as methods } from "../lib/runtime-protocol.js";
import { createSettingsMenuState } from "../lib/settings-menu-state.js";
import { resetSpinner, setSpinner } from "../lib/cli-state-store.js";
import { resetTheme, setTheme } from "../lib/theme.js";

const SOURCES = [
  { id: "claude_user", label: "Claude · user", paths: ["/home/u/.claude/skills"], count: 1, enabled: true },
  { id: "codex_user", label: "Codex · user", paths: ["/home/u/.codex/skills", "/home/u/.agents/skills"], count: 5, enabled: true },
  { id: "claude_project", label: "Claude · project", paths: ["/work/.claude/skills"], count: 0, enabled: false },
  { id: "codex_project", label: "Codex · project", paths: ["/work/.codex/skills", "/work/.agents/skills"], count: 0, enabled: true },
];

function harness({
  sessionId = "s1",
  selected = {
    brief: false,
    briefChanged: false,
    theme: "frappe",
    themeChanged: false,
    spinner: "orbit",
    spinnerChanged: false,
    importChoices: { claude_user: false },
  },
  answer = "Apply · change the skills and break the cache",
} = {}) {
  const state = createCliState();
  state.session.info = { session_id: sessionId, workspace_root: "/work" };
  const commands = [];
  const questions = [];
  const logs = [];
  const briefUpdates = [];
  const themeUpdates = [];
  const spinnerUpdates = [];
  const client = {
    child: {},
    start() {},
    async request(method, params) {
      if (method === methods.initialize) return { protocol_version: "2", capabilities: [], methods: [], session_id: sessionId };
      if (method === methods.commandExecute) {
        commands.push(params);
        return { text: "", display: { type: "skill_imports", sources: SOURCES } };
      }
      if (method === methods.sessionCreate) return { session_id: "created" };
      return {};
    },
  };
  const controller = createCliRuntimeController({
    client, methods, sessionScopedMethods: new Set([methods.commandExecute]), turnScopedMethods: new Set(),
    requireInitialization: value => value, state, getCommands: () => ({ normalizeCommands: () => [], localCommands: () => [] }), getTaskMonitor: () => null, getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => null,
    askSettingsMenu: async () => selected,
    getBriefMode: () => false,
    onBriefChange: async (enabled) => { briefUpdates.push(enabled); },
    onThemeChange: async (name) => { themeUpdates.push(name); },
    onSpinnerChange: async (name) => { spinnerUpdates.push(name); },
    askChoice: async (question) => { questions.push(question); return answer; },
    askSessionMenu: async () => null, askForkPointMenu: async () => null, restoreLiveTurn() {}, clearPendingInputs() {},
    closeAssistant() {}, refreshInputState() {}, updateGoalState() {}, log: value => logs.push(typeof value === "function" ? value() : value),
    writeError() {}, redraw() {},
  });
  return { state, controller, commands, questions, logs, briefUpdates, themeUpdates, spinnerUpdates };
}

test("two-level /settings menu navigates between root settings, theme submenu, spinner submenu, and skill imports submenu", () => {
  resetTheme();
  resetSpinner();
  const menu = createSettingsMenuState({ brief: false, sources: SOURCES });
  assert.equal(menu.level(), "root");
  assert.equal(menu.changed(), false);

  // Toggle brief output on root level
  assert.equal(menu.handleKey({ text: " " }), "redraw");
  assert.equal(menu.briefChanged(), true);
  assert.equal(menu.value().brief, true);

  // Move to Theme and enter Level 2 theme submenu
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedIndex(), 1);
  assert.equal(menu.handleKey({ name: "enter" }), "redraw");
  assert.equal(menu.level(), "theme");
  assert.equal(menu.selectedIndex(), 1, "defaults to active frappe theme");
  assert.equal(menu.selectedTheme().name, "frappe");
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedTheme().name, "dracula");
  // Esc in theme submenu reverts uncommitted theme selection and returns to root
  assert.equal(menu.handleKey({ name: "escape" }), "redraw");
  assert.equal(menu.level(), "root");
  assert.equal(menu.selectedIndex(), 1);
  assert.equal(menu.themeChanged(), false);

  // Move to Working spinner and enter Level 2 spinner submenu
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedIndex(), 2);
  assert.equal(menu.handleKey({ name: "enter" }), "redraw");
  assert.equal(menu.level(), "spinner");
  assert.equal(menu.selectedIndex(), 4, "defaults to active orbit spinner (5th option)");
  assert.equal(menu.selectedSpinner().name, "orbit");
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedSpinner().name, "sweep", "wraps from 5th to 1st option");
  assert.equal(menu.handleKey({ name: "escape" }), "redraw");
  assert.equal(menu.level(), "root");
  assert.equal(menu.selectedIndex(), 2);
  assert.equal(menu.spinnerChanged(), false);

  // Move to Skill imports and enter Level 2 submenu
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedIndex(), 3);
  assert.equal(menu.handleKey({ name: "enter" }), "redraw");
  assert.equal(menu.level(), "import");
  assert.equal(menu.selectedIndex(), 0);

  // Toggle a layer in Level 2, and verify wrapping navigation
  menu.handleKey({ name: "down" });
  menu.handleKey({ text: " " });
  assert.deepEqual(menu.importChoices(), { codex_user: false });
  menu.handleKey({ name: "up" });
  menu.handleKey({ name: "up" });
  assert.equal(menu.selectedIndex(), 3, "the selection wraps");

  // Esc in Level 2 reverts uncommitted submenu edits and returns to Level 1
  assert.equal(menu.handleKey({ name: "escape" }), "redraw");
  assert.equal(menu.level(), "root");
  assert.equal(menu.selectedIndex(), 3);
  assert.deepEqual(menu.importChoices(), {});
  assert.equal(menu.briefChanged(), true, "root brief toggle remains pending until submitted or cancelled");

  // Re-enter Level 2, toggle claude_user, and submit with Enter
  assert.equal(menu.handleKey({ name: "enter" }), "redraw");
  assert.equal(menu.level(), "import");
  assert.equal(menu.handleKey({ text: " " }), "redraw");
  assert.equal(menu.handleKey({ name: "enter" }), "submit");
  assert.deepEqual(menu.value(), {
    brief: true,
    briefChanged: true,
    theme: "frappe",
    themeChanged: false,
    spinner: "orbit",
    spinnerChanged: false,
    importChoices: { claude_user: false },
  });
});

test("theme and spinner submenus in /settings follow active state and wrap at edges", () => {
  resetTheme();
  resetSpinner();
  setTheme("everforest-dark-medium");
  const menu = createSettingsMenuState({ initialLevel: "theme" });
  assert.equal(menu.level(), "theme");
  assert.equal(menu.selectedTheme().name, "everforest-dark-medium");
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedTheme().name, "pistachio");
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedTheme().name, "latte");
  assert.equal(menu.handleKey({ name: "up" }), "redraw");
  assert.equal(menu.selectedTheme().name, "pistachio");
  assert.equal(menu.handleKey({ name: "enter" }), "submit");
  assert.equal(menu.value().theme, "pistachio");
  assert.equal(menu.value().themeChanged, true);
  resetTheme();

  setSpinner("pulse");
  const spinnerMenu = createSettingsMenuState({ initialLevel: "spinner" });
  assert.equal(spinnerMenu.level(), "spinner");
  assert.equal(spinnerMenu.selectedSpinner().name, "pulse");
  assert.equal(spinnerMenu.handleKey({ name: "up" }), "redraw");
  assert.equal(spinnerMenu.selectedSpinner().name, "sparkle");
  assert.equal(spinnerMenu.handleKey({ name: "enter" }), "submit");
  assert.equal(spinnerMenu.value().spinner, "sparkle");
  assert.equal(spinnerMenu.value().spinnerChanged, true);
  resetSpinner();
});

test("settingsMenuText renders root deck, theme submenu, spinner submenu, and skill imports submenu", () => {
  resetTheme();
  resetSpinner();
  const menu = createSettingsMenuState({ brief: false, sources: SOURCES });
  const rootLines = settingsMenuText(menu.items(), menu.selectedIndex(), menu.level()).split("\n");
  assert.match(rootLines[0], /Settings$/);
  assert.match(rootLines[1], /› Brief output .* off .* Collapse consecutive tool calls into one live line/);
  assert.match(rootLines[2], /· Theme .* Frappé › .* Switch the CLI color theme/);
  assert.match(rootLines[3], /· Working spinner .* Orbit › .* Choose the working activity animation/);
  assert.match(rootLines[4], /· Skill imports .* 3 of 4 on › .* Choose the Claude and Codex skills this conversation reads/);
  assert.match(rootLines[5], /space toggle · enter open\/apply · esc cancel/);

  menu.handleKey({ name: "down" });
  menu.handleKey({ name: "enter" });
  const themeLines = settingsMenuText(menu.items(), menu.selectedIndex(), menu.level()).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  assert.match(themeLines[0], /Settings · Theme/);
  assert.match(themeLines[2], /› Frappé\s+████████\s+current/);
  assert.match(themeLines.at(-2), /↑↓ select · enter apply · esc back/);

  menu.handleKey({ name: "escape" });
  menu.handleKey({ name: "down" });
  menu.handleKey({ name: "enter" });
  const spinnerLines = settingsMenuText(menu.items(), menu.selectedIndex(), menu.level()).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  assert.match(spinnerLines[0], /Settings · Working spinner/);
  assert.match(spinnerLines[1], /· Sweep\s+█▒░░░ ▒█▒░░ ░▒█▒░ ░░▒█▒ ░░░▒█ ░░▒█▒ ░▒█▒░ ▒█▒░░/);
  assert.match(spinnerLines[2], /· Sparkle\s+· ✧ ✦ ✧ · ∗ ✴ ∗/);
  assert.match(spinnerLines[3], /· Pulse\s+░ ▒ ▓ █ ▓ ▒/);
  assert.match(spinnerLines[4], /· Bars\s+▁ ▂ ▃ ▄ ▅ ▆ ▇ █ ▇ ▆ ▅ ▄ ▃ ▂/);
  assert.match(spinnerLines[5], /› Orbit\s+◐ ◓ ◑ ◒\s+current/);

  menu.handleKey({ name: "escape" });
  menu.handleKey({ name: "down" });
  menu.handleKey({ name: "enter" });
  const importLines = settingsMenuText(menu.items(), menu.selectedIndex(), menu.level()).split("\n");
  assert.match(importLines[0], /Settings · Import skills into this conversation/);
  assert.match(importLines[1], /› \[x\] Claude · user .* 1 skill$/);
  assert.match(importLines[2], /Codex · user .*\.codex.*\.agents.* 5 skills$/);
  assert.match(importLines[3], /\[ \] Claude · project .* —$/);
  assert.match(importLines[5], /space toggle · enter apply · esc back/);
});

test("in a conversation the change is applied after the cache cost is accepted", async () => {
  const h = harness({
    selected: {
      brief: true,
      briefChanged: true,
      theme: "latte",
      themeChanged: true,
      spinner: "bars",
      spinnerChanged: true,
      importChoices: { claude_user: false },
    },
  });
  await h.controller.runSettingsSelector();
  assert.deepEqual(h.briefUpdates, [true]);
  assert.deepEqual(h.themeUpdates, ["latte"]);
  assert.deepEqual(h.spinnerUpdates, ["bars"]);
  assert.equal(h.questions.length, 1);
  assert.equal(h.questions[0].title, "Import skills");
  assert.match(h.questions[0].message, /^Applying breaks the prompt cache\./);
  assert.match(h.questions[0].options[0], /^Cancel/, "cancel is the default");
  assert.deepEqual(h.commands.map(params => params.input), ["/import", "/import claude_user=off"]);
  assert.match(h.logs.join("\n"), /Skill imports updated/);
});

test("declining leaves the conversation's skills unchanged", async () => {
  const h = harness({ answer: "Cancel · keep the skills and the cache" });
  await h.controller.runSettingsSelector();
  assert.deepEqual(h.commands.map(params => params.input), ["/import"]);
});

test("before the first message the window keeps the choice and creates the conversation with it", async () => {
  const h = harness({ sessionId: "" });
  await h.controller.runSettingsSelector();
  assert.equal(h.questions.length, 0, "no cache to protect yet");
  assert.deepEqual(h.state.session.pendingSkillSources, { claude_user: false });
  await h.controller.request(methods.commandExecute, { input: "/skill" });
  assert.deepEqual(h.commands.at(-1).draft, { skill_sources: { claude_user: false } });
});
