import assert from "node:assert/strict";
import test from "node:test";

import { sigintAction } from "../lib/interrupt-state.js";

test("sigintAction interrupts active turn first and shuts down on repeat", () => {
  assert.equal(sigintAction({ activeTurn: true, interruptRequested: false }), "interrupt");
  assert.equal(sigintAction({ activeTurn: true, interruptRequested: true }), "force-shutdown");
});

test("sigintAction arms exit when idle and confirms on the second press", () => {
  assert.equal(sigintAction({ activeTurn: false }), "arm-exit");
  assert.equal(sigintAction({ activeTurn: false, exitArmed: true }), "shutdown");
});

test("sigintAction forces shutdown while runtime is already closing", () => {
  assert.equal(
    sigintAction({ activeTurn: false, interruptRequested: false, runtimeClosing: true }),
    "force-shutdown",
  );
});
