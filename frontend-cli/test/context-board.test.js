import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createCliInputActions } from "../lib/cli-input-actions.js";
import { createCliRuntimeController } from "../lib/cli-runtime-controller.js";
import { createCommandController } from "../lib/command-controller.js";
import { createCliState } from "../lib/cli-state.js";
import { createCliOutputController } from "../lib/cli-output-controller.js";
import { createVirtualOutput, createVirtualInput } from "./helpers/virtual-terminal.js";
import { createTui } from "../lib/tui/tui.js";
import { Container } from "../lib/tui/component.js";
import { ComposerArea } from "../lib/components/composer-area.js";
import { MonitorStack } from "../lib/components/monitor-stack.js";
import { contextBoardText, occupancyTone, usageBoardText } from "../lib/rendering.js";
import { resetTheme, setTheme, flavorSwatch } from "../lib/theme.js";
import { stripAnsi, textWidth } from "../lib/text-width.js";

const BREAKDOWN = {
  captured_at: "2026-09-10T03:33:12.000Z",
  turn_id: "8f3a12bc",
  estimated_total: 41320,
  context_window_tokens: 131072,
  sections: [
    { key: "tool:bash", label: "Tool results · bash", tokens: 14200, messages: 3 },
    { key: "system_prompt", label: "System prompt (incl. capsule)", tokens: 12400, messages: 1 },
    { key: "chat_assistant", label: "Chat · assistant replies", tokens: 7300, messages: 6 },
    { key: "rind_docs_project", label: "RIND.md · project", tokens: 2100, messages: 1 },
    { key: "chat_user", label: "Chat · user inputs", tokens: 1900, messages: 4 },
    { key: "tool:other", label: "Tool results · other", tokens: 1780, messages: 2 },
    { key: "reasoning", label: "Reasoning content", tokens: 1200, messages: 6 },
    { key: "skill_catalog", label: "Skill catalog", tokens: 480, messages: 1 },
  ],
};

const LATEST_USAGE = { sampling_kind: "assistant", input_tokens: 43850 };

const SUMMARY = {
  days: 7,
  totals: { input: 1240000, cached: 812000, output: 96000, reasoning: 41000, total: 1336000, samples: 214, compactions: 6 },
  by_day: [
    { day: "09-09", tokens: 38200 },
    { day: "09-08", tokens: 21400 },
    { day: "09-07", tokens: 8900 },
  ],
  by_model: [
    { model: "deepseek-v4-flash", tokens: 1180000, samples: 180 },
    { model: "gpt-5-mini", tokens: 62000, samples: 34 },
  ],
  recent_sessions: [
    { session_id: "20260909_1133", updated_at: "2026-09-09T11:33:00Z", tokens: 41200, samples: 12 },
    { session_id: "20260908_2201", updated_at: "2026-09-08T22:01:00Z", tokens: 33000, samples: 10 },
  ],
};

const page1 = () => contextBoardText({ breakdown: BREAKDOWN, latest_usage: LATEST_USAGE, index: 1, count: 2 }, 100);
const page2 = () => usageBoardText({ summary: SUMMARY, index: 2, count: 2 }, 100);

test("context board page 1 renders the locked layout", () => {
  resetTheme();
  const text = page1();
  const lines = text.split("\n").map(stripAnsi);

  assert.match(lines[0], /^┌ Context · last sampling · turn 8f3a · 03:33:12 ─+ 1\/2 ┐$/);
  assert.equal(lines[1], "│ Window 131,072 · used 32%   measured 43,850 · estimated 41,320 (+6%)                             │");
  assert.match(lines[2], /^│ █+░+ │$/);
  assert.equal(lines[4], "│   Tool results · bash            14,200   34%  3 msgs                                            │");
  assert.equal(lines[5], "│   System prompt (incl. capsule)  12,400   30%   1 msg                                            │");
  assert.equal(lines.at(-2), "│ Tab switch page · Esc exit                                                                       │");
  assert.equal(lines.at(-1), `└${"─".repeat(98)}┘`);
  // Byte-deterministic: the same input renders the same bytes.
  assert.equal(page1(), page1());
});

test("usage board page 2 renders the locked layout", () => {
  resetTheme();
  const text = page2();
  const lines = text.split("\n").map(stripAnsi);

  assert.match(lines[0], /^┌ Token usage · last 7 days ─+ 2\/2 ┐$/);
  assert.equal(lines[1], "│ Input 1.24M   Cache hit 812K·65%   Output 96K   Reasoning 41K                                    │");
  assert.equal(lines[2], "│ 214 samples                                                                                      │");
  assert.match(lines[4], /^│ By day\s+│$/);
  assert.match(lines[5], /^│ {3}09-09  █+\s+38\.2K │$/);
  assert.match(lines[6], /^│ {3}09-08  █+\s+21\.4K │$/);
  assert.match(lines[7], /^│ {3}09-07  █+\s+8\.9K │$/);
  assert.match(lines[9], /^│ By model\s+│$/);
  assert.match(lines.at(-2), /^│ 6 compaction calls · Tab switch page · Esc exit\s+│$/);
  assert.equal(page2(), page2());
});

test("stacked bar and day columns stretch between 60 and 100 columns without misaligned rows", () => {
  resetTheme();
  for (const width of [60, 80, 100]) {
    for (const text of [
      contextBoardText({ breakdown: BREAKDOWN, latest_usage: LATEST_USAGE, index: 1, count: 2 }, width),
      usageBoardText({ summary: SUMMARY, index: 2, count: 2 }, width),
    ]) {
      const lines = text.split("\n");
      for (const line of lines) {
        assert.equal(textWidth(line), width, `row exceeds the panel at ${width}: ${stripAnsi(line)}`);
      }
    }
  }
});

test("CJK and emoji section labels stay aligned with plain ones", () => {
  resetTheme();
  const breakdown = {
    ...BREAKDOWN,
    sections: [
      { key: "chat_user", label: "Chat · 用户输入", tokens: 9000, messages: 4 },
      { key: "chat_assistant", label: "Chat · replies 🚀", tokens: 7000, messages: 3 },
      { key: "tool:other", label: "Tool results · other", tokens: 1000, messages: 2 },
    ],
  };
  const text = contextBoardText({ breakdown, index: 1, count: 2 }, 90);
  const rows = text.split("\n").map(stripAnsi).filter((line) => line.includes(" msgs"));
  const tokens = ["9,000", "7,000", "1,000"];
  const columns = rows.map((row, index) => textWidth(row.slice(0, row.indexOf(tokens[index]))));
  assert.equal(rows.length, 3);
  // Right-aligned numbers share one display column regardless of CJK/emoji label widths.
  assert.ok(columns.every((column) => column === columns[0]), `token columns ${columns}`);
  assert.ok(columns[0] > 0);
});

test("occupancy 33/70/90 percent picks neutral/warn/err theme colors", () => {
  assert.equal(occupancyTone(0.33), "neutral");
  assert.equal(occupancyTone(0.7), "warn");
  assert.equal(occupancyTone(0.9), "err");
  resetTheme();
  setTheme("mocha");
  const originalIsTty = process.stdout.isTTY;
  try {
    process.stdout.isTTY = true;
    const bar = (percent) => {
      const breakdown = { ...BREAKDOWN, estimated_total: Math.round(BREAKDOWN.context_window_tokens * percent) };
      return contextBoardText({ breakdown, latest_usage: { input_tokens: 1 }, index: 1, count: 2 }, 80);
    };
    // The occupancy warning is the color of the `used NN%` figure on the meta line.
    const metaLine = (text) => text.split("\n")[1];
    const codes = (text) => metaLine(text).match(/\x1b\[38;2;\d+;\d+;\d+m/g) || [];
    const dangerCode = "\x1b[38;2;243;139;168m";
    const warningCode = "\x1b[38;2;249;226;175m";
    assert.ok(codes(bar(0.9)).includes(dangerCode), "90% occupancy paints err");
    assert.ok(codes(bar(0.7)).includes(warningCode), "70% occupancy paints warn");
    assert.deepEqual(codes(bar(0.33)), [], "33% occupancy stays neutral");
  } finally {
    if (originalIsTty === undefined) {
      delete process.stdout.isTTY;
    } else {
      process.stdout.isTTY = originalIsTty;
    }
    resetTheme();
  }
});

test("board render functions contain no hardcoded colors", () => {
  const source = readFileSync(new URL("../lib/rendering.js", import.meta.url), "utf8");
  // Single source of color is theme.js; render functions may only reference it.
  assert.equal(source.includes("\\x1b["), false);
  assert.equal(/38;2;/.test(source), false);
  assert.equal(source.includes('from "./theme.js"'), true);
  for (const role of ["accent", "dim", "success", "warning", "danger", "notice", "path", "code", "fence"]) {
    assert.equal(source.includes(`paint.${role}`) || new RegExp(`paint\\[`).test(source), true, `paint.${role} usage`);
  }
});

test("board keys switch pages and Esc exits with zero residual state", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  const renderedPages = [];
  const output = {
    terminalUi: {},
    writeUserInput() {},
    closeAssistant() {},
    beginQuestion() {},
    finishQuestion() {},
    redraw() {},
    writeError() {},
  };
  const actions = createCliInputActions({
    state,
    request: async () => ({}),
    output,
    getTurnController: () => null,
    getTaskMonitor: () => null,
    getLineInput: () => null,
    pausePrompt() {},
    resumePrompt() {},
    handleSigint() {},
  });

  const board = {
    render: (pageIndex, width) => {
      renderedPages.push([pageIndex, width]);
      return `page-${pageIndex}@${width}`;
    },
  };
  const pending = actions.askContextBoard(board);
  await Promise.resolve();

  const session = state.input.session;
  assert.equal(session.mode, "context-board");
  assert.equal(session.pageIndex, 0);

  actions.handleTerminalInput("\t");
  assert.equal(session.pageIndex, 1);
  actions.handleTerminalInput("\x1b[C");
  assert.equal(session.pageIndex, 0);
  actions.handleTerminalInput("\x1b[D");
  assert.equal(session.pageIndex, 1);

  const frame = board.render(session.pageIndex, 100);
  assert.equal(frame, "page-1@100");

  actions.handleTerminalInput("\x1b");
  assert.equal(await pending, "");
  assert.equal(state.input.session, null);
  assert.equal(state.input.active, false);
});

test("empty sampling state shows the exact guidance copy", () => {
  resetTheme();
  const text = contextBoardText({ breakdown: null, latest_usage: null, index: 1, count: 2 }, 80);
  assert.match(text, /No context sampled yet/);
  assert.match(text, /Send a message first, then try again\./);
  assert.doesNotMatch(text, /█/);
  const usage = usageBoardText({ summary: { days: 7, totals: { samples: 0 } }, index: 2, count: 2 }, 80);
  assert.match(usage, /No usage recorded yet/);
  assert.match(usage, /Send a message first, then try again\./);
});

test("non-TTY /context prints both pages as plain frame-less text", async () => {
  const state = createCliState();
  state.runtime.status = "ready";
  state.session.info = { session_id: "session-a", model: "model-a" };
  const requests = [];
  const logs = [];
  const methods = {
    initialize: "initialize",
    contextInspect: "rind/context/inspect",
    usageSummary: "rind/usage/summary",
    commandExecute: "rind/command/execute",
  };
  const controller = createCliRuntimeController({
    client: {
      start() {},
      request(method, params) {
        requests.push({ method, params });
        if (method === methods.initialize) {
          return Promise.resolve({ protocol_version: "2", capabilities: [], methods: [], session_id: "session-a" });
        }
        if (method === methods.contextInspect) {
          return Promise.resolve({ session_id: "session-a", breakdown: BREAKDOWN, latest_usage: LATEST_USAGE });
        }
        if (method === methods.usageSummary) {
          return Promise.resolve(SUMMARY);
        }
        return Promise.resolve({});
      },
    },
    methods,
    sessionScopedMethods: new Set([methods.contextInspect]),
    turnScopedMethods: new Set(),
    requireInitialization: (info) => info,
    state,
    getCommands: () => ({ normalizeCommands: (commands) => commands || [], localCommands: () => [], applyResult() {} }),
    getTaskMonitor: () => null,
    getCompactContextState: () => ({ clear() {} }),
    restoreLiveTurn() {},
    renderHistory() {},
    clearPendingInputs() {},
    closeAssistant() {},
    refreshInputState() {},
    updateGoalState() {},
    log: (text) => logs.push(typeof text === "function" ? text() : text),
    writeError() {},
    redraw() {},
  });

  await controller.printContextReport();

  assert.deepEqual(requests.map((request) => request.method), [methods.contextInspect, methods.usageSummary]);
  assert.deepEqual(requests[0].params, { session_id: "session-a" });
  assert.deepEqual(requests[1].params, { days: 7 });
  assert.equal(logs.length, 2);
  for (const text of logs) {
    assert.equal(text.includes("┌"), false, "frame-less output must not draw borders");
    assert.equal(text.includes("Tab switch page"), false, "interaction hints are meaningless in pipe output");
  }
  assert.match(logs[0], /Context · last sampling/);
  assert.match(logs[1], /Token usage · last 7 days/);
});

test("/context routes to the board on a TTY and to the report otherwise", async () => {
  const calls = [];
  const makeController = (input) => createCommandController({
    request: async () => ({}),
    turn: { submit() {} },
    input,
    output: { log: (text) => calls.push(["log", typeof text === "function" ? text() : text]) },
  });

  await makeController({
    isTerminal: true,
    runContextBoard: () => calls.push(["board"]),
    printContextReport: () => calls.push(["report"]),
  }).handle("/context");
  await makeController({
    isTerminal: false,
    runContextBoard: () => calls.push(["board"]),
    printContextReport: () => calls.push(["report"]),
  }).handle("/context");
  await makeController({ isTerminal: false }).handle("/context");

  assert.deepEqual(calls, [["board"], ["report"], ["log", "/context requires a connected runtime."]]);
});

test("every theme paints the board only with its own palette", () => {
  const originalIsTty = process.stdout.isTTY;
  try {
    process.stdout.isTTY = true;
    for (const theme of ["latte", "frappe", "macchiato", "mocha"]) {
      resetTheme();
      assert.equal(setTheme(theme)?.name, theme);
      // The theme deck swatch enumerates this flavor's eight role colors.
      const allowed = new Set(flavorSwatch(theme).match(/\x1b\[38;2;\d+;\d+;\d+m/g) || []);
      assert.equal(allowed.size, 8);
      for (const text of [
        contextBoardText({ breakdown: BREAKDOWN, latest_usage: LATEST_USAGE, index: 1, count: 2 }, 100),
        usageBoardText({ summary: SUMMARY, index: 2, count: 2 }, 100),
      ]) {
        const used = text.match(/\x1b\[38;2;\d+;\d+;\d+m/g) || [];
        assert.ok(used.length > 0, `${theme}: board paints with truecolor`);
        for (const code of used) {
          assert.ok(allowed.has(code), `${theme}: unexpected color ${code}`);
        }
      }
    }
  } finally {
    if (originalIsTty === undefined) {
      delete process.stdout.isTTY;
    } else {
      process.stdout.isTTY = originalIsTty;
    }
    resetTheme();
  }
});

test("board renders full screen on a real TUI, Tab flips pages, Esc returns to the composer", async () => {
  const virtual = createVirtualOutput({ columns: 100, rows: 30 });
  const input = createVirtualInput();
  const tui = createTui({
    input,
    output: virtual.output,
    renderIntervalMs: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
  });
  const state = createCliState();
  state.runtime.status = "ready";
  const transcriptContainer = new Container();
  const composerArea = new ComposerArea((width) => composeFrame(width));
  const monitorStack = new MonitorStack({
    composer: composerArea,
    monitor: { isMonitoring: () => false, frame: () => null },
    rows: () => tui.rows,
  });
  tui.addChild(transcriptContainer);
  tui.addChild(monitorStack);
  const output = createCliOutputController({ state, terminalUi: tui, transcript: transcriptContainer });
  // Mirrors the composeFrame board branch in frontend-cli-implementation.js.
  function composeFrame(width) {
    const session = state.input.session;
    if (!session) {
      return null;
    }
    if (session.mode === "context-board") {
      return {
        showCaret: false,
        prompt: "",
        inputText: "",
        cursor: { line: 0, column: 0 },
        menuText: session.board.render(session.pageIndex, width),
      };
    }
    return { prompt: output.mainPromptText(width), inputText: "", cursor: { line: 0, column: 0 }, placeholder: "" };
  }
  const actions = createCliInputActions({
    state,
    request: async () => ({}),
    output,
    getTurnController: () => null,
    getTaskMonitor: () => null,
    getLineInput: () => null,
    pausePrompt() {},
    resumePrompt() {},
    handleSigint() {},
  });

  const data = { breakdown: BREAKDOWN, latestUsage: LATEST_USAGE, summary: SUMMARY };
  const renderPage = (pageIndex, width) => (pageIndex === 0
    ? contextBoardText({ breakdown: data.breakdown, latest_usage: data.latestUsage, index: 1, count: 2 }, width)
    : usageBoardText({ summary: data.summary, index: 2, count: 2 }, width));
  tui.onData((sequence) => actions.handleTerminalInput(sequence));
  tui.start();

  const pending = actions.askContextBoard({ render: renderPage });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await virtual.flush();

  let viewport = virtual.getViewport().map((line) => stripAnsi(line)).filter((line) => line.trim());
  let flat = viewport.join("\n");
  assert.match(flat, /Context · last sampling · turn 8f3a/);
  assert.match(flat, /1\/2/);
  assert.match(flat, /Tool results · bash/);
  assert.equal(flat.includes("Token usage · last 7 days"), false, "page 2 stays hidden on page 1");

  input.send("\t");
  await new Promise((resolve) => setTimeout(resolve, 25));
  await virtual.flush();
  viewport = virtual.getViewport().map((line) => stripAnsi(line)).filter((line) => line.trim());
  flat = viewport.join("\n");
  assert.match(flat, /Token usage · last 7 days/);
  assert.match(flat, /2\/2/);
  assert.match(flat, /6 compaction calls/);
  assert.equal(flat.includes("Tool results · bash"), false, "page 1 stays hidden on page 2");

  input.send("\x1b[C");
  await new Promise((resolve) => setTimeout(resolve, 25));
  await virtual.flush();
  viewport = virtual.getViewport().map((line) => stripAnsi(line)).filter((line) => line.trim());
  assert.match(viewport.join("\n"), /Context · last sampling/, "arrow right returns to page 1");

  input.send("\x1b");
  assert.equal(await pending, "");
  assert.equal(state.input.session, null);
  assert.equal(state.input.active, false);

  state.input.session = { mode: "prompt" };
  tui.requestRender(true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await virtual.flush();
  viewport = virtual.getViewport().map((line) => stripAnsi(line)).filter((line) => line.trim());
  assert.equal(viewport.join("\n").includes("Context · last sampling"), false, "the board leaves no residue");
  tui.stop();
});
