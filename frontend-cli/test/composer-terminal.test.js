import assert from "node:assert/strict";
import test from "node:test";

import { prepareComposerFrame } from "../lib/composer-terminal.js";
import { stripAnsi } from "../lib/text-width.js";

const prompt = [
  "",
  "  ◓ Working (1s) ctrl+c interrupt",
  "  Steering: refocus tests",
  "  Queue: summarize",
  "  model-a · E:\\project",
  "  ──────────",
  "  ▷ ",
].join("\n");

test("composer keeps pending input between activity and session details", () => {
  const frame = prepareComposerFrame({ prompt, inputText: "hello", cursor: { line: 0, column: 5 } }, 40);

  assert.deepEqual(frame.lines, [
    "",
    "  ◓ Working (1s) ctrl+c interrupt",
    "  Steering: refocus tests",
    "  Queue: summarize",
    "  model-a · E:\\project",
    "  ──────────",
    "  ▷ hello",
  ]);
  assert.equal(frame.cursorRow, 6);
  assert.equal(frame.cursorColumn, 9);
});

test("composer places an inline menu cursor on the custom answer row", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "",
    menuText: "  Answers\n  · Fast\n  › draft\n    ↑↓ select",
    menuCursor: { line: 2, column: 9 },
  }, 80);

  const customRow = frame.lines.findIndex((line) => stripAnsi(line).includes("› draft"));
  assert.ok(customRow >= 0);
  assert.equal(stripAnsi(frame.lines.join("\n")).match(/draft/g)?.length, 1);
  assert.equal(frame.cursorRow, customRow);
  assert.equal(frame.cursorColumn, 9);
});

test("composer keeps the question visible while the custom answer is edited", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "Which option should be used?",
    menuText: "  Answers\n  › draft\n    ↑↓ select",
    menuCursor: { line: 1, column: 9 },
  }, 80);

  assert.ok(frame.lines.some((line) => stripAnsi(line).includes("Which option should be used?")));
  assert.equal(stripAnsi(frame.lines.join("\n")).match(/draft/g)?.length, 1);
  assert.equal(frame.cursorRow, frame.lines.findIndex((line) => stripAnsi(line).includes("› draft")));
});

test("composer wraps long ascii input and tracks cursor position", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "abcdefghij",
    cursor: { line: 0, column: 10 },
  }, 8);

  assert.equal(frame.lines.join("\n"), "\n  ▷ abcd\n    efgh\n    ij");
  assert.equal(frame.cursorRow, 3);
  assert.equal(frame.cursorColumn, 6);
});

test("composer wraps wide input without splitting characters", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "你好吗abc",
    cursor: { line: 0, column: 4 },
  }, 8);

  assert.equal(frame.lines.join("\n"), "\n  ▷ 你好\n    吗ab\n    c");
  assert.equal(frame.cursorRow, 2);
  assert.equal(frame.cursorColumn, 7);
});

test("composer aligns emoji continuation rows and cursor cells", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "ab🙂你cd",
    cursor: { line: 0, column: 5 },
  }, 10);

  assert.equal(frame.lines.join("\n"), "\n  ▷ ab🙂你\n    cd");
  assert.equal(frame.cursorRow, 2);
  assert.equal(frame.cursorColumn, 5);
});

test("composer keeps cursor stable at the terminal boundary", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "abcd",
    cursor: { line: 0, column: 4 },
  }, 8);

  assert.equal(frame.lines.join("\n"), "\n  ▷ abcd\n    ");
  assert.equal(frame.cursorRow, 2);
  assert.equal(frame.cursorColumn, 4);
});

test("composer places menu after wrapped input rows", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "abcdefghij",
    cursor: { line: 0, column: 10 },
    menuText: "  Command deck\n  › /help",
  }, 8);

  assert.equal(frame.lines.join("\n"), [
    "",
    "  ▷ abcd",
    "    efgh",
    "    ij",
    "  Comman",
    "d deck",
    "  › /hel",
    "p",
  ].join("\n"));
  assert.equal(frame.lines.length, 8);
  assert.equal(frame.focusRow, 6);
});

test("composer uses placeholder text without moving the empty input cursor", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    placeholder: "Ask Rind",
    inputText: "",
    cursor: { line: 0, column: 0 },
  }, 24);

  assert.equal(frame.lines.join("\n"), "\n  ▷ Ask Rind");
  assert.equal(frame.cursorRow, 1);
  assert.equal(frame.cursorColumn, 4);
});

test("composer wraps styled placeholders without counting ANSI sequences", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    placeholder: "\x1b[2mAsk Rind to do anything\x1b[0m",
    inputText: "",
    cursor: { line: 0, column: 0 },
  }, 24);

  assert.deepEqual(frame.lines.map(stripAnsi), ["", "  ▷ Ask Rind to do anyth", "    ing"]);
  assert.match(frame.lines[2], /^ {4}\x1b\[2m/);
  assert.equal(frame.cursorRow, 1);
  assert.equal(frame.cursorColumn, 4);
});

test("composer preserves a style that follows an SGR reset", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    placeholder: "\x1b[0;31mabcdefghij\x1b[0m",
    inputText: "",
    cursor: { line: 0, column: 0 },
  }, 8);

  assert.deepEqual(frame.lines.map(stripAnsi), ["", "  ▷ abcd", "    efgh", "    ij"]);
  assert.match(frame.lines[2], /^ {4}\x1b\[0;31m/);
});

test("composer keeps a cursor before an early-wrapped wide character", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "a你bc好d",
    cursor: { line: 0, column: 1 },
  }, 6);

  assert.equal(frame.cursorRow, 1);
  assert.equal(frame.cursorColumn, 5);
});

test("composer adds a cursor row when input fills the last column", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "abcdefgh",
    cursor: { line: 0, column: 8 },
  }, 6);

  assert.equal(frame.cursorRow, 5);
  assert.equal(frame.cursorColumn, 4);
});

test("composer renders explicit newlines and positions the cursor", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "first\nsecond",
    cursor: { line: 1, column: 3 },
  }, 24);

  assert.equal(frame.lines.join("\n"), "\n  ▷ first\n    second");
  assert.equal(frame.cursorRow, 2);
  assert.equal(frame.cursorColumn, 7);
});

test("composer indents empty logical input lines", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "first\n\nthird",
    cursor: { line: 1, column: 0 },
  }, 24);

  assert.equal(frame.lines.join("\n"), "\n  ▷ first\n    \n    third");
  assert.equal(frame.cursorRow, 2);
  assert.equal(frame.cursorColumn, 4);
});

test("composer counts wrapped rows before a multiline cursor", () => {
  const frame = prepareComposerFrame({
    prompt: "\n  ▷ ",
    inputText: "abcdefghij\nsecond",
    cursor: { line: 1, column: 3 },
  }, 8);

  assert.equal(frame.lines.join("\n"), "\n  ▷ abcd\n    efgh\n    ij\n    seco\n    nd");
  assert.equal(frame.cursorRow, 4);
  assert.equal(frame.cursorColumn, 7);
});
