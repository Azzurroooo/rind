import assert from "node:assert/strict";
import test from "node:test";

import { sigintAction, createLeaveLatch } from "../lib/interrupt-state.js";

test("sigintAction interrupts active turn first and forces shutdown on repeat", () => {
  assert.equal(sigintAction({ activeTurn: true, interruptRequested: false }), "interrupt");
  assert.equal(sigintAction({ activeTurn: true, interruptRequested: true }), "force-shutdown");
  assert.equal(sigintAction({ activeTurn: true, interruptRequested: false, leaveArmed: true }), "interrupt", "running work is always interrupted first");
});

test("an idle Ctrl+C arms leaving and only a second press leaves", () => {
  assert.equal(sigintAction({ activeTurn: false, interruptRequested: false }), "arm-leave");
  assert.equal(sigintAction({ activeTurn: false, interruptRequested: false, leaveArmed: true }), "leave");
});

test("sigintAction forces shutdown while runtime is already closing", () => {
  assert.equal(sigintAction({ activeTurn: false, interruptRequested: false, runtimeClosing: true }), "force-shutdown");
});

test("the leave latch expires on its own and can be cancelled", () => {
  const timers = [];
  let changes = 0;
  const latch = createLeaveLatch({ onChange: () => changes++, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  latch.arm();
  assert.equal(latch.armed, true);
  assert.equal(timers[0].ms, 2000);
  timers[0].fn();
  assert.equal(latch.armed, false, "the hint disappears after the window");
  latch.arm(); latch.disarm();
  assert.equal(latch.armed, false);
  assert.equal(changes, 4);
});
