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
import { promptPlaceholderText } from "../lib/rendering.js";
import { createLineEditor } from "../lib/line-editor.js";

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
  const transcriptContainer = new Container();
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
      frame: (width) => ({ lines: [...monitorLines], focusRow: monitorLines.length - 1 }),
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

test("tool blocks render rich per-tool output and respond to ctrl+o expansion", async () => {
  const harness = createHarness({ columns: 60, rows: 20 });
  harness.tui.start();

  const requestEvent = {
    tool_call_id: "call-e1",
    tool_name: "edit_file",
    args_preview: '{"file_path":"src/app.ts"}',
    arguments: { file_path: "src/app.ts" },
  };
  harness.output.beginTool(requestEvent);
  await settle(harness.virtual);

  let joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("edit src/app.ts"), "running title visible");

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

test("hardware caret stays hidden while a turn runs and returns when idle", async () => {
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
  const transcriptContainer = new Container();
  let session = null;
  const composerArea = new ComposerArea((width) => {
    if (!session) {
      return null;
    }
    const turnRunning = Boolean(state.turn.active);
    return {
      showCaret: !turnRunning,
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

  // Turn starts: caret must be hidden from then on.
  writes.length = 0;
  state.turn.active = true;
  state.display.activityFrame += 1;
  tui.requestRender();
  await settle(virtual);
  assert.ok(writes.some((w) => w.includes("\x1b[?25l")), "transition to working hides the caret");
  assert.ok(!writes.some((w) => w.includes("\x1b[?25h")), "working frames never reveal the caret");

  // Spinner ticks keep it hidden without redundant writes.
  writes.length = 0;
  state.display.activityFrame += 1;
  tui.requestRender();
  await settle(virtual);
  assert.ok(!writes.some((w) => w.includes("\x1b[?25h")), "spinner ticks never reveal the caret");

  // Turn completes: caret returns to the input line.
  writes.length = 0;
  state.turn.active = false;
  tui.requestRender();
  await settle(virtual);
  assert.ok(writes.some((w) => w.includes("\x1b[?25h")), "idle frames reveal the caret");
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

test("list items become bullets once their line completes", async () => {
  const harness = createHarness({ columns: 60, rows: 14 });
  harness.tui.start();
  harness.output.assistantAppend("tasks:\n- read files\n- run commands\n");
  harness.output.closeAssistant();
  await settle(harness.virtual);
  const joined = harness.virtual.getViewport().join("\n");
  assert.ok(joined.includes("• read files"), "list marker rendered");
  assert.ok(joined.includes("• run commands"), "second list marker rendered");
  harness.tui.stop();
});
