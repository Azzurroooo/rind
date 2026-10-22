import assert from "node:assert/strict";
import test from "node:test";

import { createVirtualOutput, createVirtualInput } from "./helpers/virtual-terminal.js";
import { createTui } from "../lib/tui/tui.js";
import { createTranscript } from "../lib/tui/transcript.js";
import { ComposerArea } from "../lib/components/composer-area.js";
import { MonitorStack } from "../lib/components/monitor-stack.js";
import { createCliOutputController } from "../lib/cli-output-controller.js";
import { createCliState } from "../lib/cli-state.js";
import { createEventController } from "../lib/event-controller.js";
import { promptPlaceholderText } from "../lib/rendering.js";
import { createLineEditor } from "../lib/line-editor.js";
import { createTaskMonitorController } from "../lib/task-monitor-controller.js";
import { parseTerminalKey } from "../lib/terminal-key.js";

function createHarness({ columns = 40, rows = 12 } = {}) {
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
  state.runtime.status = "ready";
  const transcriptContainer = createTranscript();
  const composerArea = new ComposerArea((width) => composeFrame(width));
  const monitorStack = new MonitorStack({
    composer: composerArea,
    monitor: {
      isMonitoring: () => false,
      frame: () => null,
    },
    rows: () => tui.rows,
  });
  tui.addChild(transcriptContainer);
  tui.addChild(monitorStack);
  const output = createCliOutputController({
    state,
    terminalUi: tui,
    transcript: transcriptContainer,
  });
  let session = null;
  function composeFrame(width) {
    if (!session) {
      return null;
    }
    return {
      prompt: output.mainPromptText(width),
      inputText: session.editor.input(),
      cursor: session.editor.cursorPosition(),
      placeholder: promptPlaceholderText(),
      menuText: "",
    };
  }
  return { tui, virtual, state, output, transcriptContainer, setSession(next) { session = next; } };
}

async function settle(virtual) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await virtual.flush();
}

test("idle background waiting preserves the composer and stops on work, suppression and completion", async () => {
  const h = createHarness({ columns: 90, rows: 16 });
  const editor = createLineEditor("继续检查结果");
  h.setSession({ mode: "prompt", editor });
  const waiting = { count: 1, started_at: Date.now() / 1000 - 222 };
  h.tui.start();
  try {
    h.output.setBackgroundWait(waiting);
    await settle(h.virtual);
    let screen = h.virtual.getViewport().join("\n");
    assert.match(screen, /Waiting · 1 background task · running 03:4\d/);
    assert.match(screen, /enter send/);
    assert.doesNotMatch(screen, /Working|ctrl\+c interrupt/);
    const cursor = h.virtual.getCursorPosition();
    h.state.display.activityFrame = 7;
    h.output.redraw(true);
    await settle(h.virtual);
    assert.deepEqual(h.virtual.getCursorPosition(), cursor);
    assert.equal(editor.input(), "继续检查结果");
    assert.ok(h.state.display.activityTimer);

    h.state.turn.active = true;
    h.output.refreshInputState();
    assert.match(h.output.mainPromptText(90), /Working/);
    assert.doesNotMatch(h.output.mainPromptText(90), /Waiting/);
    h.state.turn.active = false;
    h.state.turn.interruptRequested = true;
    h.output.refreshInputState();
    assert.doesNotMatch(h.output.mainPromptText(90), /Waiting/);
    assert.equal(h.state.display.activityTimer, null);

    h.state.turn.interruptRequested = false;
    h.state.session.info.goal = { status: "paused" };
    h.output.refreshInputState();
    assert.doesNotMatch(h.output.mainPromptText(90), /Waiting/);
    h.state.session.info.goal = null;
    h.output.setBackgroundWait({ ...waiting, count: 2 });
    assert.match(h.output.mainPromptText(90), /Waiting · 2 background tasks/);
    h.virtual.resize(36, 16);
    await settle(h.virtual);
    assert.equal(editor.input(), "继续检查结果");
    h.output.setBackgroundWait(null);
    assert.equal(h.state.display.activityTimer, null);
    assert.doesNotMatch(h.output.mainPromptText(36), /Waiting/);
  } finally {
    h.output.clearActivityTimer();
    h.tui.stop();
  }
});

test("task events preserve CJK composer text and cursor across completion and resize", async () => {
  const harness = createHarness({ columns: 54, rows: 14 });
  const editor = createLineEditor("");
  editor.setInput("继续检查输出 abc");
  harness.setSession({ mode: "prompt", editor });
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: true };
  const monitor = createTaskMonitorController({ state, terminalUi: true, request: async () => ({}), redraw: () => harness.tui.requestRender() });
  const controller = createEventController({ state, monitor });
  harness.tui.start();
  try {
    await settle(harness.virtual);
    const before = harness.virtual.getCursorPosition();
    for (const [type, status] of [["task_updated", "running"], ["task_output", "running"], ["task_updated", "completed"]]) {
      await controller.handle({ kind: "event", method: "session/update", event: { type, session_id: "s1", turn_id: "",
        task: { task_id: "task_1", status, stdout: "输出\n".repeat(200), finished_at: status === "completed" ? 1 : null } } });
    }
    monitor.recordResult({ result: JSON.stringify({ data: { task_id: "task_1", status: "running" } }) });
    await settle(harness.virtual);
    assert.deepEqual(harness.virtual.getCursorPosition(), before);
    assert.equal(state.sessionInfo.background_count, 0);
    harness.virtual.resize(36, 14);
    await settle(harness.virtual);
    assert.equal(editor.input(), "继续检查输出 abc");
    assert.ok(harness.virtual.getViewport().some((line) => line.includes(editor.input())));
    const position = harness.virtual.getCursorPosition();
    assert.equal(position.y, harness.virtual.getViewport().findIndex((line) => line.includes("▷")));
  } finally {
    monitor.stop();
    harness.tui.stop();
  }
});

test("streaming assistant text renders above the composer and reflows on resize", async () => {
  const harness = createHarness({ columns: 40, rows: 14 });
  const editor = createLineEditor("");
  editor.setInput("hello");
  harness.setSession({ mode: "prompt", editor });
  harness.tui.start();

  harness.output.writeUserInput("please summarize the rind architecture in detail");
  harness.output.assistantAppend("Rind keeps the runtime small. ");
  await settle(harness.virtual);
  harness.output.assistantAppend("It streams tokens through a diff renderer.");
  harness.output.closeAssistant();
  await settle(harness.virtual);

  let viewport = harness.virtual.getViewport().filter((line) => line.trim().length > 0);
  const flat = viewport.join("\n");
  assert.ok(flat.includes("You"), "user echo visible");
  assert.ok(flat.includes("Assistant"), "assistant header visible");
  assert.ok(flat.includes("streams tokens"), "streamed tail visible");

  harness.virtual.resize(80, 14);
  await settle(harness.virtual);

  viewport = harness.virtual.getViewport().filter((line) => line.trim().length > 0);
  const reflowed = viewport.join("\n");
  assert.ok(reflowed.includes("please summarize the rind architecture in detail"),
    "long user line rewrapped onto one physical line after widen");
  assert.ok(reflowed.includes("streams tokens through a diff renderer"),
    "assistant paragraph rewrapped onto fewer physical lines");
  harness.tui.stop();
});

test("log lines appear as transcript blocks with blank separation", async () => {
  const harness = createHarness({ columns: 50, rows: 14 });
  harness.tui.start();
  harness.output.showStartup({ model: "m1", session_id: "s1", version: "0.0", cwd: "/tmp" });
  harness.output.log("first log line");
  harness.output.log("second log line");
  await settle(harness.virtual);
  const viewport = harness.virtual.getViewport();
  const joined = viewport.join("\n");
  assert.ok(joined.includes("model m1"), "startup banner visible");
  assert.ok(joined.includes("second log line"));
  const firstIndex = viewport.findIndex((line) => line.includes("first log line"));
  const secondIndex = viewport.findIndex((line) => line.includes("second log line"));
  assert.equal(viewport.slice(firstIndex + 1, secondIndex).every((line) => !line.trim()), true,
    "blank line between blocks");
  harness.tui.stop();
});

test("startup banner updates in place when a new window creates its conversation", async () => {
  const harness = createHarness({ columns: 60, rows: 14 });
  harness.state.session.info = { model: "m1", session_id: "", version: "0.0", cwd: "/tmp" };
  harness.tui.start();
  harness.output.showStartup(() => ({ ...harness.state.session.info, resume_preview: "" }));
  await settle(harness.virtual);
  assert.match(harness.virtual.getViewport().join("\n"), /session new/);

  harness.state.session.info = { ...harness.state.session.info, session_id: "s-created", model: "m2" };
  harness.output.redraw();
  await settle(harness.virtual);
  const updated = harness.virtual.getViewport().join("\n");
  assert.match(updated, /session s-created/);
  assert.match(updated, /model m2/);
  assert.doesNotMatch(updated, /session new/);
  harness.tui.stop();
});

test("question status changes in place after an answer is accepted", async () => {
  const harness = createHarness({ columns: 60, rows: 14 });
  harness.tui.start();
  const event = { question: "Which option should be used?" };

  harness.output.beginQuestion(event);
  await settle(harness.virtual);
  let viewport = harness.virtual.getViewport().join("\n");
  assert.match(viewport, /Which option should be used/);

  harness.output.finishQuestion(event, "Fast");
  await settle(harness.virtual);
  viewport = harness.virtual.getViewport().join("\n");
  assert.match(viewport, /Q: Which option should be used\?/);
  assert.match(viewport, /A: Fast/);
  harness.tui.stop();
});

test("error writes land in the transcript without corrupting the frame", async () => {
  const harness = createHarness({ columns: 50, rows: 14 });
  harness.tui.start();
  harness.output.log("before failure");
  await settle(harness.virtual);
  harness.output.writeError("runtime hiccup\n");
  await settle(harness.virtual);
  const viewport = harness.virtual.getViewport();
  const joined = viewport.join("\n");
  assert.ok(joined.includes("before failure"));
  assert.ok(joined.includes("runtime hiccup"));
  harness.tui.stop();
});

test("composer cursor sits on the input line while typing", async () => {
  const harness = createHarness({ columns: 40, rows: 10 });
  const editor = createLineEditor("");
  editor.setInput("abc");
  const cursor = editor.cursorPosition();
  assert.deepEqual(cursor, { line: 0, column: 3 });
  harness.setSession({ mode: "prompt", editor });
  harness.tui.start();
  await settle(harness.virtual);
  const position = harness.virtual.getCursorPosition();
  const viewport = harness.virtual.getViewport();
  const promptRowIndex = viewport.findIndex((line) => line.includes("▷"));
  assert.ok(promptRowIndex !== -1, "prompt line visible");
  assert.equal(promptRowIndex, position.y, "cursor row on the ▷ prompt line");
  assert.equal(position.x >= 4, true, "cursor after prompt gutter");
  harness.tui.stop();
});

test("monitor pane is capped so the composer stays visible", async () => {
  const virtual = createVirtualOutput({ columns: 40, rows: 8 });
  const input = createVirtualInput();
  const tui = createTui({
    input,
    output: virtual.output,
    renderIntervalMs: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
  });
  const composer = new ComposerArea(() => ({
    prompt: "  header · path\n  ▷ ",
    inputText: "input>",
    cursor: { line: 0, column: 6 },
  }));
  const monitorLines = [];
  for (let index = 1; index <= 30; index += 1) {
    monitorLines.push(`task-line-${index}`);
  }
  const monitorStack = new MonitorStack({
    composer,
    monitor: {
      isMonitoring: () => true,
      frame: (width, height) => ({ lines: monitorLines.slice(-height) }),
    },
    rows: () => tui.rows,
  });
  tui.addChild(monitorStack);
  tui.start();
  await settle(virtual);
  const viewport = virtual.getViewport();
  const renderedMonitor = viewport.filter((line) => line.startsWith("task-line-"));
  assert.ok(renderedMonitor.length > 0, "some monitor rows visible");
  assert.ok(renderedMonitor.length <= 8 - 2, `monitor capped to remaining height, got ${renderedMonitor.length}`);
  assert.ok(viewport.some((line) => line.includes("input>")), "composer stays visible");
  tui.stop();
});

test("background monitor preserves preview, Unicode input and caret through resizing and key sequences", async () => {
  const virtual = createVirtualOutput({ columns: 80, rows: 24 });
  const input = createVirtualInput();
  const tui = createTui({ input, output: virtual.output, renderIntervalMs: 0 });
  const originalInput = `${"保留 é 中文 ".repeat(8)}input-tail`;
  const editor = createLineEditor(originalInput);
  const savedCursor = editor.cursorPosition();
  const state = { sessionInfo: { session_id: "s1", capabilities: ["rind/tasks"] }, inputActive: true };
  const reads = [];
  const monitor = createTaskMonitorController({ state, terminalUi: true, redraw: () => tui.requestRender(),
    request: async (method, params) => {
      if (method === "rind/task/list") return { tasks: [] };
      reads.push(params.task_id);
      return { task_id: params.task_id, status: "completed", handoff: true,
        stdout: Array.from({ length: 80 }, (_, i) => `output-${i} 回测`).join("\n") };
    },
  });
  for (let i = 0; i < 120; i += 1) monitor.recordTask({ task: { task_id: `task-${i}`,
    command: "命令 👩‍💻", status: "completed", handoff: true, started_at: i } });
  const composer = new ComposerArea(() => ({ prompt: "  model · workspace\n  ▷ ",
    inputText: editor.input(), cursor: editor.cursorPosition() }));
  const stack = new MonitorStack({ composer, monitor, rows: () => tui.rows });
  tui.addChild(stack);
  tui.onData((raw) => { const key = parseTerminalKey(raw); if (key) monitor.handleInput(key); });
  const noColor = process.env.NO_COLOR;
  tui.start();
  try {
    monitor.enterMonitor();
    await settle(virtual);
    for (const [columns, rows] of [[80, 24], [100, 30], [160, 50], [32, 6], [80, 24]]) {
      virtual.resize(columns, rows);
      await settle(virtual);
      const screen = virtual.getViewport();
      assert.ok(stack.render(columns).length <= rows);
      assert.ok(screen.some((line) => line.includes("task-119")));
      assert.match(screen.join("\n"), /esc/);
      assert.equal(editor.input(), originalInput);
      assert.deepEqual(editor.cursorPosition(), savedCursor);
      assert.ok(screen[virtual.getCursorPosition().y].includes("input-tail"), `${columns}x${rows} cursor remains on input`);
      if (rows >= 24) {
        assert.ok(screen.filter((line) => /output-\d+/.test(line)).length >= 6);
        assert.match(screen.join("\n"), /output-79/);
      }
    }
    const caret = virtual.getCursorPosition();
    input.send("\x1b[5~");
    await settle(virtual);
    assert.doesNotMatch(virtual.getViewport().join("\n"), /output-79/);
    assert.match(virtual.getViewport().join("\n"), /output-73/);
    input.send("\x1b[6~");
    await settle(virtual);
    assert.match(virtual.getViewport().join("\n"), /output-79/);
    input.send("\x1b[5~");
    input.send("\x1b[4~");
    process.env.NO_COLOR = "1";
    tui.requestRender(true);
    await settle(virtual);
    assert.match(virtual.getViewport().join("\n"), /output-79/);
    assert.deepEqual(virtual.getCursorPosition(), caret);
    assert.deepEqual(reads, ["task-119"], "scroll and resize use only the selected bounded preview");
    monitor.recordTask({ task: { task_id: "waiting", command: "waiting command", status: "running", handoff: false } });
    input.send("\x1b[A");
    await settle(virtual);
    assert.match(virtual.getViewport().join("\n"), /› Waiting 1\/1/);
    assert.doesNotMatch(virtual.getViewport().join("\n"), /output-79/);
    input.send("\x1b[B");
    await settle(virtual);
    assert.match(virtual.getViewport().join("\n"), /› task-119/);
    assert.match(virtual.getViewport().join("\n"), /output-79/);
    assert.equal(editor.input(), originalInput);
    assert.deepEqual(editor.cursorPosition(), savedCursor);
    assert.deepEqual(virtual.getCursorPosition(), caret);
    assert.deepEqual(reads, ["task-119", "task-119"]);
    input.send("\x02");
    await settle(virtual);
    assert.equal(monitor.isMonitoring(), false);
    monitor.recordTask({ task: { task_id: "new", status: "running", handoff: true } });
    await settle(virtual);
    assert.deepEqual(reads, ["task-119", "task-119"]);
    assert.equal(editor.input(), originalInput);
  } finally {
    monitor.stop();
    tui.stop();
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
});

test("tool blocks render rich per-tool output and respond to ctrl+o expansion", async () => {
  const harness = createHarness({ columns: 60, rows: 20 });
  harness.tui.start();

  harness.output.writeUserInput("run the edit now");
  const requestEvent = {
    tool_call_id: "call-e1",
    tool_name: "edit_file",
    args_preview: '{"file_path":"src/app.ts"}',
    arguments: { file_path: "src/app.ts" },
  };
  harness.output.beginTool(requestEvent);
  await settle(harness.virtual);

  let viewport = harness.virtual.getViewport();
  let joined = viewport.join("\n");
  assert.ok(joined.includes("edit src/app.ts"), "running title visible");
  const userRow = viewport.findIndex((line) => line.includes("run the edit now"));
  const titleRow = viewport.findIndex((line) => line.includes("edit src/app.ts"));
  assert.ok(userRow !== -1 && titleRow > userRow, "tool block follows user echo");
  assert.equal(viewport[titleRow - 1], "", "blank line between user content and tool block");

  harness.output.finishTool({
    ...requestEvent,
    status: "completed",
    duration_ms: 30,
    result: JSON.stringify({ ok: true, data: {} }),
  }, {
    file_path: "src/app.ts",
    lines: [
      { kind: "removed", text: "const a = 1;" },
      { kind: "added", text: "const a = 2;" },
    ],
  });
  await settle(harness.virtual);

  joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("(+1 -1)"), "diff counts in finished title");
  assert.ok(joined.includes("const a = 2;"), "diff body visible");

  // grep block with match count
  harness.output.beginTool({
    tool_call_id: "call-g1",
    tool_name: "grep",
    args_preview: '{"pattern":"TODO","path":"src"}',
    arguments: { pattern: "TODO", path: "src" },
  });
  harness.output.finishTool({
    tool_call_id: "call-g1",
    tool_name: "grep",
    status: "completed",
    duration_ms: 80,
    result: JSON.stringify({ ok: true, data: [{ file: "a.ts", line: 3, text: "TODO fix" }], meta: { count: 42 } }),
  });
  await settle(harness.virtual);
  joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("42 matches"), "grep match count visible");

  // collapsed edit block hides nothing here (2 lines under cap); verify expand toggle via API
  harness.tui.stop();
});

test("setToolsExpanded reveals capped bash output", async () => {
  const harness = createHarness({ columns: 70, rows: 24 });
  harness.tui.start();
  const event = {
    tool_call_id: "call-b1",
    tool_name: "bash",
    args_preview: '{"command":"npm test"}',
    arguments: { command: "npm test" },
  };
  harness.output.beginTool(event);
  const stdout = Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n");
  harness.output.finishTool({
    ...event,
    status: "completed",
    duration_ms: 900,
    result: JSON.stringify({ ok: true, data: { stdout, stderr: "", exit_code: 0 }, meta: {} }),
  });
  await settle(harness.virtual);

  let viewport = harness.virtual.getViewport();
  let plain = viewport.map((l) => l.trim());
  assert.ok(plain.some((line) => line.includes("more lines")), "collapsed footer present");
  assert.ok(!plain.some((line) => line.includes("line-0")), "early output hidden when collapsed");

  harness.output.setToolsExpanded(true);
  await settle(harness.virtual);
  viewport = harness.virtual.getViewport();
  plain = viewport.map((l) => l.trim());
  assert.ok(plain.some((line) => line.includes("line-0")), "full output visible after expand");
  assert.ok(!plain.some((line) => line.includes("more lines")), "footer removed after expand");
  harness.tui.stop();
});

test("event controller with implementation-style picked output bag still renders tool blocks", async () => {
  const harness = createHarness({ columns: 60, rows: 20 });
  harness.tui.start();

  // Mirror frontend-cli-implementation.js: the event controller receives a
  // hand-picked subset of controller methods, not the whole object.
  const pickedOutput = {
    assistantAppend: harness.output.assistantAppend,
    beginTool: (...args) => harness.output.beginTool(...args),
    updateToolProgress: (...args) => harness.output.updateToolProgress(...args),
    finishTool: (...args) => harness.output.finishTool(...args),
    settleTools: () => harness.output.settleTools(),
    closeAssistant: () => harness.output.closeAssistant(),
    log: (text) => harness.output.log(text),
    redraw: () => harness.output.redraw(),
  };
  const controller = createEventController({ output: pickedOutput });

  await controller.handle({ kind: "event", event: {
    type: "tool_input_started",
    tool_name: "bash",
    tool_call_id: "live-1",
  } });
  await settle(harness.virtual);
  let joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("$ …"), "bare running block visible before args arrive");

  await controller.handle({ kind: "event", event: {
    type: "tool_requested",
    tool_name: "bash",
    tool_call_id: "live-1",
    args_preview: '{"command":"npm test"}',
    arguments: { command: "npm test" },
  } });
  await settle(harness.virtual);
  joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("$ npm test"), "title enriched once args arrive");
  assert.ok(!joined.includes("$ …"), "placeholder replaced");

  await controller.handle({ kind: "event", event: {
    type: "tool_result",
    tool_name: "bash",
    tool_call_id: "live-1",
    status: "completed",
    duration_ms: 1200,
    result: JSON.stringify({ ok: true, data: { stdout: "tests passed", stderr: "", exit_code: 0 } }),
  } });
  await settle(harness.virtual);
  joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("tests passed"), "finished block visible through real wiring");

  harness.tui.stop();
});

test("finish-only blocks recover arguments from result payloads", async () => {
  const harness = createHarness({ columns: 60, rows: 20 });
  harness.tui.start();

  // Session-replay path: no tool_requested ever arrived.
  harness.output.finishTool({
    tool_call_id: "replay-1",
    tool_name: "read_file",
    status: "completed",
    duration_ms: 6,
    result: JSON.stringify({
      ok: true,
      data: "Showing lines 1 to 1:\n  1 | hello\n",
      meta: { path: "docs/guide.md" },
    }),
  });
  await settle(harness.virtual);
  const joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("read docs/guide.md"), "path recovered from result meta");
  assert.ok(!joined.includes("read …"), "no placeholder remains");
  harness.tui.stop();
});

test("session replay preserves bash command arguments", async () => {
  const harness = createHarness({ columns: 60, rows: 14 });
  const editor = createLineEditor("");
  harness.setSession({ mode: "prompt", editor });
  harness.tui.start();

  harness.output.renderHistory([
    {
      role: "assistant",
      tool_calls: [{
        id: "bash-replay-1",
        function: { name: "bash", arguments: JSON.stringify({ command: "npm test" }) },
      }],
    },
    {
      role: "tool",
      tool_call_id: "bash-replay-1",
      content: JSON.stringify({ ok: true, data: { exit_code: 0 } }),
    },
  ]);
  await settle(harness.virtual);

  const text = harness.virtual.getViewport().join("\n");
  assert.match(text, /\$ npm test/);
  assert.doesNotMatch(text, /\$ …/);
  harness.tui.stop();
});

test("hardware caret stays on the input line while a turn runs", async () => {
  const virtual = createVirtualOutput({ columns: 50, rows: 12 });
  const writes = [];
  const recordingOutput = Object.assign(Object.create(virtual.output), {
    write(chunk) {
      writes.push(String(chunk));
      return virtual.output.write(chunk);
    },
  });
  const input = createVirtualInput();
  const tui = createTui({
    input,
    output: recordingOutput,
    renderIntervalMs: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
  });
  const state = createCliState();
  state.runtime.status = "ready";
  const transcriptContainer = createTranscript();
  let session = null;
  const composerArea = new ComposerArea((width) => {
    if (!session) {
      return null;
    }
    return {
      showCaret: true,
      prompt: output.mainPromptText(width),
      inputText: session.editor.input(),
      cursor: session.editor.cursorPosition(),
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

  const editor = createLineEditor("");
  editor.setInput("");
  session = { mode: "prompt", editor };
  state.turn.active = false;
  tui.start();
  await settle(virtual);

  // Idle typing state: caret visible on the input line.
  const viewportBefore = virtual.getViewport();
  const promptRowBefore = viewportBefore.findIndex((line) => line.includes("▷"));
  assert.equal(promptRowBefore, virtual.getCursorPosition().y, "idle caret parked on the input line");

  // Turn starts: caret remains available for steering input.
  writes.length = 0;
  state.turn.active = true;
  state.display.activityFrame += 1;
  tui.requestRender();
  await settle(virtual);
  assert.ok(!writes.some((w) => w.includes("\x1b[?25l")), "working state never hides the caret");
  assert.equal(
    virtual.getViewport().findIndex((line) => line.includes("▷")),
    virtual.getCursorPosition().y,
    "working state keeps the caret on the input line",
  );

  // Spinner ticks keep it on the input line.
  writes.length = 0;
  state.display.activityFrame += 1;
  tui.requestRender();
  await settle(virtual);
  assert.ok(!writes.some((w) => w.includes("\x1b[?25l")), "spinner ticks never hide the caret");
  assert.equal(
    virtual.getViewport().findIndex((line) => line.includes("▷")),
    virtual.getCursorPosition().y,
    "spinner ticks keep the caret on the input line",
  );

  // Turn completes: caret remains on the input line.
  writes.length = 0;
  state.turn.active = false;
  state.display.activeCompact = true;
  state.display.activityLabel = "Compacting";
  editor.setInput("调整方向，保留输入");
  tui.requestRender();
  await settle(virtual);
  assert.ok(virtual.getViewport().some((line) => line.includes("Compacting")));
  assert.ok(virtual.getViewport().some((line) => line.includes("调整方向，保留输入")));
  assert.ok(!writes.some((w) => w.includes("\x1b[?25l")), "compact keeps the caret available");
  assert.equal(virtual.getViewport().findIndex((line) => line.includes("▷")), virtual.getCursorPosition().y);
  state.display.activeCompact = false;

  writes.length = 0;
  state.turn.active = false;
  tui.requestRender();
  await settle(virtual);
  assert.ok(!writes.some((w) => w.includes("\x1b[?25l")), "idle frames never hide the caret");
  const viewport = virtual.getViewport();
  const promptRowIndex = viewport.findIndex((line) => line.includes("▷"));
  assert.equal(promptRowIndex, virtual.getCursorPosition().y, "caret parked on the input line");
  tui.stop();
});

test("burst streaming coalesces into stable output", async () => {
  const harness = createHarness({ columns: 40, rows: 14 });
  harness.tui.start();
  for (let index = 0; index < 50; index += 1) {
    harness.output.assistantAppend(`chunk ${index} of the stream. `);
  }
  harness.output.closeAssistant();
  await settle(harness.virtual);
  const joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("chunk 49"), "final chunk visible");
  assert.ok(!joined.includes("undefined"), "no undefined leakage");
  harness.tui.stop();
});

test("streaming fragments without newlines stay on one line", async () => {
  const harness = createHarness({ columns: 60, rows: 14 });
  harness.tui.start();
  harness.output.assistantAppend("你好");
  await settle(harness.virtual);
  harness.output.assistantAppend("！");
  await settle(harness.virtual);
  harness.output.assistantAppend("我是");
  await settle(harness.virtual);
  harness.output.assistantAppend("Rind");
  harness.output.closeAssistant();
  await settle(harness.virtual);

  const viewport = harness.virtual.getViewport().filter((line) => line.trim());
  const assistantRows = viewport.filter((line) => line.includes("你好") || line.includes("我是") || line.includes("Rind"));
  assert.equal(assistantRows.length, 1, `fragments joined on one row, got ${JSON.stringify(viewport)}`);
  assert.ok(assistantRows[0].includes("你好！我是Rind"));
  harness.tui.stop();
});

test("streaming tables reflow in one assistant message block", async () => {
  const harness = createHarness({ columns: 40, rows: 14 });
  harness.tui.start();
  harness.output.assistantAppend("| Name | Status |\n| --- | --- |\n| A | ok |\n");
  await settle(harness.virtual);

  let viewport = harness.virtual.getViewport().join("\n");
  assert.match(viewport, /┌──────┬────────┐/);
  assert.match(viewport, /│ A    │ ok     │/);

  harness.output.assistantAppend("| Longer | ready |\n");
  await settle(harness.virtual);
  harness.output.closeAssistant();
  await settle(harness.virtual);

  viewport = harness.virtual.getViewport().join("\n");
  assert.match(viewport, /┌────────┬────────┐/);
  assert.match(viewport, /│ Longer │ ready  │/);
  assert.equal((viewport.match(/│ A\s+│ ok\s+│/g) || []).length, 1);
  harness.tui.stop();
});

test("list items become bullets once their line completes", async () => {
  const harness = createHarness({ columns: 60, rows: 14 });
  harness.tui.start();
  harness.output.assistantAppend("tasks:\n- read files\n- run commands\n");
  harness.output.closeAssistant();
  await settle(harness.virtual);
  const joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("– read files"), "list marker rendered");
  assert.ok(joined.includes("– run commands"), "second list marker rendered");
  harness.tui.stop();
});


test("image system notices preserve the composer and cursor through repeat events and resize", async () => {
  const h = createHarness({ columns: 60, rows: 16 });
  const editor = createLineEditor("");
  editor.setInput("未发送 hello");
  h.setSession({ mode: "prompt", editor });
  const controller = createEventController({ state: h.state, output: h.output });
  const event = { type: "context_built", decisions: {
    image_notice: "Images not sent. Select a vision model.", image_notice_level: "warning", image_notice_images: ["a"] } };
  h.tui.start();
  try {
    await settle(h.virtual);
    const cursorX = h.virtual.getCursorPosition().x;
    await controller.handle({ session_id: "s1", event });
    await settle(h.virtual);
    const before = h.virtual.getViewport();
    assert.ok(before.some((line) => line.startsWith("  · System:")));
    assert.equal(h.virtual.getCursorPosition().x, cursorX);
    await controller.handle({ session_id: "s1", event });
    await settle(h.virtual);
    assert.deepEqual(h.virtual.getViewport(), before);
    h.virtual.resize(32, 16);
    await settle(h.virtual);
    const lines = h.virtual.getViewport();
    assert.equal(lines.filter((line) => line.includes("System:")).length, 1);
    const cursor = h.virtual.getCursorPosition();
    assert.ok(lines[cursor.y].includes("未发送 hello"));
    assert.equal(editor.input(), "未发送 hello");
    assert.equal(cursor.x, cursorX);
  } finally { h.tui.stop(); }
});

test("brief mode E2E in headless terminal keeps ◌ with verb trail until assistant content or turn completion settles to ◉", async (t) => {
  const { setBriefMode } = await import("../lib/cli-state-store.js");
  setBriefMode(true);
  t.after(() => setBriefMode(false));

  const harness = createHarness({ columns: 80, rows: 16 });
  harness.tui.start();
  const pickedOutput = {
    assistantAppend: harness.output.assistantAppend,
    beginTool: (...args) => harness.output.beginTool(...args),
    updateToolProgress: (...args) => harness.output.updateToolProgress(...args),
    finishTool: (...args) => harness.output.finishTool(...args),
    settleTools: () => harness.output.settleTools(),
    closeAssistant: () => harness.output.closeAssistant(),
    log: (text) => harness.output.log(text),
    redraw: () => harness.output.redraw(),
  };
  const controller = createEventController({ output: pickedOutput });

  try {
    // 1. Two consecutive read_file calls + grep + edit_file
    for (const [id, file] of [["r1", "a.js"], ["r2", "b.js"]]) {
      await controller.handle({ kind: "event", event: {
        type: "tool_requested", tool_name: "read_file", tool_call_id: id,
        args_preview: JSON.stringify({ path: file }),
      } });
      await controller.handle({ kind: "event", event: {
        type: "tool_result", tool_name: "read_file", tool_call_id: id,
        status: "completed", result: JSON.stringify({ ok: true, data: "content" }),
      } });
    }
    await controller.handle({ kind: "event", event: {
      type: "tool_requested", tool_name: "grep", tool_call_id: "g1",
      args_preview: JSON.stringify({ pattern: "build", path: "src" }),
    } });
    await controller.handle({ kind: "event", event: {
      type: "tool_result", tool_name: "grep", tool_call_id: "g1",
      status: "completed", result: JSON.stringify({ ok: true, data: [], meta: { count: 1 } }),
    } });
    await controller.handle({ kind: "event", event: {
      type: "file_change", tool_call_id: "e1",
      lines: [{ kind: "removed", text: "old" }, { kind: "added", text: "new" }],
    } });
    await controller.handle({ kind: "event", event: {
      type: "tool_requested", tool_name: "edit_file", tool_call_id: "e1",
      args_preview: JSON.stringify({ path: "src/a.js" }),
    } });
    await controller.handle({ kind: "event", event: {
      type: "tool_result", tool_name: "edit_file", tool_call_id: "e1",
      status: "completed", result: JSON.stringify({ ok: true, data: "edited" }),
    } });
    await settle(harness.virtual);

    // Before assistant content prints, the terminal line MUST show ◌ (never ◉) with the collapsed verb trail.
    let viewport = harness.virtual.getViewport().join("\n");
    assert.match(viewport, /◌ read ×2 → grep → edit src\/a\.js \(\+1 -1\) · 4 tools/);
    assert.doesNotMatch(viewport, /◉/);

    // 2. Streaming assistant content settles the tool group to ◉ in place on the terminal screen.
    await controller.handle({ kind: "event", event: {
      type: "assistant_delta", text: "Applied fix and running verification.\n",
    } });
    await settle(harness.virtual);
    viewport = harness.virtual.getViewport().join("\n");
    assert.match(viewport, /◉ read ×2 → grep → edit src\/a\.js \(\+1 -1\) · 4 tools/);
    assert.match(viewport, /Applied fix and running verification\./);

    // 3. A trailing tool call at the end of the turn stays ◌ after tool_result, then settles to ◉ on turn_completed.
    await controller.handle({ kind: "event", event: {
      type: "tool_requested", tool_name: "bash", tool_call_id: "b1",
      args_preview: JSON.stringify({ command: "npm test" }),
    } });
    await controller.handle({ kind: "event", event: {
      type: "tool_result", tool_name: "bash", tool_call_id: "b1",
      status: "completed", duration_ms: 420,
      result: JSON.stringify({ ok: true, data: { stdout: "PASS\n", stderr: "", exit_code: 0 } }),
    } });
    await settle(harness.virtual);
    viewport = harness.virtual.getViewport().join("\n");
    assert.match(viewport, /◌ \$ npm test · 420ms/);

    await controller.handle({ kind: "event", event: {
      type: "turn_completed", duration_ms: 1500,
    } });
    await settle(harness.virtual);
    viewport = harness.virtual.getViewport().join("\n");
    assert.match(viewport, /◉ \$ npm test · 420ms/);
  } finally {
    harness.tui.stop();
  }
});

test("/settings two-level menu E2E in headless terminal configures brief output, theme, working spinner, and skill imports", async (t) => {
  const { currentSpinner, isBriefMode, resetSpinner, setBriefMode } = await import("../lib/cli-state-store.js");
  const { currentTheme, resetTheme } = await import("../lib/theme.js");
  const { createCliInputActions } = await import("../lib/cli-input-actions.js");
  const { createCliRuntimeController } = await import("../lib/cli-runtime-controller.js");
  const { createCommandController } = await import("../lib/command-controller.js");
  const { executeLocalSlashCommand } = await import("../lib/local-slash-commands.js");
  const { choiceDialogFrame, settingsMenuText } = await import("../lib/rendering.js");
  const { runtimeMethods: methods, sessionScopedMethods, turnScopedMethods } = await import("../lib/runtime-protocol.js");

  setBriefMode(false);
  resetTheme();
  resetSpinner();
  t.after(() => {
    setBriefMode(false);
    resetTheme();
    resetSpinner();
  });

  const virtual = createVirtualOutput({ columns: 96, rows: 22 });
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
  state.session.info = { session_id: "sess_e2e", workspace_root: "/work" };
  const transcriptContainer = createTranscript();
  const output = createCliOutputController({
    state,
    terminalUi: tui,
    transcript: transcriptContainer,
    animateTools: false,
  });
  const composerArea = new ComposerArea((width) => {
    const session = state.input.session;
    if (!session) return null;
    if (session.mode === "settings") {
      return {
        showCaret: false,
        prompt: output.mainPromptText(width),
        inputText: session.inputText,
        cursor: { line: 0, column: session.inputText.length },
        menuText: settingsMenuText(
          session.settingsState.items(),
          session.settingsState.selectedIndex(),
          session.settingsState.level(),
        ).trimEnd(),
      };
    }
    if (session.mode === "choice-dialog") {
      return {
        showCaret: false,
        prompt: "",
        inputText: "",
        cursor: { line: 0, column: 0 },
        menuText: choiceDialogFrame({
          title: session.title,
          message: session.message,
          options: session.choiceState.options(),
          selectedIndex: session.choiceState.selectedIndex(),
          width,
        }).trimEnd(),
      };
    }
    return null;
  });
  tui.addChild(transcriptContainer);
  tui.addChild(composerArea);

  const executedCommands = [];
  const sources = [
    { id: "claude_user", label: "Claude · user", paths: ["/home/u/.claude/skills"], count: 1, enabled: true },
    { id: "codex_user", label: "Codex · user", paths: ["/home/u/.codex/skills"], count: 3, enabled: false },
  ];
  let commandController;
  let inputActions;
  const runtimeController = createCliRuntimeController({
    client: {
      child: {},
      start() {},
      async request(method, params) {
        if (method === methods.commandExecute) {
          executedCommands.push(params.input);
          return { text: "", display: { type: "skill_imports", sources } };
        }
        return {};
      },
    },
    methods,
    sessionScopedMethods,
    turnScopedMethods,
    requireInitialization: (v) => v,
    state,
    getCommands: () => commandController,
    getTaskMonitor: () => null,
    getCompactContextState: () => ({ clear() {} }),
    askModelMenu: async () => null,
    askSettingsMenu: (...args) => inputActions.askSettingsMenu(...args),
    getBriefMode: () => isBriefMode(),
    onBriefChange: (enabled) => commandController.handle(`/settings brief ${enabled ? "on" : "off"}`),
    onThemeChange: (name) => commandController.handle(`/settings theme ${name}`),
    onSpinnerChange: (name) => commandController.handle(`/settings spinner ${name}`),
    askChoice: (...args) => inputActions.askChoice(...args),
    askSessionMenu: async () => null,
    askForkPointMenu: async () => null,
    restoreLiveTurn() {},
    clearPendingInputs() {},
    closeAssistant: output.closeAssistant,
    refreshInputState: output.refreshInputState,
    updateGoalState() {},
    log: output.log,
    writeError() {},
    redraw: output.redraw,
  });
  commandController = createCommandController({
    request: runtimeController.request,
    turn: { submit() {} },
    input: {
      isTerminal: true,
      runSettingsSelector: runtimeController.runSettingsSelector,
      runLocalCommand: async (text) => {
        const res = await executeLocalSlashCommand(text, {});
        if ((res?.display?.type === "brief" || res?.display?.type === "theme") && res.display.changed) {
          output.replayAll();
        }
        return res;
      },
    },
    state: { slashCommands: [] },
    output: { log: output.log },
  });
  inputActions = createCliInputActions({
    state,
    request: runtimeController.request,
    output,
    getTurnController: () => ({}),
    getCommandController: () => commandController,
    getTaskMonitor: () => null,
    getLineInput: () => null,
    getEffortLevels: async () => [],
    pausePrompt: () => {},
    resumePrompt: () => {},
    handleSigint: () => {},
  });

  tui.start();
  try {
    // Seed transcript with two consecutive tool calls in full mode
    output.writeUserInput("Inspect files");
    output.beginTool({ tool_call_id: "t1", tool_name: "read_file", args_preview: '{"path":"a.js"}' });
    output.finishTool({ tool_call_id: "t1", tool_name: "read_file", status: "completed", result: JSON.stringify({ ok: true, data: "const a = 1;\n" }) });
    output.beginTool({ tool_call_id: "t2", tool_name: "read_file", args_preview: '{"path":"b.js"}' });
    output.finishTool({ tool_call_id: "t2", tool_name: "read_file", status: "completed", result: JSON.stringify({ ok: true, data: "const b = 2;\n" }) });
    output.settleTools();
    await settle(virtual);
    assert.match(virtual.getViewport().join("\n"), /◉ read a\.js/);
    assert.match(virtual.getViewport().join("\n"), /◉ read b\.js/);

    // 1. Open /settings
    const settingsDone = commandController.handle("/settings");
    await settle(virtual);
    let screen = virtual.getViewport().join("\n");
    assert.match(screen, /\/settings/);
    assert.match(screen, /› Brief output .* off ›/);
    assert.match(screen, /· Theme .* ›/);
    assert.match(screen, /· Working spinner .* Orbit ›/);
    assert.match(screen, /· Skill imports .* 1 of 2 on ›/);

    // 2. Press Enter on Brief output to open its Level 2 submenu, select On (Down + Enter)
    inputActions.handleTerminalInput("\r");
    await settle(virtual);
    screen = virtual.getViewport().join("\n");
    assert.match(screen, /Settings · Brief output/);
    assert.match(screen, /› Off\s+Show each tool call in full\s+current/);
    inputActions.handleTerminalInput("\x1b[B");
    await settle(virtual);
    assert.match(virtual.getViewport().join("\n"), /› On\s+Collapse consecutive tool calls/);
    inputActions.handleTerminalInput("\r");
    await settingsDone;
    await settle(virtual);
    assert.equal(isBriefMode(), true);
    screen = virtual.getViewport().join("\n");
    assert.match(screen, /◉ read → read b\.js · 2 tools/, "existing tool group collapsed via live replay");
    assert.match(screen, /Brief output enabled\./);

    // 3. Open /settings again, navigate to Skill imports, and press Enter to open Level 2 submenu
    const importDone = commandController.handle("/settings");
    await settle(virtual);
    inputActions.handleTerminalInput("\x1b[B");
    inputActions.handleTerminalInput("\x1b[B");
    inputActions.handleTerminalInput("\x1b[B");
    inputActions.handleTerminalInput("\r");
    await settle(virtual);
    screen = virtual.getViewport().join("\n");
    assert.match(screen, /Settings · Import skills into this conversation/);
    assert.match(screen, /› \[x\] Claude · user/);
    assert.match(screen, /· \[ \] Codex · user/);

    // 4. Move down to Codex · user, toggle ON with Space, and press Enter to apply
    inputActions.handleTerminalInput("\x1b[B");
    inputActions.handleTerminalInput(" ");
    await settle(virtual);
    screen = virtual.getViewport().join("\n");
    assert.match(screen, /› \[x\] Codex · user/);
    inputActions.handleTerminalInput("\r");
    await settle(virtual);

    // 5. Prompt-cache confirmation dialog opens; select Apply (Down + Enter)
    screen = virtual.getViewport().join("\n");
    assert.match(screen, /Applying breaks the prompt cache\./);
    inputActions.handleTerminalInput("\x1b[B");
    inputActions.handleTerminalInput("\r");
    await importDone;
    await settle(virtual);

    // 6. Verify Skill imports applied
    assert.deepEqual(executedCommands, ["/import", "/import", "/import codex_user=on"]);
    screen = virtual.getViewport().join("\n");
    assert.match(screen, /Skill imports updated\./);

    // 7. Open /settings theme directly, select Dracula (Down + Enter), and verify theme update
    const themeDone = commandController.handle("/settings theme");
    await settle(virtual);
    screen = virtual.getViewport().join("\n");
    assert.match(screen, /\/settings theme/);
    assert.match(screen, /Settings · Theme/);
    assert.match(screen, /› Frappé\s+████████\s+current/);
    inputActions.handleTerminalInput("\x1b[B");
    await settle(virtual);
    assert.match(virtual.getViewport().join("\n"), /› Dracula\s+████████/);
    inputActions.handleTerminalInput("\r");
    await themeDone;
    await settle(virtual);
    assert.equal(currentTheme().name, "dracula");
    assert.match(virtual.getViewport().join("\n"), /Theme · frappe → dracula/);

    // 8. Open /settings spinner directly, select Sweep (Down wraps from Orbit -> Sweep, then Enter), and verify Working line uses Sweep frames
    const spinnerDone = commandController.handle("/settings spinner");
    await settle(virtual);
    screen = virtual.getViewport().join("\n");
    assert.match(screen, /\/settings spinner/);
    assert.match(screen, /Settings · Working spinner/);
    assert.match(screen, /› Orbit\s+◐ ◓ ◑ ◒\s+current/);
    inputActions.handleTerminalInput("\x1b[B");
    await settle(virtual);
    assert.match(virtual.getViewport().join("\n"), /› Sweep\s+█▒░░░ ▒█▒░░/);
    inputActions.handleTerminalInput("\r");
    await spinnerDone;
    await settle(virtual);
    assert.equal(currentSpinner().name, "sweep");
    state.turn.active = true;
    state.display.activityFrame = 1;
    assert.match(output.mainPromptText(96), /▒█▒░░ Working/);
  } finally {
    tui.stop();
  }
});

test("/remote transient dropdown menu E2E in headless virtual terminal: toggle switch, QR submenu, and Esc dismissal leave zero transcript residue", async () => {
  const { createRemoteMenuState, decodeTerminalQr, buildPairingUrl } = await import("../lib/remote.js");
  const { remoteMenuText } = await import("../lib/rendering.js");
  const { createCommandController } = await import("../lib/command-controller.js");
  const { createCliInputActions } = await import("../lib/cli-input-actions.js");
  const virtual = createVirtualOutput({ columns: 96, rows: 36 });
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
  state.session.info = {
    session_id: "s-remote-vt",
    model: "gpt-5.4",
    reasoning_effort: "medium",
    cwd: "/workspace/proj",
  };
  const transcriptContainer = createTranscript();
  const output = createCliOutputController({
    state,
    terminalUi: tui,
    transcript: transcriptContainer,
  });
  const composerArea = new ComposerArea((width) => {
    const session = state.input.session;
    if (!session) return null;
    if (session.mode === "remote") {
      return {
        showCaret: false,
        prompt: output.mainPromptText(width),
        inputText: session.inputText,
        cursor: { line: 0, column: session.inputText.length },
        menuText: remoteMenuText(session.remoteState, width).trimEnd(),
      };
    }
    return {
      showCaret: true,
      prompt: output.mainPromptText(width),
      inputText: session.editor?.input?.() || "",
      cursor: session.editor?.cursorPosition?.() || { line: 0, column: 0 },
      placeholder: promptPlaceholderText(),
      menuText: "",
    };
  });
  tui.addChild(transcriptContainer);
  tui.addChild(composerArea);

  let remoteRunning = false;
  let remoteCode = "init-secret-code-1234567890abcdef";
  const currentRemoteState = () => ({
    running: remoteRunning,
    scope: "lan",
    port: 8766,
    addresses: remoteRunning ? ["http://192.168.1.88:8766"] : [],
    accessCode: remoteRunning ? remoteCode : "",
    clients: 0,
  });

  let inputActions;
  const commandController = createCommandController({
    request: async () => ({}),
    turn: { submit() {} },
    input: {
      isTerminal: true,
      runRemote: async () => {
        const menuState = createRemoteMenuState({
          initialState: currentRemoteState(),
          initialScope: "lan",
          onToggle: async (enable) => {
            remoteRunning = Boolean(enable);
            state.session.info = { ...state.session.info, remote_running: remoteRunning };
            return currentRemoteState();
          },
          onRotate: async () => {
            remoteCode = "rotated-secret-code-9876543210fedcba";
            return currentRemoteState();
          },
        });
        await inputActions.askRemoteMenu(menuState);
      },
    },
    state: { slashCommands: [] },
    output: { log: output.log },
  });

  inputActions = createCliInputActions({
    state,
    request: async () => ({}),
    output,
    getTurnController: () => ({}),
    getCommandController: () => commandController,
    getTaskMonitor: () => null,
    getLineInput: () => null,
    getEffortLevels: async () => [],
    pausePrompt: () => {},
    resumePrompt: () => {},
    handleSigint: () => {},
  });

  tui.start();
  try {
    output.writeUserInput("Check remote menu");
    const promptPromise = inputActions.ask(output.mainPromptText, promptPlaceholderText());
    await settle(virtual);

    // 1. User types /remote and presses Enter
    for (const ch of "/remote") inputActions.handleTerminalInput(ch);
    inputActions.handleTerminalInput("\r");
    const submitted = await promptPromise;
    assert.equal(submitted, "/remote");

    const remoteDone = commandController.handle(submitted);
    await settle(virtual);
    let screen = virtual.getViewport().join("\n");
    assert.match(screen, /› Remote access\s+Off/);
    assert.match(screen, /· Network scope\s+Local network ›/);

    // 2. Toggle Remote access On with Space -> transitions to transient QR view in composer
    inputActions.handleTerminalInput(" ");
    await settle(virtual);
    screen = virtual.getViewport().join("\n");
    assert.match(screen, /gpt-5\.4 · medium · \/workspace\/proj · ⚯/);
    assert.match(screen, /Remote access · QR code \(Local network · 0 connected devices\)/);
    assert.equal(
      decodeTerminalQr(screen),
      buildPairingUrl(currentRemoteState()),
      "QR code in virtual terminal viewport must decode to exact pairing URL",
    );

    // 3. Press Esc to dismiss the QR display -> QR code and menu must be completely erased from viewport and scrollback!
    const nextPromptPromise = remoteDone.then(() =>
      inputActions.ask(output.mainPromptText, promptPlaceholderText()),
    );
    inputActions.handleTerminalInput("\x1b");
    await settle(virtual);
    screen = virtual.getViewport().join("\n");
    const scrollback = virtual.getScrollBuffer().join("\n");
    assert.doesNotMatch(screen, /[█▀▄]/, "QR code blocks must be erased from viewport after Esc");
    assert.doesNotMatch(scrollback, /[█▀▄]/, "QR code blocks must not remain in terminal scrollback after Esc");
    assert.doesNotMatch(screen, /Sign-in URL:/, "Sign-in URL must be erased after Esc");
    assert.match(screen, /gpt-5\.4 · medium · \/workspace\/proj · ⚯/, "⚯ indicator remains in prompt header while remote is on");
    assert.match(screen, /Check remote menu/, "prior conversation transcript remains intact");
    inputActions.cancel();
    await nextPromptPromise;
  } finally {
    tui.stop();
  }
});

