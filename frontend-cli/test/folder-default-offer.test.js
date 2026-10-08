// After /model or /effort the window offers to make the choice the folder's
// default for new conversations; Ctrl+T never asks.
import test from "node:test";
import assert from "node:assert/strict";

import { createCliRuntimeController } from "../lib/cli-runtime-controller.js";
import { createCliState } from "../lib/cli-state.js";
import { runtimeMethods as methods } from "../lib/runtime-protocol.js";

const MODELS = [
  { provider_id: "deepseek", id: "deepseek-flash", reasoning_efforts: ["low", "high", "max"] },
  { provider_id: "deepseek", id: "deepseek-v4-pro", reasoning_efforts: ["low", "high", "max"] },
];

function harness({ answer = "No · only this conversation", folder = {}, askChoice = true } = {}) {
  const state = createCliState();
  state.session.info = { session_id: "s1", workspace_root: "/work/app", provider: "deepseek", model: "deepseek-flash", reasoning_effort: "low" };
  const requests = [];
  const questions = [];
  const logs = [];
  const client = {
    child: {},
    start() {},
    async request(method, params) {
      requests.push([method, params]);
      if (method === methods.initialize) return { protocol_version: "2", capabilities: [], methods: [], session_id: "s1" };
      if (method === methods.modelList) return { models: MODELS };
      if (method === methods.modelSet) return { provider_id: params.provider_id, model_id: params.model_id, applies: "now" };
      if (method === methods.folderDefaultsGet) return { folder };
      return {};
    },
  };
  const controller = createCliRuntimeController({
    client, methods, sessionScopedMethods: new Set([methods.modelSet, methods.modelEffortSet]), turnScopedMethods: new Set(),
    requireInitialization: value => value, state, getCommands: () => ({ normalizeCommands: () => [], localCommands: () => [] }), getTaskMonitor: () => null, getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => ({ providerId: "deepseek", modelId: "deepseek-v4-pro" }),
    askEffortMenu: async () => "high",
    askChoice: askChoice ? async (title, options) => { questions.push({ title, options }); return answer; } : null,
    askSessionMenu: async () => null, askForkPointMenu: async () => null, restoreLiveTurn() {}, clearPendingInputs() {},
    closeAssistant() {}, refreshInputState() {}, updateGoalState() {}, log: value => logs.push(typeof value === "function" ? value() : value),
    writeError() {}, redraw() {},
  });
  const sets = () => requests.filter(([method]) => method === methods.folderDefaultsSet).map(([, params]) => params);
  return { state, controller, questions, logs, sets };
}

test("/model asks once whether new conversations in this folder start with the same model", async () => {
  const h = harness({ answer: "Yes · new conversations here start with deepseek / deepseek-v4-pro" });
  await h.controller.runModelSelector();
  assert.equal(h.questions.length, 1);
  assert.equal(h.questions[0].title, "Also the default for new conversations in this folder?");
  assert.equal(h.questions[0].options.length, 2, "only this conversation, or this folder; never every folder");
  assert.deepEqual(h.sets(), [{ workspace_root: "/work/app", provider_id: "deepseek", model_id: "deepseek-v4-pro" }]);
  assert.match(h.logs.join("\n"), /open ones keep theirs/);
});

test("declining keeps the change to this conversation", async () => {
  const h = harness();
  await h.controller.runModelSelector();
  assert.equal(h.state.session.info.model, "deepseek-v4-pro");
  assert.deepEqual(h.sets(), []);
});

test("/effort asks about the effort only", async () => {
  const h = harness({ answer: "Yes · new conversations here start with effort high" });
  await h.controller.runEffortCommand();
  assert.deepEqual(h.sets(), [{ workspace_root: "/work/app", reasoning_effort: "high" }]);
});

test("nothing is asked when the folder already has that default, or without a terminal UI", async () => {
  const same = harness({ folder: { provider: "deepseek", model: "deepseek-v4-pro" } });
  await same.controller.runModelSelector();
  assert.equal(same.questions.length, 0);
  const script = harness({ askChoice: false });
  await script.controller.runEffortCommand("max");
  assert.equal(script.state.session.info.reasoning_effort, "max");
  assert.deepEqual(script.sets(), []);
});

test("before the first message the choice is kept for the conversation and still offered for the folder", async () => {
  const h = harness({ answer: "Yes · new conversations here start with effort high" });
  h.state.session.info = { ...h.state.session.info, session_id: "" };
  await h.controller.runEffortCommand();
  assert.equal(h.state.session.info.reasoning_effort, "high");
  assert.deepEqual(h.sets(), [{ workspace_root: "/work/app", reasoning_effort: "high" }]);
});
