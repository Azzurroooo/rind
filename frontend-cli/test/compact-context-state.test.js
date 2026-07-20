import assert from "node:assert/strict";
import test from "node:test";

import { createCompactContextState } from "../lib/compact-context-state.js";

test("compact context state resets after automatic compact handoff context", () => {
  const state = createCompactContextState();

  assert.equal(state.handleContextBuilt({
    decisions: { auto_compact_token_limit_reached: true },
  }), false);
  assert.equal(state.pending(), true);

  assert.equal(state.handleContextBuilt({ decisions: {} }), true);
  assert.equal(state.pending(), false);
});

test("compact context state tracks hard-limit compaction requests", () => {
  const state = createCompactContextState();

  assert.equal(state.handleContextBuilt({
    decisions: { compact_required: true },
  }), false);
  assert.equal(state.pending(), true);

  assert.equal(state.handleContextBuilt({}), true);
});

test("compact context state clears pending reset on turn settlement", () => {
  const state = createCompactContextState();

  state.handleContextBuilt({ decisions: { auto_compact_token_limit_reached: true } });
  state.clear();

  assert.equal(state.pending(), false);
  assert.equal(state.handleContextBuilt({ decisions: {} }), false);
});
