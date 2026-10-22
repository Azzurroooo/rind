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
  sessionCompact: "rind/session/compact",
  sessionCreate: "session/create",
  sessionPrompt: "session/prompt",
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
  taskMonitor = null,
  openManagedSession = null,
  replay = null,
} = {}) {
  const state = createCliState();
  state.session.info = { session_id: "session-a", model: "model-a" };
  state.turn.id = "turn-a";
  const requests = [];
  const history = [];
  const notices = [];
  let cleared = 0;
  const logs = [];
  const levels = [];
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
        if (replay) {
          return Promise.resolve(replay(params));
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
    sessionScopedMethods: new Set(["rind/session/steer", methods.sessionPrompt, methods.sessionFork, methods.sessionReplay]),
    turnScopedMethods: new Set(["rind/session/steer"]),
    requireInitialization: (value) => value,
    state,
    getCommands: () => commandController,
    getTurnController: () => ({ submit() {} }),
    getTaskMonitor: () => taskMonitor,
    getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => "",
    askSessionMenu: async () => selectedSession,
    askForkPointMenu: async () => selectedFork,
    restoreLiveTurn() {},
    renderHistory: (messages, options = {}) => { history.push(messages); notices.push(options.notice || ""); },
    clearTranscript: () => { cleared += 1; },
    onSessionRestored: () => restored.push(state.session.info.session_id),
    openManagedSession,
    clearPendingInputs() {},
    closeAssistant() {},
    refreshInputState() {},
    updateGoalState() {},
    log: (value) => logs.push(typeof value === "function" ? value() : value),
    notify: (text, opts) => {
      logs.push(text);
      levels.push(opts?.level ?? "info");
    },
    redraw() {},
  });
  return { state, client, requests, history, notices, logs, levels, restored, controller, cleared: () => cleared };
}

test("managed history opens separately and leaves the current conversation intact", async () => {
  const opened = [];
  const harness = createHarness({ selectedSession: { id: "session-b" }, openManagedSession: async (...args) => opened.push(args) });
  await harness.controller.runSessionsSelector();
  assert.deepEqual(opened, [["session-b"]]);
  assert.equal(harness.state.session.info.session_id, "session-a");
  assert.equal(harness.requests.some(request => request.method === methods.sessionSwitch), false);
});

test("managed forks open separately with editable input and preserve the source session", async () => {
  const opened = [];
  const harness = createHarness({ selectedFork: { id: "u2", text: "Revise this request" }, openManagedSession: async (...args) => opened.push(args) });
  await harness.controller.runForkSelector();
  assert.deepEqual(opened, [["session-fork-1", "Revise this request"]]);
  assert.equal(harness.state.session.info.session_id, "session-a");
  assert.equal(harness.requests.some(request => request.method === methods.sessionSwitch), false);
});

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

test("compact response cannot clear an ongoing queued turn or launch duplicate compact", async () => {
  const h = createHarness();
  h.state.runtime.status = "ready";
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  h.client.request = (method) => {
    assert.equal(method, methods.sessionCompact);
    calls += 1;
    return gate;
  };
  h.controller.startCompactCommand();
  h.controller.startCompactCommand();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(h.state.display.activeCompact, true);
  h.state.display.activeCompact = false;
  h.state.display.activityLabel = "Working";
  h.state.turn.active = true;
  h.state.turn.interruptRequested = true;
  finish({id: "compact-1"});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.turn.active, true);
  assert.equal(h.state.turn.interruptRequested, true);
  assert.equal(h.state.display.activityLabel, "Working");
});

test("session restore retains Team identity and switching replaces or clears it", async () => {
  const harness = createHarness();
  const team = { agent_id: "coordinator", project_name: "Team A" };
  harness.state.session.info.team_main = team;
  await harness.controller.restoreSession();
  assert.deepEqual(harness.state.session.info.team_main, team);
  await harness.controller.restoreSession("session-b", { switchSession: true });
  assert.equal(harness.state.session.info.team_main, null);

  const request = harness.client.request.bind(harness.client);
  const other = { agent_id: "lead", project_name: "Team B" };
  harness.client.request = (method, params) => method === methods.sessionSwitch
    ? Promise.resolve({ session_id: params.session_id, team_main: other })
    : request(method, params);
  await harness.controller.restoreSession("session-c", { switchSession: true });
  assert.deepEqual(harness.state.session.info.team_main, other);
});

test("initialization supplies Team identity and workspace before the startup banner", async () => {
  const harness = createHarness();
  const team = { agent_id: "lead", project_name: "Team" };
  const request = harness.client.request.bind(harness.client);
  harness.client.request = async (method, params) => {
    const result = await request(method, params);
    return method === methods.initialize
      ? { ...result, team_main: team, workspace_root: "E:/team/agents/lead" }
      : result;
  };
  const info = await harness.controller.ensureRuntime();
  assert.deepEqual(info.team_main, team);
  assert.equal(info.cwd, "E:/team/agents/lead");
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

test("a long conversation opens on its newest messages and /history loads the older page", async () => {
  const all = Array.from({ length: 500 }, (_, index) => ({ id: "m" + index, role: index % 2 ? "assistant" : "user", content: "message " + index }));
  const harness = createHarness({ replay: params => ({
    session_id: params.session_id,
    model: "m",
    messages: typeof params.tail === "number" ? all.slice(-params.tail) : all.slice(params.start || 0),
    message_total: all.length,
    live_turn: null,
  }) });

  await harness.controller.restoreSession();
  const initial = harness.requests.find(item => item.method === methods.sessionReplay);
  assert.equal(initial.params.tail, 200, "only the newest messages are loaded");
  assert.equal(harness.history.at(-1).length, 200);
  assert.equal(harness.state.display.history.start, 300);
  assert.match(harness.notices.at(-1), /300 earlier messages hidden/);
  assert.match(harness.notices.at(-1), /\/history loads more/);

  await harness.controller.runHistoryLoader();
  assert.deepEqual(harness.requests.filter(item => item.method === methods.sessionReplay).at(-1).params, { session_id: "session-a", start: 100 });
  assert.equal(harness.history.at(-1).length, 400);
  assert.equal(harness.state.display.history.start, 100);
  assert.match(harness.notices.at(-1), /100 earlier messages hidden/);
  assert.equal(harness.cleared(), 1, "the transcript is rebuilt from the wider range");

  await harness.controller.runHistoryLoader();
  assert.deepEqual(harness.requests.filter(item => item.method === methods.sessionReplay).at(-1).params, { session_id: "session-a", start: 0 });
  assert.equal(harness.history.at(-1).length, 500);
  assert.equal(harness.state.display.history.start, 0);
  assert.equal(harness.notices.at(-1), "", "no notice once the whole conversation is shown");
});

test("session restore waits for all monitor pages before returning", async () => {
  let finish;
  const monitor = { clearCount: 0, clear() { this.clearCount += 1; },
    refresh: () => new Promise((resolve) => { finish = resolve; }),
    recordTask() {} };
  const harness = createHarness({ taskMonitor: monitor });
  let restored = false;
  const pending = harness.controller.restoreSession().then(() => { restored = true; });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restored, false);
  assert.equal(monitor.clearCount, 1);
  finish();
  await pending;
  assert.equal(restored, true);
});

test("session replay restores authoritative waiting state and clears it on switch", async () => {
  const h = createHarness();
  const request = h.client.request;
  const waiting = { count: 1, started_at: 123 };
  h.client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === methods.sessionReplay && params.session_id === "session-a") {
      return { ...result, background_wait: waiting };
    }
    return result;
  };
  await h.controller.restoreSession();
  assert.deepEqual(h.state.display.backgroundWait, waiting);
  await h.controller.restoreSession("session-b", { switchSession: true });
  assert.equal(h.state.display.backgroundWait, null);
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
  assert.deepEqual(harness.levels, ["warning"]);
});

test("fork selector refuses delegated and empty sessions", async () => {
  const delegated = createHarness();
  delegated.state.session.info.session_type = "delegated_task";
  await delegated.controller.runForkSelector();
  assert.deepEqual(delegated.logs, ["Delegated task sessions cannot be forked."]);
  assert.deepEqual(delegated.levels, ["warning"]);

  const empty = createHarness();
  empty.client.request = (method, params) => {
    if (method === methods.sessionReplay) {
      return Promise.resolve({ session_id: params.session_id, messages: [{ role: "system", content: "sys" }] });
    }
    return Promise.resolve({});
  };
  await empty.controller.runForkSelector();
  assert.deepEqual(empty.logs, ["Nothing to fork: this session has no messages yet."]);
  assert.deepEqual(empty.levels, ["info"]);
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
  assert.deepEqual(harness.levels, ["error"]);
});

test("fork selector keeps the fork reachable when switching fails", async () => {
  const harness = createHarness({ selectedFork: { id: "" }, switchMismatch: true });
  await harness.controller.runForkSelector();

  assert.equal(harness.state.session.info.session_id, "session-a");
  assert.ok(harness.logs.some((line) => line.includes("Forked to session-fork-1, but switching failed")));
  assert.deepEqual(harness.levels, ["error"]);
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

test("an initial restore cannot resurrect a deleted conversation", async () => {
  const gate = deferred();
  const harness = createHarness({ replay: () => gate.promise });
  await harness.controller.ensureRuntime();
  const loading = harness.controller.restoreSession();
  await waitForRequests(harness.requests, methods.sessionReplay, 1);
  harness.controller.sessionDeleted("session-a");
  gate.resolve({ session_id: "session-a", messages: forkMenuMessages });
  assert.equal(await loading, false);
  assert.equal(harness.state.session.info.session_id, "");
  assert.equal(harness.history.length, 0);
});

test("a newer switch invalidates an in-flight initial restore", async () => {
  const gate = deferred();
  const harness = createHarness({ replay: params => params.session_id === "session-a"
    ? gate.promise : { session_id: params.session_id, messages: [] } });
  await harness.controller.ensureRuntime();
  const loading = harness.controller.restoreSession();
  await waitForRequests(harness.requests, methods.sessionReplay, 1);
  assert.equal(await harness.controller.restoreSession("session-b", { switchSession: true }), true);
  gate.resolve({ session_id: "session-a", messages: forkMenuMessages });
  assert.equal(await loading, false);
  assert.equal(harness.state.session.info.session_id, "session-b");
  assert.equal(harness.history.length, 1);
});

for (const changed of ["session", "turn", "history", "completed turn", "event sequence"]) {
  test(`/history cannot overwrite the transcript after ${changed} changes`, async () => {
    const gate = deferred();
    const harness = createHarness({ replay: () => gate.promise });
    await harness.controller.ensureRuntime();
    harness.state.display.history = { sessionId: "session-a", start: 400, total: 600 };
    const before = harness.cleared();
    const loading = harness.controller.runHistoryLoader();
    await waitForRequests(harness.requests, methods.sessionReplay, 1);
    if (changed === "session") harness.state.session.info.session_id = "session-b";
    if (changed === "turn") harness.state.turn.active = true;
    if (changed === "history") harness.state.display.history = { sessionId: "session-a", start: 200, total: 600 };
    if (changed === "completed turn") harness.state.display.lastTurnId = "new-finished-turn";
    if (changed === "event sequence") harness.state.display.lastEventSequence += 1;
    gate.resolve({ messages: [{ role: "user", content: "old history" }], message_total: 600 });
    await loading;
    assert.equal(harness.cleared(), before);
  });
}

test("deleting the current conversation clears its reserved identity before the next prompt", async () => {
  const harness = createHarness();
  await harness.controller.ensureRuntime();
  harness.state.session.reservedId = "session-a";
  harness.state.session.pendingName = "old name";
  harness.state.turn.active = true;
  harness.state.display.pendingDelegations.set("task-a", { sessionId: "session-a" });
  harness.controller.sessionDeleted("another-session");
  assert.equal(harness.state.session.info.session_id, "session-a");
  harness.controller.sessionDeleted("session-a");
  assert.equal(harness.state.session.reservedId, "");
  assert.equal(harness.state.session.pendingName, "");
  assert.equal(harness.state.turn.active, false);
  assert.equal(harness.state.turn.id, "");
  assert.equal(harness.state.display.pendingDelegations.size, 0);
  const original = harness.client.request.bind(harness.client);
  harness.client.request = (method, params) => method === methods.sessionCreate
    ? (harness.requests.push({ method, params }), Promise.resolve({ session_id: "fresh-id" }))
    : original(method, params);
  await harness.controller.request(methods.sessionPrompt, { input: "new question" });
  assert.equal(harness.requests.find(item => item.method === methods.sessionCreate).params.session_id, undefined);
  assert.equal(harness.requests.at(-1).params.session_id, "fresh-id");
});

async function waitForRequests(requests, method, count) {
  while (requests.filter((item) => item.method === method).length < count) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a name chosen before the first message goes with the conversation it creates", async () => {
  const harness = createHarness();
  await harness.controller.ensureRuntime();
  harness.state.session.info = { ...harness.state.session.info, session_id: "" };
  const original = harness.client.request.bind(harness.client);
  harness.client.request = (method, params) => method === methods.sessionCreate
    ? (harness.requests.push({ method, params }), Promise.resolve({ session_id: "created-1", model: "model-a" }))
    : original(method, params);
  assert.match((await harness.controller.runRename("")).text, /first message/);
  assert.match((await harness.controller.runRename("Release   notes")).text, /Will be named: Release notes/);
  assert.equal(harness.requests.some(item => item.method === methods.commandExecute), false, "nothing to rename in the Runtime yet");
  await harness.controller.request(methods.sessionPrompt, { input: "hello" });
  const create = harness.requests.find(item => item.method === methods.sessionCreate);
  assert.equal(create.params.name, "Release notes");
  assert.equal(harness.state.session.info.session_id, "created-1", "later requests use the created conversation");
  assert.equal(harness.requests.at(-1).method, methods.sessionPrompt, "the prompt follows its creation");

  await harness.controller.runRename("Shipped");
  assert.deepEqual(harness.requests.at(-1), { method: methods.commandExecute, params: { input: "/rename Shipped" } }, "once it exists, the conversation renames itself");
});

test("commands sent before the first message carry what the window has chosen", async () => {
  const harness = createHarness();
  await harness.controller.ensureRuntime();
  harness.state.session.info = { workspace_root: "/w", provider: "longcat", model: "longcat-flash", reasoning_effort: "low" };
  harness.state.session.pendingName = "Spike";
  await harness.controller.request(methods.commandExecute, { input: "/status" });
  const sent = harness.requests.find(item => item.method === methods.commandExecute).params;
  assert.deepEqual(sent.draft, { name: "Spike", provider: "longcat", model: "longcat-flash", reasoning_effort: "low" });
  // Once the conversation exists it is the source of truth.
  harness.state.session.info = { session_id: "session-a" };
  await harness.controller.request(methods.commandExecute, { input: "/status" });
  assert.equal(harness.requests.filter(item => item.method === methods.commandExecute).at(-1).params.draft, undefined);
});

test("model and effort results say when the change applies", async () => {
  const { appliesNote } = await import("../lib/cli-runtime-controller.js");
  assert.equal(appliesNote({ applies: "next_turn" }), "applies from the next turn; this turn keeps its model");
  assert.equal(appliesNote({ applies: "now" }), "applies to your next message");
  assert.equal(appliesNote({}), "applies to your next message", "older hosts do not say; nothing runs then");
});

test("switching sessions replaces the conversation on screen; the first restore keeps the startup banner", async () => {
  const harness = createHarness();
  await harness.controller.restoreSession();
  assert.equal(harness.cleared(), 0);
  await harness.controller.restoreSession("session-b", { switchSession: true });
  assert.equal(harness.cleared(), 1);
});

test("/history in a new-window conversation reports whole conversation shown after first message", async () => {
  const harness = createHarness();
  await harness.controller.ensureRuntime();
  harness.state.session.info = { session_id: "", model: "model-a" };
  harness.state.display.history = null;
  await harness.controller.runHistoryLoader();
  assert.equal(harness.logs.at(-1), "/history needs a conversation. Send your first message to start one.");
  assert.equal(harness.levels.at(-1), "warning");

  harness.state.session.info = { session_id: "created-1", model: "model-a" };
  await harness.controller.runHistoryLoader();
  assert.equal(harness.logs.at(-1), "The whole conversation is shown.");
  assert.equal(harness.levels.at(-1), "info");
});

test("/model set before the first message updates the window model and carries it to session/create", async () => {
  const harness = createHarness();
  await harness.controller.ensureRuntime();
  harness.state.session.info = { session_id: "", provider: "openai", model: "model-a" };
  await harness.controller.runModelCommand("invalid");
  assert.equal(harness.logs.at(-1), "Usage: /model or /model set <model>");
  assert.equal(harness.levels.at(-1), "warning");

  await harness.controller.runModelCommand("set model-b");
  assert.equal(harness.state.session.info.model, "model-b");
  assert.match(harness.logs.at(-1), /Session model updated/);
  assert.equal(harness.levels.at(-1), "info");
});

test("command controller reports usage for local commands with extra arguments instead of unknown command", async () => {
  const { createCommandController } = await import("../lib/command-controller.js");
  const logs = [];
  const levels = [];
  const backendCalls = [];
  const controller = createCommandController({
    request: async (method, params) => { backendCalls.push({ method, params }); return {}; },
    turn: { submit() {} },
    input: { isTerminal: true, runHistoryLoader: async () => {}, runForkSelector: async () => {} },
    output: {
      notify: (value, opts) => {
        logs.push(value);
        levels.push(opts?.level ?? "info");
      },
    },
  });

  await controller.handle("/history extra");
  await controller.handle("/fork extra");
  await controller.handle("/exit extra");
  await controller.handle("/login p1 p2");
  assert.deepEqual(logs, [
    "Usage: /history",
    "Usage: /fork",
    "Usage: /exit",
    "Usage: /login [provider]",
  ]);
  assert.deepEqual(levels, ["warning", "warning", "warning", "warning"]);
  assert.equal(backendCalls.length, 0);
});

