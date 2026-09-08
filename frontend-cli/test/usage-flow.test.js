import assert from "node:assert/strict";
import test from "node:test";

import { createVirtualOutput, createVirtualInput } from "./helpers/virtual-terminal.js";
import { createTui } from "../lib/tui/tui.js";
import { Container } from "../lib/tui/component.js";
import { ComposerArea } from "../lib/components/composer-area.js";
import { MonitorStack } from "../lib/components/monitor-stack.js";
import { createCliOutputController } from "../lib/cli-output-controller.js";
import { createCliState } from "../lib/cli-state.js";
import { createEventController } from "../lib/event-controller.js";
import { createCommandController } from "../lib/command-controller.js";
import { createCliRuntimeController } from "../lib/cli-runtime-controller.js";
import { createLineEditor } from "../lib/line-editor.js";
import { contextBreakdownText, promptPlaceholderText } from "../lib/rendering.js";
import {
  requireRuntimeInitialization,
  runtimeMethods,
  sessionScopedMethods,
  turnScopedMethods,
} from "../lib/runtime-protocol.js";

const CONTEXT_STATS = {
  message_count: 12,
  estimated_input_tokens: 62400,
  system_tokens: 6300,
  rind_docs_tokens: 1200,
  skill_catalog_tokens: 900,
  conversation_tokens: 38100,
  tool_tokens: 12600,
  context_window_tokens: 200000,
  context_usage_percent: 0.312,
  auto_compact_token_limit: 180000,
};

const SAMPLING_STATS = {
  sampling_kind: "assistant",
  input_tokens: 62000,
  cached_input_tokens: 58000,
  cache_hit_rate: 0.93,
  output_tokens: 1800,
  reasoning_output_tokens: 400,
  total_tokens: 63800,
  context_window_tokens: 200000,
  context_usage_percent: 0.31,
};

function createHarness({ columns = 80, rows = 24 } = {}) {
  const virtual = createVirtualOutput({ columns, rows });
  const input = createVirtualInput();
  const tui = createTui({
    input,
    output: virtual.output,
    renderIntervalMs: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
  });
  const state = createCliState();
  state.runtime.status = "idle";
  state.session.info = { session_id: "session-a", model: "test-model", cwd: "/tmp/proj" };

  const requests = [];
  const client = {
    child: {},
    start() {},
    request(method, params) {
      requests.push({ method, params });
      if (method === runtimeMethods.initialize) {
        return Promise.resolve({
          protocol_version: "2",
          capabilities: ["rind/commands"],
          methods: [],
          session_id: "session-a",
          model: "test-model",
        });
      }
      if (method === runtimeMethods.sessionSwitch) {
        return Promise.resolve({
          session_id: params.session_id,
          workspace_root: "/tmp/proj",
          model: "test-model",
          goal: null,
          usage: null,
          token_totals: params.session_id === "session-forked"
            ? { input_tokens: 500, samplings: 4 }
            : null,
          live_turn: null,
        });
      }
      if (method === runtimeMethods.sessionReplay) {
        return Promise.resolve({
          session_id: params.session_id,
          model: "test-model",
          messages: params.session_id === "session-forked"
            ? [
              { role: "user", content: "earlier prompt" },
              { role: "assistant", content: "earlier answer" },
            ]
            : [],
        });
      }
      if (method === runtimeMethods.sessionFork) {
        return Promise.resolve({ session_id: "session-forked", parent_session_id: "session-a" });
      }
      return Promise.resolve({});
    },
  };
  const commandControllerRef = {};
  const runtimeController = createCliRuntimeController({
    client,
    methods: runtimeMethods,
    sessionScopedMethods,
    turnScopedMethods,
    requireInitialization: requireRuntimeInitialization,
    state,
    getCommands: () => commandControllerRef.controller,
    getTaskMonitor: () => null,
    getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => "",
    askSessionMenu: async () => null,
    restoreLiveTurn() {},
    renderHistory: (messages) => output.renderHistory(messages),
    clearPendingInputs() {},
    closeAssistant: () => output.closeAssistant(),
    refreshInputState: () => output.refreshInputState(),
    updateGoalState() {},
    log: (text) => output.log(text),
    writeError: (text) => output.writeError(text),
    redraw: () => output.redraw(),
  });

  const transcriptContainer = new Container();
  const composerArea = new ComposerArea((width) => {
    if (!composerSession) {
      return null;
    }
    return {
      prompt: output.mainPromptText(width),
      inputText: composerSession.editor.input(),
      cursor: composerSession.editor.cursorPosition(),
      placeholder: promptPlaceholderText(),
      menuText: "",
    };
  });
  tui.addChild(transcriptContainer);
  tui.addChild(new MonitorStack({
    composer: composerArea,
    monitor: { isMonitoring: () => false, frame: () => null },
    rows: () => tui.rows,
  }));
  const output = createCliOutputController({ state, terminalUi: tui, transcript: transcriptContainer });
  let composerSession = null;

  const eventController = createEventController({
    state: {
      get runtimeClosing() {
        return state.runtime.status === "closing";
      },
      get activeTurn() {
        return state.turn.active;
      },
      get activeGoal() {
        return state.session.info.goal;
      },
      activityElapsedMs: () => (state.display.activityStartedAt
        ? Date.now() - state.display.activityStartedAt
        : 0),
      debug: false,
    },
    input: {},
    monitor: {},
    output: {
      assistantAppend: (...args) => output.assistantAppend(...args),
      beginTool: (...args) => output.beginTool(...args),
      updateToolProgress: (...args) => output.updateToolProgress(...args),
      finishTool: (...args) => output.finishTool(...args),
      handleContextBuilt: (event) => compactContext.handleContextBuilt(event),
      resetContextUsage: () => resetContextUsage(),
      setStats: (stats) => {
        state.display.stats = stats;
      },
      setContextStats: (stats) => {
        state.display.contextStats = stats;
      },
      setLastTurnUsage: (usage) => {
        state.display.lastTurnUsage = usage;
      },
      closeAssistant: () => output.closeAssistant(),
      log: (text) => output.log(text),
      setActivityLabel: (...args) => output.setActivityLabel(...args),
      redraw: () => output.redraw(),
      clearCompactContext: () => compactContext.clear(),
      deliverQueuedInput() {},
      clearQueuedInputs() {},
    },
  });
  const compactContext = {
    handleContextBuilt: () => false,
    clear() {},
  };
  function resetContextUsage() {
    state.display.stats = {};
  }

  let sequence = 0;
  async function deliver(event, turnId = "turn-1") {
    if (event.type === "turn_started") {
      state.turn.id = turnId;
      state.turn.active = true;
      state.display.activityLabel = "Working";
      state.display.activityStartedAt = Date.now() - 72_000;
    }
    sequence += 1;
    await eventController.handle({
      kind: "event",
      method: "session/update",
      sequence,
      durability: "durable",
      session_id: state.session.info.session_id,
      turn_id: turnId,
      event,
    });
    if (["turn_completed", "turn_failed", "turn_cancelled"].includes(event.type)) {
      state.turn.id = "";
      state.turn.active = false;
      state.display.activityLabel = "";
      state.display.activityStartedAt = 0;
    }
  }

  const commands = createCommandController({
    request: (method, params) => runtimeController.request(method, params),
    turn: {
      submit() {},
      interrupt() {},
    },
    input: {
      isTerminal: true,
      runGoalCommand: (...args) => runtimeController.runGoalCommand(...args),
      runContextCommand: () => output.log(() => contextBreakdownText(state.display.contextStats)),
      runForkCommand: () => runtimeController.runForkCommand(),
    },
    state: {
      get slashCommands() {
        return state.session.commands;
      },
    },
    output: {
      log: (text) => output.log(text),
      setInputPrefill() {},
      shutdown: async () => {},
      exit() {},
    },
  });
  commandControllerRef.controller = commands;

  return {
    tui,
    virtual,
    state,
    output,
    requests,
    runtimeController,
    commands,
    deliver,
    setSession(next) {
      composerSession = next;
    },
  };
}

async function settle(virtual) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await virtual.flush();
}

test("user flow: a full turn feeds the header meter, the context panel, then fork", async () => {
  const app = createHarness();
  const editor = createLineEditor("");
  app.setSession({ mode: "prompt", editor });
  app.tui.start();
  await app.runtimeController.ensureRuntime();

  app.output.writeUserInput("trace the failing request and fix it");
  await app.deliver({ type: "turn_started", user_message_chars: 42 });
  await app.deliver({ type: "context_built", message_count: 6, stats: CONTEXT_STATS, decisions: {} });
  await app.deliver({ type: "assistant_delta", text: "Investigating the retry path." });
  await app.deliver({
    type: "tool_requested",
    tool_call_id: "call-1",
    tool_name: "bash",
    args_preview: '{"command":"pytest -q"}',
  });
  await app.deliver({
    type: "tool_result",
    tool_call_id: "call-1",
    tool_name: "bash",
    status: "completed",
    duration_ms: 1200,
    result: JSON.stringify({ ok: true, data: { stdout: "12 passed", exit_code: 0 } }),
  });
  await app.deliver({ type: "token_stats_updated", stats: SAMPLING_STATS });
  await app.deliver({
    type: "token_stats_updated",
    stats: {
      ...SAMPLING_STATS,
      input_tokens: 62300,
      cached_input_tokens: 58000,
      output_tokens: 200,
      reasoning_output_tokens: 100,
      total_tokens: 62500,
      context_usage_percent: 0.3115,
    },
  });
  await app.deliver({
    type: "turn_completed",
    duration_ms: 4200,
    usage: { input_tokens: 12300, output_tokens: 1800, total_tokens: 14100 },
  });
  await settle(app.virtual);

  let joined = app.virtual.getViewport().join("\n");
  assert.ok(joined.includes("Investigating the retry path."), "assistant text visible");
  assert.ok(joined.includes("12 passed"), "tool output visible");
  assert.match(joined, /Worked for 4\.20s.*↑12\.3k ↓1\.8k/, "turn summary carries the token delta");

  const header = app.output.mainPromptText(80);
  assert.match(header, /test-model · ▮▮▮▯▯▯▯▯▯▯ 31%/, "composer header shows the live context meter");

  await app.commands.handle("/context");
  await settle(app.virtual);
  joined = app.virtual.getViewport().join("\n");
  assert.match(joined, /── Context · 62\.4k \/ 200k/);
  assert.match(joined, /system prompt\s+4\.2k\s+2%/);
  assert.match(joined, /rind docs\s+1\.2k\s+1%/);
  assert.match(joined, /skills\s+900\s+0%/);
  assert.match(joined, /conversation\s+38\.1k\s+19%/);
  assert.match(joined, /tools\s+12\.6k\s+6%/);
  assert.match(joined, /free\s+138k\s+69%/);

  await app.commands.handle("/fork");
  await settle(app.virtual);
  joined = app.virtual.getViewport().join("\n");
  assert.match(joined, /Session forked \S?\s*— branch session-forked · from session-a/);
  assert.ok(joined.includes("earlier answer"), "forked history replays into the transcript");
  assert.equal(app.state.session.info.session_id, "session-forked");
  assert.equal(app.state.display.contextStats, null, "context stats reset onto the fork");

  const forkHeader = app.output.mainPromptText(80);
  assert.doesNotMatch(forkHeader, /31%/, "meter hides until the fork samples tokens");

  app.tui.stop();
});

test("user flow: interrupting a long turn names the tool and reports the elapsed work", async () => {
  const app = createHarness();
  const editor = createLineEditor("");
  app.setSession({ mode: "prompt", editor });
  app.tui.start();
  await app.runtimeController.ensureRuntime();

  app.output.writeUserInput("run the whole suite and fix what breaks");
  await app.deliver({ type: "turn_started", user_message_chars: 40 });
  await app.deliver({ type: "assistant_delta", text: "Starting the suite now." });
  await app.deliver({
    type: "tool_requested",
    tool_call_id: "call-9",
    tool_name: "bash",
    args_preview: '{"command":"npm test"}',
  });

  assert.equal(app.state.display.activityLabel, "bash", "spinner names the running tool");
  assert.match(
    app.output.mainPromptText(80),
    /◐ bash \(1m 12s\) ctrl\+c interrupt/,
    "activity line shows the tool and elapsed time",
  );

  await app.deliver({ type: "turn_cancelled", reason: "User interrupted" });
  await settle(app.virtual);
  const joined = app.virtual.getViewport().join("\n");
  assert.match(joined, /Interrupted/);
  assert.match(joined, /worked for 1m 12s/);
  assert.match(joined, /session preserved/);

  app.tui.stop();
});
