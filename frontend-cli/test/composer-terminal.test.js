import assert from "node:assert/strict";
import test from "node:test";

import { createComposerTerminal, prepareComposerFrame } from "../lib/composer-terminal.js";

const prompt = [
  "",
  "  ◓ Working (1s) ctrl+c interrupt",
  "  model-a · E:\\project",
  "  ──────────",
  "  › ",
].join("\n");

test("composer keeps activity above model and working directory", () => {
  const frame = prepareComposerFrame({ prompt, inputText: "hello", cursorIndex: 5 }, 40);

  assert.deepEqual(frame.text.split("\n"), [
    "",
    "  ◓ Working (1s) ctrl+c interrupt",
    "  model-a · E:\\project",
    "  ──────────",
    "  › hello",
  ]);
  assert.equal(frame.cursorRow, 4);
  assert.equal(frame.cursorColumn, 9);
});

test("composer wraps long ascii input and tracks cursor position", () => {
  const frame = prepareComposerFrame({ prompt: "\n  › ", inputText: "abcdefghij", cursorIndex: 10 }, 8);

  assert.equal(frame.text, "\n  › abcd\nefghij");
  assert.equal(frame.cursorRow, 2);
  assert.equal(frame.cursorColumn, 6);
});

test("composer wraps wide input without splitting characters", () => {
  const frame = prepareComposerFrame({ prompt: "\n  › ", inputText: "你好吗abc", cursorIndex: 4 }, 8);

  assert.equal(frame.text, "\n  › 你好\n吗abc");
  assert.equal(frame.cursorRow, 2);
  assert.equal(frame.cursorColumn, 3);
});

test("composer keeps cursor stable at the terminal boundary", () => {
  const frame = prepareComposerFrame({ prompt: "\n  › ", inputText: "abcd", cursorIndex: 4 }, 8);

  assert.equal(frame.text, "\n  › abcd\n");
  assert.equal(frame.cursorRow, 2);
  assert.equal(frame.cursorColumn, 0);
});

test("composer places menu after wrapped input rows", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  › ",
    inputText: "abcdefghij",
    cursorIndex: 10,
    menuText: "  Command deck\n  › /help",
  }, 8);

  assert.equal(frame.text, [
    "",
    "  › abcd",
    "efghij",
    "  Command deck",
    "  › /help",
  ].join("\n"));
  assert.equal(frame.endRow, 4);
});

test("composer uses placeholder text without moving the empty input cursor", () => {
  const frame = prepareComposerFrame({ prompt: "\n  › ", placeholder: "Ask Tangerine Rind", inputText: "", cursorIndex: 0 }, 24);

  assert.equal(frame.text, "\n  › Ask Tangerine Rind");
  assert.equal(frame.cursorRow, 1);
  assert.equal(frame.cursorColumn, 4);
});

test("composer terminal clears previous block before redraw and restores cursor", () => {
  const writes = [];
  const moves = [];
  const output = {
    columns: 8,
    write(value) {
      writes.push(value);
    },
  };
  const terminal = {
    width: 8,
    up(value) {
      moves.push(["up", value]);
    },
    down(value) {
      moves.push(["down", value]);
    },
    column(value) {
      moves.push(["column", value]);
    },
    eraseDisplayBelow() {
      moves.push(["erase"]);
    },
  };
  const composer = createComposerTerminal({ output, terminal });

  composer.render({ prompt: "\n  › ", inputText: "abcdefghij", cursorIndex: 10 });
  composer.render({ prompt: "\n  › ", inputText: "abc", cursorIndex: 3 });

  assert.deepEqual(writes, ["\n  › abcd\nefghij", "\n  › abc"]);
  assert.deepEqual(moves, [
    ["column", 7],
    ["up", 2],
    ["column", 1],
    ["erase"],
    ["column", 8],
  ]);
});
