import assert from "node:assert/strict";
import test from "node:test";

import { sigintAction } from "../lib/interrupt-state.js";

test("sigintAction interrupts active turn first and shuts down on repeat", () => {
  assert.equal(sigintAction({ activeTurn: true, interruptRequested: false }), "interrupt");
  assert.equal(sigintAction({ activeTurn: true, interruptRequested: true }), "force-shutdown");
});

test("sigintAction shuts down outside active turn", () => {
  assert.equal(sigintAction({ activeTurn: false, interruptRequested: false }), "shutdown");
});

test("sigintAction forces shutdown while runtime is already closing", () => {
  assert.equal(
    sigintAction({ activeTurn: false, interruptRequested: false, runtimeClosing: true }),
    "force-shutdown",
  );
});
