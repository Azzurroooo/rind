import assert from "node:assert/strict";
import test from "node:test";

import { createLineEditor } from "../lib/line-editor.js";

test("line editor inserts text at cursor", () => {
  const editor = createLineEditor("helo");

  editor.handleKey("", { name: "left" });
  editor.handleKey("l", {});

  assert.equal(editor.input(), "hello");
  assert.equal(editor.cursorPosition().column, 4);
});

test("line editor supports backspace delete home and end", () => {
  const editor = createLineEditor("abcd");

  editor.handleKey("", { name: "left" });
  editor.handleKey("", { name: "backspace" });
  assert.equal(editor.input(), "abd");

  editor.handleKey("", { name: "home" });
  editor.handleKey("", { name: "delete" });
  assert.equal(editor.input(), "bd");

  editor.handleKey("", { name: "end" });
  editor.handleKey("!", {});
  assert.equal(editor.input(), "bd!");
});

test("line editor keeps cursor inside bounds", () => {
  const editor = createLineEditor("ab");

  editor.handleKey("", { name: "left" });
  editor.handleKey("", { name: "left" });
  editor.handleKey("", { name: "left" });
  assert.equal(editor.cursorPosition().column, 0);

  editor.handleKey("", { name: "right" });
  editor.handleKey("", { name: "right" });
  editor.handleKey("", { name: "right" });
  assert.equal(editor.cursorPosition().column, 2);
});

test("line editor moves across CJK text by grapheme", () => {
  const editor = createLineEditor("你a好");

  editor.handleKey("", { name: "home" });
  editor.handleKey("", { name: "right" });

  assert.deepEqual(editor.cursorPosition(), { line: 0, column: 1 });
});

test("line editor treats keycap emoji as one cursor cell unit", () => {
  const editor = createLineEditor("9️⃣abc");

  editor.handleKey("", { name: "home" });
  editor.handleKey("", { name: "right" });

  assert.equal(editor.cursorPosition().column, 1);

  editor.handleKey("", { name: "backspace" });

  assert.equal(editor.input(), "abc");
  assert.equal(editor.cursorPosition().column, 0);
});

test("line editor moves across emoji and CJK text by grapheme", () => {
  const editor = createLineEditor("🔟你a");

  editor.handleKey("", { name: "home" });
  editor.handleKey("", { name: "right" });

  assert.equal(editor.cursorPosition().column, 1);
  editor.handleKey("", { name: "right" });
  assert.equal(editor.cursorPosition().column, 2);
});

test("line editor keeps the cursor valid while a grapheme arrives in chunks", () => {
  const editor = createLineEditor();

  editor.handleInput({ kind: "text", text: "9" });
  editor.handleInput({ kind: "text", text: "\ufe0f" });
  editor.handleInput({ kind: "text", text: "\u20e3" });
  editor.handleInput({ kind: "text", text: "a" });

  assert.equal(editor.input(), "9️⃣a");
  assert.deepEqual(editor.cursorPosition(), { line: 0, column: 2 });
});

test("line editor supports multiline insertion and submit semantics", () => {
  const editor = createLineEditor("first");

  assert.equal(editor.handleKey("", { name: "enter", shift: true }), "edit");
  editor.handleKey("second", {});

  assert.equal(editor.input(), "first\nsecond");
  assert.deepEqual(editor.cursorPosition(), { line: 1, column: 6 });
  assert.equal(editor.handleKey("", { name: "enter" }), "submit");
});

test("line editor restores draft while navigating history", () => {
  const editor = createLineEditor();
  editor.addToHistory("first");
  editor.addToHistory("second");
  editor.setInput("draft");

  assert.equal(editor.handleKey("", { name: "up" }), "move");
  assert.equal(editor.cursorPosition().column, 0);
  assert.equal(editor.handleKey("", { name: "up" }), "edit");
  assert.equal(editor.input(), "second");
  assert.equal(editor.handleKey("", { name: "up" }), "edit");
  assert.equal(editor.input(), "first");
  assert.equal(editor.handleKey("", { name: "down" }), "edit");
  assert.equal(editor.input(), "second");
  assert.equal(editor.handleKey("", { name: "down" }), "edit");
  assert.equal(editor.input(), "draft");
});

test("line editor can undo history navigation back to the draft", () => {
  const editor = createLineEditor();
  editor.addToHistory("previous");
  editor.setInput("draft");

  editor.handleKey("", { name: "up" });
  editor.handleKey("", { name: "up" });
  assert.equal(editor.input(), "previous");

  editor.handleKey("", { name: "-", ctrl: true });
  assert.equal(editor.input(), "draft");
});

test("line editor preserves the preferred column across short lines", () => {
  const editor = createLineEditor("abcdef\nx\nabcdef");

  editor.handleKey("", { name: "up" });
  assert.deepEqual(editor.cursorPosition(), { line: 1, column: 1 });
  editor.handleKey("", { name: "up" });
  assert.deepEqual(editor.cursorPosition(), { line: 0, column: 6 });
});

test("line editor navigates soft-wrapped visual lines", () => {
  const editor = createLineEditor("abcdefghij");
  editor.setViewportWidth(8);

  editor.handleKey("", { name: "up" });
  assert.deepEqual(editor.cursorPosition(), { line: 0, column: 3 });
  editor.handleKey("", { name: "down" });
  assert.deepEqual(editor.cursorPosition(), { line: 0, column: 10 });
});

test("line editor keeps wide-character wrapping aligned with the composer", () => {
  const editor = createLineEditor("a你bc好d");
  editor.setViewportWidth(6);
  editor.handleKey("", { name: "home" });
  editor.handleKey("", { name: "right" });

  editor.handleKey("", { name: "down" });

  assert.deepEqual(editor.cursorPosition(), { line: 0, column: 2 });
});

test("line editor includes the virtual row after a full-width ending", () => {
  const editor = createLineEditor("abcdefgh");
  editor.setViewportWidth(6);

  editor.handleKey("", { name: "up" });

  assert.deepEqual(editor.cursorPosition(), { line: 0, column: 2 });
});

test("line editor supports word deletion, undo, and bracketed paste events", () => {
  const editor = createLineEditor("hello world");

  editor.handleInput({ kind: "key", name: "left" });
  assert.equal(editor.cursorPosition().column, 10);
  editor.handleKey("", { name: "left", ctrl: true });
  assert.equal(editor.cursorPosition().column, 6);
  editor.handleKey("", { name: "right", alt: true });
  assert.equal(editor.cursorPosition().column, 11);

  editor.handleKey("", { name: "w", ctrl: true });
  assert.equal(editor.input(), "hello ");
  editor.handleKey("", { name: "-", ctrl: true });
  assert.equal(editor.input(), "hello world");

  editor.handleInput({ kind: "paste", text: "\n\t你\x1b好" });
  assert.equal(editor.input(), "hello world\n    你好");
});
