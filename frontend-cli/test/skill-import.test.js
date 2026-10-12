// /import: a checklist of the Claude and Codex skill layers. Before the first
// message the window keeps the choice; afterwards it is applied only once the
// prompt-cache cost is accepted.
import test from "node:test";
import assert from "node:assert/strict";

import { createCliRuntimeController } from "../lib/cli-runtime-controller.js";
import { createCliState } from "../lib/cli-state.js";
import { skillImportMenuText } from "../lib/rendering.js";
import { runtimeMethods as methods } from "../lib/runtime-protocol.js";
import { createSkillImportMenuState } from "../lib/skill-import-menu-state.js";

const SOURCES = [
  { id: "claude_user", label: "Claude · user", paths: ["/home/u/.claude/skills"], count: 1, enabled: true },
  { id: "codex_user", label: "Codex · user", paths: ["/home/u/.codex/skills", "/home/u/.agents/skills"], count: 5, enabled: true },
  { id: "claude_project", label: "Claude · project", paths: ["/work/.claude/skills"], count: 0, enabled: false },
  { id: "codex_project", label: "Codex · project", paths: ["/work/.codex/skills", "/work/.agents/skills"], count: 0, enabled: true },
];

function harness({ sessionId = "s1", choices = { claude_user: false }, answer = "Apply · change the skills now" } = {}) {
  const state = createCliState();
  state.session.info = { session_id: sessionId, workspace_root: "/work" };
  const commands = [];
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
    requireInitialization: value => value, state, getCommands: () => ({ normalizeCommands: () => [], localCommands: () => [] }), getTaskMonitor: () => null, getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => null,
    askSkillImportMenu: async () => choices,
    askChoice: async (question) => { questions.push(question); return answer; },
    askSessionMenu: async () => null, askForkPointMenu: async () => null, restoreLiveTurn() {}, clearPendingInputs() {},
    closeAssistant() {}, refreshInputState() {}, updateGoalState() {}, log: value => logs.push(typeof value === "function" ? value() : value),
    writeError() {}, redraw() {},
  });
  return { state, controller, commands, questions, logs };
}

test("space toggles a layer, and only a real change counts", () => {
  const menu = createSkillImportMenuState(SOURCES);
  assert.equal(menu.changed(), false);
  menu.handleKey({ name: "down" });
  menu.handleKey({ text: " " });
  assert.deepEqual(menu.choices(), { claude_user: true, codex_user: false, claude_project: false, codex_project: true });
  menu.handleKey({ text: " " });
  assert.equal(menu.changed(), false);
  menu.handleKey({ name: "up" });
  menu.handleKey({ name: "up" });
  assert.equal(menu.selectedIndex(), 3, "the selection wraps");
});

test("the checklist shows each layer, its folders and how many skills it has", () => {
  const menu = createSkillImportMenuState(SOURCES);
  const lines = skillImportMenuText(menu.items(), 0).split("\n");
  assert.match(lines[0], /Import skills into this conversation/);
  assert.match(lines[1], /› \[x\] Claude · user .* 1 skill$/);
  assert.match(lines[2], /Codex · user .*\.codex.*\.agents.* 5 skills$/);
  assert.match(lines[3], /\[ \] Claude · project .* —$/);
  assert.match(lines[5], /space toggle · enter apply · esc cancel/);
});

test("in a conversation the change is applied after the cache cost is accepted", async () => {
  const h = harness();
  await h.controller.runImportSelector();
  assert.equal(h.questions.length, 1);
  assert.equal(h.questions[0].title, "Import skills");
  assert.match(h.questions[0].message, /cannot reuse the prompt cache/);
  assert.match(h.questions[0].options[0], /^Cancel/, "cancel is the default");
  assert.deepEqual(h.commands.map(params => params.input), ["/import", "/import claude_user=off"]);
  assert.match(h.logs.join("\n"), /Skill imports updated/);
});

test("declining leaves the conversation's skills unchanged", async () => {
  const h = harness({ answer: "Cancel · keep the current skills" });
  await h.controller.runImportSelector();
  assert.deepEqual(h.commands.map(params => params.input), ["/import"]);
});

test("before the first message the window keeps the choice and creates the conversation with it", async () => {
  const h = harness({ sessionId: "" });
  await h.controller.runImportSelector();
  assert.equal(h.questions.length, 0, "no cache to protect yet");
  assert.deepEqual(h.state.session.pendingSkillSources, { claude_user: false });
  await h.controller.request(methods.commandExecute, { input: "/skill" });
  assert.deepEqual(h.commands.at(-1).draft, { skill_sources: { claude_user: false } });
});
