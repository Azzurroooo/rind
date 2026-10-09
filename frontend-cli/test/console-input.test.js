import test from "node:test";
import assert from "node:assert/strict";
import { releaseInput, takeInput } from "../lib/tui/console-input.js";

// A stand-in for a TTY ReadStream that records the order of console calls.
function console() {
  const calls = [];
  const handle = { reading: true, readStop() { calls.push("readStop"); }, readStart() { calls.push("readStart"); } };
  return {
    calls, _handle: handle, isRaw: true,
    pause() { calls.push("pause"); }, resume() { calls.push("resume"); },
    setRawMode(raw) { calls.push(raw ? "raw" : "cooked"); this.isRaw = raw; },
  };
}

test("input stops reading before it leaves raw mode, so no line read is left pending", () => {
  const input = console();
  releaseInput(input);
  assert.deepEqual(input.calls, ["pause", "readStop", "cooked"]);
  assert.equal(input._handle.reading, false);
});

test("input reads again only once it is raw", () => {
  const input = console();
  releaseInput(input);
  input.calls.length = 0;
  takeInput(input);
  assert.deepEqual(input.calls, ["raw", "resume", "readStart"]);
  assert.equal(input._handle.reading, true);
  takeInput(input);
  assert.equal(input.calls.filter(call => call === "readStart").length, 1, "a handle already reading is not started twice");
});

test("a stream without a console handle only changes mode", () => {
  const input = { isRaw: false, setRawMode(raw) { this.isRaw = raw; }, pause() {}, resume() {} };
  takeInput(input);
  assert.equal(input.isRaw, true);
  releaseInput(input);
  assert.equal(input.isRaw, false);
});
