import assert from "node:assert/strict";
import test from "node:test";

import { createLineEditor, trailingCellWidth } from "../lib/line-editor.js";

test("line editor inserts text at cursor", () => {
  const editor = createLineEditor("helo");

  editor.handleKey("", { name: "left" });
  editor.handleKey("l", {});

  assert.equal(editor.input(), "hello");
  assert.equal(editor.cursor(), 4);
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
  assert.equal(editor.cursor(), 0);

  editor.handleKey("", { name: "right" });
  editor.handleKey("", { name: "right" });
  editor.handleKey("", { name: "right" });
  assert.equal(editor.cursor(), 2);
});

test("line editor reports trailing display width", () => {
  const editor = createLineEditor("你a好");

  editor.handleKey("", { name: "home" });
  editor.handleKey("", { name: "right" });

  assert.equal(trailingCellWidth(editor.input(), editor.cursor()), 3);
});

test("line editor treats keycap emoji as one cursor cell unit", () => {
  const editor = createLineEditor("9️⃣abc");

  editor.handleKey("", { name: "home" });
  editor.handleKey("", { name: "right" });

  assert.equal(editor.cursor(), 1);
  assert.equal(trailingCellWidth(editor.input(), editor.cursor()), 3);

  editor.handleKey("", { name: "backspace" });

  assert.equal(editor.input(), "abc");
  assert.equal(editor.cursor(), 0);
});

test("line editor measures emoji and cjk trailing width", () => {
  const editor = createLineEditor("🔟你a");

  editor.handleKey("", { name: "home" });
  editor.handleKey("", { name: "right" });

  assert.equal(editor.cursor(), 1);
  assert.equal(trailingCellWidth(editor.input(), editor.cursor()), 3);
});
