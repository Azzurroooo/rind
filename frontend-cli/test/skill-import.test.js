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
import { resetMaxConcurrentRuns, resetSpinner, setMaxConcurrentRuns, setSpinner } from "../lib/cli-state-store.js";
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
    concurrency: 128,
    concurrencyChanged: false,
    importChoices: { claude_user: false },
  },
  answer = "Apply · change the skills and break the cache",
} = {}) {
  const state = createCliState();
  state.session.info = { session_id: sessionId, workspace_root: "/work" };
  const commands = [];
  const handledCommands = [];
  const questions = [];
  const logs = [];
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
    requireInitialization: value => value, state,
    getCommands: () => ({
      normalizeCommands: () => [],
      localCommands: () => [],
      handle: async (cmd) => { handledCommands.push(cmd); },
    }),
    getTaskMonitor: () => null, getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => null,
    askSettingsMenu: async () => selected,
    getBriefMode: () => false,
    askChoice: async (question) => { questions.push(question); return answer; },
    askSessionMenu: async () => null, askForkPointMenu: async () => null, restoreLiveTurn() {}, clearPendingInputs() {},
    closeAssistant() {}, refreshInputState() {}, updateGoalState() {}, log: value => logs.push(typeof value === "function" ? value() : value),
    writeError() {}, redraw() {},
  });
  return { state, controller, commands, handledCommands, questions, logs };
}

test("two-level /settings menu navigates between root settings and all five submenus", () => {
  resetTheme();
  resetSpinner();
  resetMaxConcurrentRuns();
  const menu = createSettingsMenuState({ brief: false, sources: SOURCES });
  assert.equal(menu.level(), "root");
  assert.equal(menu.changed(), false);

  // Enter Brief output submenu on root level (index 0)
  assert.equal(menu.handleKey({ name: "enter" }), "redraw");
  assert.equal(menu.level(), "brief");
  assert.equal(menu.selectedBrief().name, "off");
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedBrief().name, "on");
  // Esc in brief submenu reverts uncommitted selection and returns to root
  assert.equal(menu.handleKey({ name: "escape" }), "redraw");
  assert.equal(menu.level(), "root");
  assert.equal(menu.selectedIndex(), 0);
  assert.equal(menu.briefChanged(), false);

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
  assert.equal(menu.selectedIndex(), 3, "defaults to active orbit spinner");
  assert.equal(menu.selectedSpinner().name, "orbit");
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedSpinner().name, "sweep", "wraps from last to 1st option");
  assert.equal(menu.handleKey({ name: "escape" }), "redraw");
  assert.equal(menu.level(), "root");
  assert.equal(menu.selectedIndex(), 2);
  assert.equal(menu.spinnerChanged(), false);

  // Move to Max concurrent runs and enter Level 2 concurrency submenu
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedIndex(), 3);
  assert.equal(menu.handleKey({ name: "enter" }), "redraw");
  assert.equal(menu.level(), "concurrency");
  assert.equal(menu.selectedConcurrency().name, "128");
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedConcurrency().name, "256");
  assert.equal(menu.handleKey({ name: "escape" }), "redraw");
  assert.equal(menu.level(), "root");
  assert.equal(menu.selectedIndex(), 3);
  assert.equal(menu.concurrencyChanged(), false);

  // Move to Skill imports and enter Level 2 submenu
  assert.equal(menu.handleKey({ name: "down" }), "redraw");
  assert.equal(menu.selectedIndex(), 4);
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
  assert.equal(menu.selectedIndex(), 4);
  assert.deepEqual(menu.importChoices(), {});

  // Re-enter Level 2, toggle claude_user, and submit with Enter
  assert.equal(menu.handleKey({ name: "enter" }), "redraw");
  assert.equal(menu.level(), "import");
  assert.equal(menu.handleKey({ text: " " }), "redraw");
  assert.equal(menu.handleKey({ name: "enter" }), "submit");
  assert.deepEqual(menu.value(), {
    brief: false,
    briefChanged: false,
    theme: "frappe",
    themeChanged: false,
    spinner: "orbit",
    spinnerChanged: false,
    concurrency: 128,
    concurrencyChanged: false,
    importChoices: { claude_user: false },
  });
});

test("brief, theme, spinner, and concurrency submenus in /settings follow active state and wrap at edges", () => {
  resetTheme();
  resetSpinner();
  resetMaxConcurrentRuns();

  const briefMenu = createSettingsMenuState({ brief: false, initialLevel: "brief" });
  assert.equal(briefMenu.level(), "brief");
  assert.equal(briefMenu.selectedBrief().name, "off");
  assert.equal(briefMenu.handleKey({ name: "down" }), "redraw");
  assert.equal(briefMenu.selectedBrief().name, "on");
  assert.equal(briefMenu.handleKey({ name: "enter" }), "submit");
  assert.equal(briefMenu.value().brief, true);
  assert.equal(briefMenu.value().briefChanged, true);

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
  assert.equal(spinnerMenu.selectedSpinner().name, "sweep");
  assert.equal(spinnerMenu.handleKey({ name: "enter" }), "submit");
  assert.equal(spinnerMenu.value().spinner, "sweep");
  assert.equal(spinnerMenu.value().spinnerChanged, true);
  resetSpinner();

  setMaxConcurrentRuns(64);
  const concurrencyMenu = createSettingsMenuState({ initialLevel: "concurrency" });
  assert.equal(concurrencyMenu.level(), "concurrency");
  assert.equal(concurrencyMenu.selectedConcurrency().name, "64");
  assert.equal(concurrencyMenu.handleKey({ name: "down" }), "redraw");
  assert.equal(concurrencyMenu.selectedConcurrency().name, "128");
  assert.equal(concurrencyMenu.handleKey({ name: "enter" }), "submit");
  assert.equal(concurrencyMenu.value().concurrency, 128);
  assert.equal(concurrencyMenu.value().concurrencyChanged, true);
  resetMaxConcurrentRuns();
});

test("settingsMenuText renders root deck, brief, theme, spinner, concurrency, and skill imports submenus", () => {
  resetTheme();
  resetSpinner();
  resetMaxConcurrentRuns();
  const menu = createSettingsMenuState({ brief: false, sources: SOURCES });
  const rootLines = settingsMenuText(menu.items(), menu.selectedIndex(), menu.level()).split("\n");
  assert.match(rootLines[0], /Settings$/);
  assert.match(rootLines[1], /› Brief output .* off › .* Collapse consecutive tool calls into one live line/);
  assert.match(rootLines[2], /· Theme .* Frappé › .* Switch the CLI color theme/);
  assert.match(rootLines[3], /· Working spinner .* Orbit › .* Choose the working activity animation/);
  assert.match(rootLines[4], /· Concurrent runs .* 128 › .* Set the global parallel agent run limit/);
  assert.match(rootLines[5], /· Skill imports .* 3 of 4 on › .* Choose the Claude and Codex skills this conversation reads/);
  assert.match(rootLines[6], /↑↓ select · enter open · esc cancel/);

  menu.handleKey({ name: "enter" });
  const briefLines = settingsMenuText(menu.items(), menu.selectedIndex(), menu.level()).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  assert.match(briefLines[0], /Settings · Brief output/);
  assert.match(briefLines[1], /› Off\s+Show each tool call in full\s+current/);
  assert.match(briefLines[2], /· On\s+Collapse consecutive tool calls into one live line/);

  menu.handleKey({ name: "escape" });
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
  assert.match(spinnerLines[2], /· Pulse\s+░ ▒ ▓ █ ▓ ▒/);
  assert.match(spinnerLines[3], /· Bars\s+▁ ▂ ▃ ▄ ▅ ▆ ▇ █ ▇ ▆ ▅ ▄ ▃ ▂/);
  assert.match(spinnerLines[4], /› Orbit\s+◐ ◓ ◑ ◒\s+current/);

  menu.handleKey({ name: "escape" });
  menu.handleKey({ name: "down" });
  menu.handleKey({ name: "enter" });
  const concurrencyLines = settingsMenuText(menu.items(), menu.selectedIndex(), menu.level()).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  assert.match(concurrencyLines[0], /Settings · Max concurrent runs/);
  assert.match(concurrencyLines[6], /› 128\s+128 concurrent agent runs \(default\)\s+current/);

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
      concurrency: 256,
      concurrencyChanged: true,
      importChoices: { claude_user: false },
    },
  });
  await h.controller.runSettingsSelector();
  assert.deepEqual(h.handledCommands, [
    "/settings brief on",
    "/settings theme latte",
    "/settings spinner bars",
    "/settings concurrency 256",
  ]);
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
