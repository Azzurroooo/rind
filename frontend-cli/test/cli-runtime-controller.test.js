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
  sessionFork: "session/fork",
  sessionReplay: "session/replay",
  modelSet: "model/set",
};

const forkMenuMessages = [
  { id: "sys", role: "system", content: "sys" },
  { id: "u1", role: "user", ts: "2026-09-09T03:30:00+00:00", content: "first question" },
  { id: "a1", role: "assistant", content: "first answer" },
  { id: "u2", role: "user", ts: "2026-09-09T03:35:00+00:00", content: "second question" },
  { id: "a2", role: "assistant", content: "second answer" },
];

function createHarness({
  selectedSession = null,
  selectedFork = null,
  replayError = null,
  forkError = null,
  switchMismatch = false,
  switchGate = null,
} = {}) {
  const state = createCliState();
  state.session.info = { session_id: "session-a", model: "model-a" };
  state.turn.id = "turn-a";
  const requests = [];
  const history = [];
  const logs = [];
  const restored = [];
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
          session_id: switchMismatch ? "session-other" : params.session_id,
          workspace_root: "E:/workspace-b",
          model: "model-b",
          goal: null,
          usage: null,
          live_turn: null,
          resume_preview: "",
        });
      }
      if (method === methods.sessionFork) {
        if (forkError) {
          return Promise.reject(forkError);
        }
        return Promise.resolve({
          session_id: "session-fork-1",
          forked_from: params.session_id,
        });
      }
      if (method === methods.sessionReplay) {
        if (replayError) {
          return Promise.reject(replayError);
        }
        const messages = params.session_id === "session-a"
          ? forkMenuMessages
          : [
            { role: "user", content: "previous prompt" },
            { role: "assistant", content: "previous answer" },
          ];
        return Promise.resolve({
          session_id: params.session_id,
          model: "model-b-replayed",
          messages,
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
    sessionScopedMethods: new Set(["rind/session/steer", methods.sessionFork, methods.sessionReplay]),
    turnScopedMethods: new Set(["rind/session/steer"]),
    requireInitialization: (value) => value,
    state,
    getCommands: () => commandController,
    getTurnController: () => ({ submit() {} }),
    getTaskMonitor: () => null,
    getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => "",
    askSessionMenu: async () => selectedSession,
    askForkPointMenu: async () => selectedFork,
    restoreLiveTurn() {},
    renderHistory: (messages) => history.push(messages),
    onSessionRestored: () => restored.push(state.session.info.session_id),
    clearPendingInputs() {},
    closeAssistant() {},
    refreshInputState() {},
    updateGoalState() {},
    log: (value) => logs.push(typeof value === "function" ? value() : value),
    writeError() {},
    redraw() {},
  });
  return { state, client, requests, history, logs, restored, controller };
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

test("goal control does not submit a duplicate prompt", async () => {
  const harness = createHarness();
  await harness.controller.runGoalCommand({ action: "set", objective: "ship it" });

  assert.equal(harness.requests.some((item) => item.method === "session/prompt"), false);
  assert.equal(harness.state.turn.active, false);
  assert.equal(
    harness.requests.filter((item) => item.method === methods.goalSet).length,
    1,
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

test("fork selector forks at the current end and switches without prefill", async () => {
  const harness = createHarness({ selectedFork: { id: "", label: "Fork at current end (keep full history)" } });
  await harness.controller.runForkSelector();

  const forkRequest = harness.requests.find((item) => item.method === methods.sessionFork);
  assert.deepEqual(forkRequest.params, { session_id: "session-a" });
  assert.equal(harness.state.session.info.session_id, "session-fork-1");
  assert.equal(harness.state.input.prefill, "");
  assert.ok(harness.logs.some((line) => line.includes("Forked session-fork-1 ← session-a (kept all 5 messages)")));
  assert.equal(harness.history.length, 1);
});

test("fork selector truncates before the chosen message and prefills its text", async () => {
  const harness = createHarness({ selectedFork: { id: "u2", label: "03:35 · second question", text: "second question" } });
  await harness.controller.runForkSelector();

  const forkRequest = harness.requests.find((item) => item.method === methods.sessionFork);
  assert.equal(forkRequest.params.before_message_id, "u2");
  assert.equal(forkRequest.params.session_id, "session-a");
  assert.equal(harness.state.session.info.session_id, "session-fork-1");
  assert.equal(harness.state.input.prefill, "second question");
  assert.ok(harness.logs.some((line) => line.includes("kept the first 3 of 5 messages")));
});

test("fork selector refuses during an active turn", async () => {
  const harness = createHarness({ selectedFork: { id: "" } });
  harness.state.turn.active = true;
  await harness.controller.runForkSelector();

  assert.equal(harness.requests.length, 0);
  assert.equal(harness.state.session.info.session_id, "session-a");
  assert.deepEqual(harness.logs, ["Cannot fork while a turn is running. Wait for it to finish or stop it first."]);
});

test("fork selector refuses delegated and empty sessions", async () => {
  const delegated = createHarness();
  delegated.state.session.info.session_type = "delegated_task";
  await delegated.controller.runForkSelector();
  assert.deepEqual(delegated.logs, ["Delegated task sessions cannot be forked."]);

  const empty = createHarness();
  empty.client.request = (method, params) => {
    if (method === methods.sessionReplay) {
      return Promise.resolve({ session_id: params.session_id, messages: [{ role: "system", content: "sys" }] });
    }
    return Promise.resolve({});
  };
  await empty.controller.runForkSelector();
  assert.deepEqual(empty.logs, ["Nothing to fork: this session has no messages yet."]);
});

test("fork selector cancel leaves state untouched", async () => {
  const harness = createHarness({ selectedFork: null });
  await harness.controller.runForkSelector();

  assert.equal(harness.requests.some((item) => item.method === methods.sessionFork), false);
  assert.equal(harness.state.session.info.session_id, "session-a");
});

test("fork selector reports fork failures without switching", async () => {
  const harness = createHarness({ selectedFork: { id: "" }, forkError: new Error("Nothing to fork") });
  await harness.controller.runForkSelector();

  assert.equal(harness.state.session.info.session_id, "session-a");
  assert.ok(harness.logs.some((line) => line.includes("Fork failed: Nothing to fork")));
});

test("fork selector keeps the fork reachable when switching fails", async () => {
  const harness = createHarness({ selectedFork: { id: "" }, switchMismatch: true });
  await harness.controller.runForkSelector();

  assert.equal(harness.state.session.info.session_id, "session-a");
  assert.ok(harness.logs.some((line) => line.includes("Forked to session-fork-1, but switching failed")));
});

test("session restore notifies once with the restored session id", async () => {
  const harness = createHarness({ selectedSession: { id: "session-b" } });
  harness.state.turn.active = false;
  await harness.controller.runSessionsSelector();

  assert.deepEqual(harness.restored, ["session-b"]);
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
