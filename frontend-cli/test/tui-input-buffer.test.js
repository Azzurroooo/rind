import assert from "node:assert/strict";
import test from "node:test";

import { createInputBuffer, splitSequences } from "../lib/tui/input-buffer.js";

function createBuffer(handlers, scheduler) {
  return createInputBuffer({
    onSequence: (value) => handlers.sequences.push(value),
    onPaste: (value) => handlers.pastes.push(value),
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });
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
  const handlers = { sequences: [], pastes: [] };
  const buffer = createBuffer(handlers, createScheduler());

  buffer.feed("\x1b[");
  buffer.feed("1;5");
  buffer.feed("C");
  buffer.feed("a");

  assert.deepEqual(handlers.sequences, ["\x1b[1;5C", "a"]);
});

test("flushes an incomplete sequence after the disambiguation timeout", () => {
  const scheduler = createScheduler();
  const handlers = { sequences: [], pastes: [] };
  const buffer = createBuffer(handlers, scheduler);

  buffer.feed("\x1b[");
  assert.equal(handlers.sequences.length, 0);
  assert.equal(scheduler.pending(), 1);

  scheduler.advance(10);
  assert.deepEqual(handlers.sequences, ["\x1b["]);
});

test("emits bracketed paste as one atomic event and resumes parsing after it", () => {
  const handlers = { sequences: [], pastes: [] };
  const buffer = createBuffer(handlers, createScheduler());

  buffer.feed("x\x1b[200~line 1\n");
  buffer.feed("line 2\x1b[201~y");

  assert.deepEqual(handlers.sequences, ["x", "y"]);
  assert.deepEqual(handlers.pastes, ["line 1\nline 2"]);
});

test("holds a bracketed paste split across chunks until the terminator arrives", () => {
  const handlers = { sequences: [], pastes: [] };
  const buffer = createBuffer(handlers, createScheduler());

  buffer.feed("\x1b[200~part");
  assert.deepEqual(handlers.pastes, []);
  buffer.feed("ial\x1b[201~");

  assert.deepEqual(handlers.pastes, ["partial"]);
});

test("splitSequences keeps unterminated escapes in the remainder", () => {
  const parsed = splitSequences("ab\x1b[12");
  assert.deepEqual(parsed.sequences, ["a", "b"]);
  assert.equal(parsed.remainder, "\x1b[12");

  const complete = splitSequences("\x1b[H\x1bOAz\x1b]0;t\x07q");
  assert.deepEqual(complete.sequences, ["\x1b[H", "\x1bOA", "z", "\x1b]0;t\x07", "q"]);
  assert.equal(complete.remainder, "");
});
