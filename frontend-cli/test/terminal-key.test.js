import assert from "node:assert/strict";
import test from "node:test";

import { parseTerminalKey } from "../lib/terminal-key.js";

test("parses text and control keys", () => {
  assert.deepEqual(parseTerminalKey("你"), { kind: "text", name: "", text: "你" });
  assert.equal(parseTerminalKey("\r").name, "enter");
  assert.equal(parseTerminalKey("\x1b").name, "escape");
  assert.deepEqual(parseTerminalKey("\n"), {
    kind: "key",
    name: "j",
    shift: false,
    alt: false,
    ctrl: true,
    text: "",
  });
  assert.equal(parseTerminalKey("\x1f").name, "-");
  assert.equal(parseTerminalKey("\b").name, "backspace");
});

test("parses legacy and SS3 navigation keys", () => {
  assert.equal(parseTerminalKey("\x1b[D").name, "left");
  assert.equal(parseTerminalKey("\x1bOC").name, "right");
  assert.equal(parseTerminalKey("\x1bOH").name, "home");
});

test("parses modified navigation and deletion keys", () => {
  assert.deepEqual(parseTerminalKey("\x1b[1;5D"), {
    kind: "key",
    name: "left",
    shift: false,
    alt: false,
    ctrl: true,
    text: "",
  });
  const deleted = parseTerminalKey("\x1b[3;3~");
  assert.equal(deleted.name, "delete");
  assert.equal(deleted.alt, true);
});

test("parses common shifted enter sequences", () => {
  for (const sequence of ["\x1b\r", "\x1b[13;2u", "\x1b[27;2;13~"]) {
    const event = parseTerminalKey(sequence);
    assert.equal(event.name, "enter");
    assert.equal(event.shift, true);
  }
});

test("parses kitty ctrl-minus", () => {
  const event = parseTerminalKey("\x1b[45;5u");

  assert.equal(event.name, "-");
  assert.equal(event.ctrl, true);
});
