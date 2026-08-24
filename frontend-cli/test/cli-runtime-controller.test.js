import test from "node:test";
import assert from "node:assert/strict";

import { createCliRuntimeController } from "../lib/cli-runtime-controller.js";
import { createCliState } from "../lib/cli-state.js";

const methods = {
  initialize: "initialize",
  modelList: "model/list",
  goalGet: "rind/goal/get",
  goalSet: "rind/goal/set",
  goalStatus: "rind/goal/status",
  goalClear: "rind/goal/clear",
  commandExecute: "rind/command/execute",
  sessionSwitch: "session/switch",
  sessionReplay: "session/replay",
  modelSet: "model/set",
};

function createHarness({ selectedSession = null, replayError = null, switchGate = null } = {}) {
  const state = createCliState();
  state.session.info = { session_id: "session-a", model: "model-a" };
  state.turn.id = "turn-a";
  const requests = [];
  const history = [];
  const client = {
    startCount: 0,
    child: null,
    start() {
      this.startCount += 1;
      this.child = {};
    },
    request(method, params) {
      requests.push({ method, params });
      if (method === methods.initialize) {
        return Promise.resolve({
          protocol_version: "2",
          capabilities: [],
          methods: [],
          session_id: "session-a",
        });
      }
      if (method === methods.commandExecute && params?.input === "/sessions 100") {
        return Promise.resolve({
          display: {
            sessions: [{ id: "session-b", title: "B" }],
            current_session_id: "session-a",
          },
        });
      }
      if (method === methods.sessionSwitch) {
        if (switchGate) {
          return switchGate.promise;
        }
        return Promise.resolve({
          session_id: params.session_id,
          workspace_root: "E:/workspace-b",
          model: "model-b",
          goal: null,
          usage: null,
          live_turn: null,
          resume_preview: "",
        });
      }
      if (method === methods.sessionReplay) {
        if (replayError) {
          return Promise.reject(replayError);
        }
        return Promise.resolve({
          session_id: params.session_id,
          model: "model-b-replayed",
          messages: [
            { role: "user", content: "previous prompt" },
            { role: "assistant", content: "previous answer" },
          ],
          live_turn: null,
        });
      }
      return Promise.resolve({});
    },
  };
  const commandController = {
    normalizeCommands: () => [],
    localCommands: () => [],
    applyResult: async () => {},
  };
  const controller = createCliRuntimeController({
    client,
    methods,
    sessionScopedMethods: new Set(["rind/session/steer"]),
    turnScopedMethods: new Set(["rind/session/steer"]),
    requireInitialization: (value) => value,
    state,
    getCommands: () => commandController,
    getTurnController: () => ({ submit() {} }),
    getTaskMonitor: () => null,
    getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => "",
    askSessionMenu: async () => selectedSession,
    restoreLiveTurn() {},
    renderHistory: (messages) => history.push(messages),
    clearPendingInputs() {},
    closeAssistant() {},
    refreshInputState() {},
    updateGoalState() {},
    log() {},
    writeError() {},
    redraw() {},
  });
  return { state, client, requests, history, controller };
}

test("runtime controller shares initialization and injects session and turn IDs", async () => {
  const harness = createHarness();
  await Promise.all([
    harness.controller.request("rind/session/steer", { input: "one" }),
    harness.controller.request("rind/session/steer", { input: "two" }),
  ]);
  await harness.controller.request(methods.modelList);

  assert.equal(harness.client.child !== null, true);
  assert.equal(harness.client.startCount, 1);
  assert.equal(harness.requests.filter((item) => item.method === methods.initialize).length, 1);
  const steering = harness.requests.filter((item) => item.method === "rind/session/steer");
  assert.deepEqual(steering.map((item) => item.params.session_id), ["session-a", "session-a"]);
  assert.deepEqual(steering.map((item) => item.params.turn_id), ["turn-a", "turn-a"]);
  assert.deepEqual(
    harness.requests.find((item) => item.method === methods.modelList)?.params.session_id,
    "session-a",
  );
});

test("session selector requests the full list and updates the active workspace", async () => {
  const harness = createHarness({ selectedSession: { id: "session-b" } });
  harness.state.turn.active = false;
  await harness.controller.runSessionsSelector();

  const listRequest = harness.requests.find((item) => item.method === methods.commandExecute);
  assert.equal(listRequest.params.input, "/sessions 100");
  assert.equal(harness.state.session.info.session_id, "session-b");
  assert.equal(harness.state.session.info.cwd, "E:/workspace-b");
  assert.equal(harness.state.session.info.workspace_root, "E:/workspace-b");
  assert.equal(harness.state.session.info.model, "model-b-replayed");
  assert.deepEqual(harness.history, [[
    { role: "user", content: "previous prompt" },
    { role: "assistant", content: "previous answer" },
  ]]);
  assert.equal(
    harness.requests.filter((item) => item.method === methods.sessionReplay)[0].params.session_id,
    "session-b",
  );
});

test("session restore replays the current session without switching", async () => {
  const harness = createHarness();
  harness.state.session.info.resume_preview = "old preview";
  await harness.controller.restoreSession();

  assert.equal(harness.requests.some((item) => item.method === methods.sessionSwitch), false);
  assert.equal(
    harness.requests.filter((item) => item.method === methods.sessionReplay)[0].params.session_id,
    "session-a",
  );
  assert.equal(harness.state.session.info.resume_preview, "");
  assert.equal(harness.history.length, 1);
});

test("session selector refuses to switch during an active turn", async () => {
  const harness = createHarness({ selectedSession: { id: "session-b" } });
  harness.state.turn.active = true;
  await harness.controller.runSessionsSelector();

  assert.equal(harness.requests.some((item) => item.method === methods.commandExecute), false);
  assert.equal(harness.state.session.info.session_id, "session-a");
});

test("session selector keeps the current state when replay fails", async () => {
  const harness = createHarness({
    selectedSession: { id: "session-b" },
    replayError: new Error("replay unavailable"),
  });
  await harness.controller.runSessionsSelector();

  assert.equal(harness.state.session.info.session_id, "session-a");
  assert.equal(harness.state.session.info.cwd, undefined);
});

test("session selector ignores an older concurrent switch response", async () => {
  const switchGate = deferred();
  const harness = createHarness({ selectedSession: { id: "session-b" }, switchGate });
  const first = harness.controller.runSessionsSelector();
  await waitForRequests(harness.requests, methods.sessionSwitch, 1);
  const second = harness.controller.runSessionsSelector();
  await waitForRequests(harness.requests, methods.sessionSwitch, 2);
  switchGate.resolve({ session_id: "session-b", workspace_root: "E:/workspace-b" });
  await Promise.all([first, second]);

  assert.equal(harness.history.length, 1);
  assert.equal(harness.state.session.info.session_id, "session-b");
});

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}

async function waitForRequests(requests, method, count) {
  while (requests.filter((item) => item.method === method).length < count) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
