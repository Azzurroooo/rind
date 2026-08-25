import assert from "node:assert/strict";
import test from "node:test";

import { createVirtualOutput, createVirtualInput } from "./helpers/virtual-terminal.js";
import { createTui, CURSOR_MARKER } from "../lib/tui/tui.js";
import { Container } from "../lib/tui/component.js";
import { textWidth } from "../lib/text-width.js";

function createHarness({ columns = 20, rows = 6 } = {}) {
  const virtual = createVirtualOutput({ columns, rows });
  const input = createVirtualInput();
  const tui = createTui({
    input,
    output: virtual.output,
    renderIntervalMs: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
  });
  return { tui, input, virtual };
}

class StaticText {
  constructor(text) {
    this.text = text;
  }
  render(width) {
    return [this.text];
  }
}

async function settle(virtual) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await virtual.flush();
}

test("first render writes lines to the screen", async () => {
  const { tui, virtual } = createHarness();
  tui.addChild(new StaticText("hello"));
  tui.start();
  await settle(virtual);
  const viewport = virtual.getViewport();
  assert.equal(viewport[0], "hello");
  tui.stop();
});

test("appending lines extends the frame without erasing previous rows", async () => {
  const { tui, virtual } = createHarness();
  const list = new Container();
  tui.addChild(list);
  tui.start();
  list.addChild(new StaticText("one"));
  await settle(virtual);
  list.addChild(new StaticText("two"));
  tui.requestRender();
  await settle(virtual);
  const viewport = virtual.getViewport();
  assert.equal(viewport[0], "one");
  assert.equal(viewport[1], "two");
  tui.stop();
});

test("updating a line rewrites it in place", async () => {
  const { tui, virtual } = createHarness();
  const holder = new Container();
  const mutable = new StaticText("before");
  holder.addChild(mutable);
  tui.addChild(holder);
  tui.start();
  await settle(virtual);
  mutable.text = "after";
  tui.requestRender();
  await settle(virtual);
  const viewport = virtual.getViewport();
  assert.equal(viewport[0], "after");
  tui.stop();
});

test("shrinking content clears stale tail rows", async () => {
  const { tui, virtual } = createHarness({ rows: 8 });
  const list = new Container();
  tui.addChild(list);
  tui.start();
  for (const text of ["a", "b", "c"]) {
    list.addChild(new StaticText(text));
  }
  tui.requestRender();
  await settle(virtual);
  list.clear();
  list.addChild(new StaticText("only"));
  tui.requestRender();
  await settle(virtual);
  const viewport = virtual.getViewport();
  assert.equal(viewport[0], "only");
  assert.equal(viewport[1], "");
  assert.equal(viewport[2], "");
  tui.stop();
});

test("width change triggers full redraw and replays all content", async () => {
  const { tui, virtual } = createHarness({ columns: 30, rows: 10 });
  const list = new Container();
  tui.addChild(list);
  tui.start();
  list.addChild(new StaticText("history one"));
  list.addChild(new StaticText("history two"));
  await settle(virtual);
  virtual.resize(40, 10);
  await settle(virtual);
  const viewport = virtual.getViewport();
  assert.equal(viewport[0], "history one");
  assert.equal(viewport[1], "history two");
  tui.stop();
});

test("content taller than the screen scrolls and keeps updating the bottom", async () => {
  const rows = 5;
  const { tui, virtual } = createHarness({ columns: 20, rows });
  const list = new Container();
  tui.addChild(list);
  tui.start();
  const total = 12;
  for (let index = 1; index <= total; index += 1) {
    list.addChild(new StaticText(`line-${index}`));
    tui.requestRender();
    await settle(virtual);
  }
  const viewport = virtual.getViewport();
  const nonEmpty = viewport.filter((line) => line.length > 0);
  assert.ok(nonEmpty.length >= 1, "viewport should contain visible lines");
  assert.ok(nonEmpty.includes(`line-${total}`), `bottom of content visible, got ${JSON.stringify(viewport)}`);
  const scrollBuffer = virtual.getScrollBuffer();
  for (let index = 1; index <= total; index += 1) {
    assert.ok(
      scrollBuffer.includes(`line-${index}`),
      `scrollback should keep line-${index}, got ${JSON.stringify(scrollBuffer)}`,
    );
  }
  tui.stop();
});

test("cursor marker positions the hardware cursor", async () => {
  const { tui, virtual } = createHarness({ columns: 20, rows: 6 });
  class PromptLine {
    render() {
      return [`> input${CURSOR_MARKER}`];
    }
  }
  tui.addChild(new PromptLine());
  tui.start();
  await settle(virtual);
  const position = virtual.getCursorPosition();
  assert.deepEqual(position, { x: 7, y: 0 });
  const viewport = virtual.getViewport();
  assert.equal(viewport[0], "> input");
  assert.ok(!viewport[0].includes("\x1b"), "marker stripped from output");
  tui.stop();
});

test("hardware cursor hides when no component emits a focus marker", async () => {
  const virtual = createVirtualOutput({ columns: 20, rows: 6 });
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
  class NoFocus {
    render() {
      return ["plain content"];
    }
  }
  tui.addChild(new NoFocus());
  tui.start();
  await settle(virtual);

  writes.length = 0;
  tui.requestRender(true);
  await settle(virtual);
  assert.ok(!writes.some((w) => w.includes("\x1b[?25h")), "no-marker frames must not reveal the cursor");

  writes.length = 0;
  tui.clearChildren();
  tui.addChild(new StaticText(`focused${CURSOR_MARKER}`));
  tui.requestRender(true);
  await settle(virtual);
  assert.ok(writes.some((w) => w.includes("\x1b[?25h")), "marker frames reveal the cursor");
  assert.equal(virtual.getCursorPosition().y, 0);
  tui.stop();
});

test("styled lines carry no styles across rows", async () => {
  const { tui, virtual } = createHarness({ columns: 40, rows: 6 });
  class Styled {
    render() {
      return ["\x1b[31mred", "\x1b[32mgreen\x1b[0m"];
    }
  }
  tui.addChild(new Styled());
  tui.start();
  await settle(virtual);
  const viewport = virtual.getViewport();
  assert.equal(viewport[0], "red");
  assert.equal(viewport[1], "green");
  tui.stop();
});

test("startup appends below existing terminal content without clearing", async () => {
  const virtual = createVirtualOutput({ columns: 20, rows: 6 });
  const writes = [];
  const recordingOutput = Object.assign(Object.create(virtual.output), {
    write(chunk) {
      writes.push(String(chunk));
      return virtual.output.write(chunk);
    },
  });
  // Simulate shell history already in the terminal before the CLI starts.
  virtual.output.write("shell line one\r\nshell line two\r\n");
  await virtual.flush();

  const input = createVirtualInput();
  const tui = createTui({
    input,
    output: recordingOutput,
    renderIntervalMs: 0,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
  });
  tui.addChild(new StaticText("RIND BANNER"));
  writes.length = 0;
  tui.start();
  await settle(virtual);

  assert.ok(!writes.some((w) => w.includes("\x1b[2J")), "startup must not clear the screen");
  const scroll = virtual.getScrollBuffer();
  assert.ok(scroll.includes("shell line one"), "pre-existing scrollback preserved");
  assert.ok(scroll.includes("shell line two"), "pre-existing scrollback preserved");
  assert.ok(scroll.includes("RIND BANNER"), "banner appended after old content");

  // A forced repaint with unchanged geometry must stay non-destructive.
  writes.length = 0;
  tui.requestRender(true);
  await settle(virtual);
  assert.ok(!writes.some((w) => w.includes("\x1b[2J")), "force never clears on its own");
  tui.stop();
});

test("wide characters are measured correctly on screen", async () => {
  const { tui, virtual } = createHarness({ columns: 20, rows: 6 });
  tui.addChild(new StaticText("你好"));
  tui.start();
  await settle(virtual);
  const viewport = virtual.getViewport();
  assert.equal(viewport[0].trim(), "你好");
  assert.equal(textWidth(viewport[0]), 4);
  tui.stop();
});
