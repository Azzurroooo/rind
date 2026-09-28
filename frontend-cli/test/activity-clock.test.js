import assert from "node:assert/strict";
import test from "node:test";
import { createCliState } from "../lib/cli-state.js";
import { createCliOutputController } from "../lib/cli-output-controller.js";
import { createTranscript } from "../lib/tui/transcript.js";

test("one owned clock handles work and waiting, then stops without stale callbacks", () => {
  const state = createCliState();
  state.runtime.status = "ready";
  let time = 1000;
  let renders = 0;
  let color = true;
  const pending = new Map();
  const controller = createCliOutputController({
    state, transcript: createTranscript(), terminalUi: { requestRender() { renders++; } },
    now: () => time, hasColor: () => color,
    schedule: (callback, delay) => { const id = {}; pending.set(id, { callback, delay }); return id; },
    cancelSchedule: (id) => pending.delete(id),
  });
  controller.refreshInputState();
  assert.equal(pending.size, 0);
  state.turn.active = true;
  controller.refreshInputState();
  for (let i = 0; i < 10; i++) controller.beginTool({ tool_call_id: String(i), tool_name: "bash" });
  assert.equal(pending.size, 1);
  assert.equal([...pending.values()][0].delay, 300);
  state.turn.active = false;
  controller.setBackgroundWait({ count: 2, started_at: 1 });
  assert.equal(pending.size, 1);
  assert.equal([...pending.values()][0].delay, 150);
  color = false;
  controller.refreshInputState();
  assert.equal([...pending.values()][0].delay, 1000);
  const [id, tick] = [...pending.entries()][0];
  pending.delete(id);
  time += tick.delay;
  tick.callback();
  assert.equal(pending.size, 1);
  assert.match(controller.mainPromptText(100), /running 00:01/);
  controller.clearActivityTimer();
  assert.equal(pending.size, 0);
  const stopped = renders;
  time += 10000;
  assert.equal(renders, stopped);
});

test("non-TTY turns never start a rendering clock", () => {
  const state = createCliState();
  state.turn.active = true;
  const controller = createCliOutputController({ state, terminalUi: null,
    transcript: null, schedule: () => assert.fail("non-TTY timer") });
  controller.refreshInputState();
});
