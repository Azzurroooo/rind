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
  modelSet: "model/set",
};

function createHarness() {
  const state = createCliState();
  state.session.info = { session_id: "session-a", model: "model-a" };
  state.turn.id = "turn-a";
  const requests = [];
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
      return Promise.resolve({});
    },
  };
  const commandController = {
    normalizeCommands: () => [],
    localCommands: () => [],
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
    askSessionMenu: async () => null,
    restoreLiveTurn() {},
    refreshInputState() {},
    updateGoalState() {},
    log() {},
    writeError() {},
    redraw() {},
  });
  return { state, client, requests, controller };
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
