import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantStreamBuffer } from "../lib/assistant-stream-buffer.js";

test("assistant stream buffer holds partial lines while input is active", () => {
  const buffer = createAssistantStreamBuffer();

  assert.equal(buffer.push("hel", true), "");
  assert.equal(buffer.push("lo\nnext", true), "hello\n");
  assert.equal(buffer.flush(), "next");
});

test("assistant stream buffer releases complete lines and keeps the trailing draft", () => {
  const buffer = createAssistantStreamBuffer();

  assert.equal(buffer.push("first\nsecond", true), "first\n");
  assert.equal(buffer.push(" line\nthird", true), "second line\n");
  assert.equal(buffer.flush(), "third");
});

test("assistant stream buffer passes text through when input is inactive", () => {
  const buffer = createAssistantStreamBuffer();

  assert.equal(buffer.push("hel", false), "hel");
  assert.equal(buffer.push("lo", false), "lo");
  assert.equal(buffer.flush(), "");
});
