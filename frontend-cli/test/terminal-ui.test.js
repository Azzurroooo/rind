import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";

import { createTerminalUI } from "../lib/terminal-ui.js";
import { stripAnsi } from "../lib/text-width.js";

class TestInput extends EventEmitter {
  isRaw = false;
  rawHistory = [];
  paused = false;

  setRawMode(value) {
    this.rawHistory.push(value);
    this.isRaw = value;
  }

  setEncoding() {}

  resume() {
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }
}

class TestOutput extends EventEmitter {
  columns = 40;
  rows = 10;
  writes = [];

  write(value) {
    this.writes.push(String(value));
  }
}

function createScheduler() {
  let time = 0;
  const timers = [];

  return {
    now: () => time,
    setTimeout(callback, delay) {
      const timer = { at: time + delay, callback, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cancelled = true;
    },
    advance(milliseconds) {
      time += milliseconds;
      let next;
      while ((next = timers.find((timer) => !timer.cancelled && timer.at <= time))) {
        next.cancelled = true;
        next.callback();
      }
    },
    pending() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}

test("buffers split ANSI sequences and emits ordinary characters separately", () => {
  const input = new TestInput();
  const output = new TestOutput();
  const received = [];
  const ui = createTerminalUI({
    input,
    output,
  });

  ui.start({ onInput: (value) => received.push(value) });
  input.emit("data", "\x1b[");
  input.emit("data", "1;5");
  input.emit("data", "C");
  input.emit("data", "a");

  assert.deepEqual(received, ["\x1b[1;5C", "a"]);
  ui.stop();
});

test("emits bracketed paste as one atomic event and resumes parsing after it", () => {
  const input = new TestInput();
  const output = new TestOutput();
  const received = [];
  const pastes = [];
  const ui = createTerminalUI({
    input,
    output,
  });

  ui.start({
    onInput: (value) => received.push(value),
    onPaste: (value) => pastes.push(value),
  });
  input.emit("data", "x\x1b[200~line 1\n");
  input.emit("data", "line 2\x1b[201~y");

  assert.deepEqual(received, ["x", "y"]);
  assert.deepEqual(pastes, ["line 1\nline 2"]);
  ui.stop();
});

test("coalesces render requests and enforces the minimum render interval", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  let frame = 0;
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines: [`frame ${frame}`], cursorRow: 0, cursorColumn: 7 }),
  });

  ui.start();
  await Promise.resolve();
  assert.equal(scheduler.pending(), 1);
  scheduler.advance(0);
  assert.equal(frameWrites(output), 1);

  frame = 1;
  ui.requestRender();
  ui.requestRender();
  await Promise.resolve();
  assert.equal(scheduler.pending(), 1);
  scheduler.advance(15);
  assert.equal(frameWrites(output), 1);
  scheduler.advance(1);
  assert.equal(frameWrites(output), 2);
  ui.stop();
});

test("keeps cursor row and column when only the cursor moves", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  let cursorColumn = 1;
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines: ["hello"], cursorRow: 0, cursorColumn }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);
  output.writes = [];

  cursorColumn = 3;
  ui.requestRender(true);
  await Promise.resolve();
  scheduler.advance(0);

  assert.equal(output.writes.length, 1);
  assert.match(output.writes[0], /\x1b\[4G/);
  assert.ok(output.writes[0].indexOf("\x1b[4G") < output.writes[0].indexOf("\x1b[?2026l"));
  ui.stop();
});

test("does not draw an empty frame or move the cursor", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines: [], cursorRow: 0, cursorColumn: 0 }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);

  assert.equal(output.writes.filter((value) => value.includes("\x1b[?2026h")).length, 0);
  ui.stop();
});

test("appends new frame lines with a newline instead of cursor down", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  let lines = ["one"];
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines, cursorRow: lines.length - 1, cursorColumn: 3 }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);
  output.writes = [];

  lines = ["one", "two"];
  ui.requestRender(true);
  await Promise.resolve();
  scheduler.advance(0);

  assert.equal(output.writes.length, 1);
  assert.match(output.writes[0], /\r\n\x1b\[2Ktwo/);
  assert.doesNotMatch(output.writes[0], /\x1b\[1B\r/);
  ui.stop();
});

test("clears only the stale tail when the frame shrinks", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  let lines = ["one", "two", "three"];
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines, cursorRow: lines.length - 1, cursorColumn: 0 }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);
  output.writes = [];

  lines = ["one"];
  ui.requestRender(true);
  await Promise.resolve();
  scheduler.advance(0);

  assert.match(output.writes[0], /\x1b\[J/);
  assert.doesNotMatch(output.writes.join(""), /\x1b\[2Kone/);
  ui.stop();
});

test("keeps a tall frame within the terminal viewport", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  output.rows = 3;
  const scheduler = createScheduler();
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({
      lines: ["line 0", "line 1", "line 2", "line 3", "line 4"],
      cursorRow: 4,
      cursorColumn: 6,
    }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);

  const frame = output.writes.find((value) => value.includes("\x1b[?2026h"));
  assert.doesNotMatch(frame, /line [01]/);
  assert.equal(stripAnsi(frame), "line 2\r\nline 3\r\nline 4");
  assert.equal(frame.match(/\r\n/g)?.length, 2);
  ui.stop();
});

test("keeps the input cursor and selected menu item visible", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  output.rows = 3;
  const scheduler = createScheduler();
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({
      lines: ["input", "menu", "item 1", "item 2", "selected", "item 4"],
      cursorRow: 0,
      cursorColumn: 5,
      focusRow: 4,
    }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);

  const frame = output.writes.find((value) => value.includes("\x1b[?2026h"));
  assert.equal(stripAnsi(frame), "input\r\nitem 2\r\nselected");
  ui.stop();
});

test("keeps a fixed input prefix while the focused monitor rows scroll", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  output.rows = 4;
  const scheduler = createScheduler();
  let focusRow = 3;
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({
      lines: ["status", "input", "tab", "item 1", "item 2", "item 3"],
      cursorRow: 1,
      cursorColumn: 5,
      focusRow,
      fixedPrefixRows: 2,
    }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);
  const initialFrame = output.writes.find((value) => value.includes("\x1b[?2026h"));
  assert.match(stripAnsi(initialFrame), /status/);
  assert.match(stripAnsi(initialFrame), /input/);
  output.writes = [];

  focusRow = 5;
  ui.requestRender(true);
  await Promise.resolve();
  scheduler.advance(0);

  const frame = output.writes[0];
  assert.match(stripAnsi(frame), /item 3/);
  assert.doesNotMatch(frame, /\x1b\[2Kinput/);
  assert.doesNotMatch(frame, /\x1b\[2Kstatus/);
  ui.stop();
});

test("prints external output above the frame in a single atomic write", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  let frame = "prompt";
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines: [frame], cursorRow: 0, cursorColumn: frame.length }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);
  output.writes = [];

  ui.withSuspended(() => {
    output.write("assistant output\n");
    frame = "prompt updated";
  });
  assert.equal(output.writes.length, 1);
  const write = output.writes[0];
  const eraseIndex = write.indexOf("\x1b[J");
  const logIndex = write.indexOf("assistant output");
  const frameIndex = write.indexOf("prompt updated");
  assert.ok(eraseIndex !== -1 && logIndex > eraseIndex && frameIndex > logIndex);

  await Promise.resolve();
  scheduler.advance(16);
  assert.equal(output.writes.length, 1);
  ui.stop();
});

test("atomic output write starts the frame on a fresh line without a trailing newline", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines: ["prompt"], cursorRow: 0, cursorColumn: 6 }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);
  output.writes = [];

  ui.withSuspended(() => output.write("partial"));
  assert.equal(output.writes.length, 1);
  assert.match(output.writes[0], /partial\n/);
  assert.match(output.writes[0], /\r\x1b\[2Kprompt/);
  ui.stop();
});

test("nested suspended writes coalesce into a single atomic write", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines: ["prompt"], cursorRow: 0, cursorColumn: 6 }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);
  output.writes = [];

  ui.withSuspended(() => {
    output.write("outer\n");
    ui.withSuspended(() => output.write("inner\n"));
  });
  assert.equal(output.writes.length, 1);
  const write = output.writes[0];
  assert.match(write, /outer/);
  assert.match(write, /inner/);
  assert.equal((write.match(/prompt/g) || []).length, 1);
  ui.stop();
});

test("suspended write without repaint erases the frame and leaves it cleared", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines: ["prompt"], cursorRow: 0, cursorColumn: 6 }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);
  output.writes = [];

  ui.withSuspended(() => output.write("echo\n"), { render: false });
  assert.equal(output.writes.length, 1);
  assert.match(output.writes[0], /echo/);
  assert.doesNotMatch(output.writes[0], /\x1b\[2Kprompt/);
  ui.stop();
});

test("full-screen clear sequences pass through and drop the frame", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const scheduler = createScheduler();
  const ui = createTerminalUI({
    input,
    output,
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    render: () => ({ lines: ["prompt"], cursorRow: 0, cursorColumn: 6 }),
  });

  ui.start();
  await Promise.resolve();
  scheduler.advance(0);
  output.writes = [];

  ui.withSuspended(() => output.write("\x1b[2J\x1b[H"));
  assert.equal(output.writes.length, 1);
  assert.match(output.writes[0], /\x1b\[2J/);
  ui.stop();
});

function frameWrites(output) {
  return output.writes.filter((value) => value.includes("\x1b[?2026h")).length;
}
