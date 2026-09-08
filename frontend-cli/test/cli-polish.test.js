import test from "node:test";
import assert from "node:assert/strict";

import { sigintAction } from "../lib/interrupt-state.js";
import { createEventController } from "../lib/event-controller.js";
import { cancelledText, promptHintLine, relativeTime, slashDisplayText } from "../lib/rendering.js";

test("sigint arms exit when idle and shuts down on the second press", () => {
  assert.equal(sigintAction({ activeTurn: false, exitArmed: false }), "arm-exit");
  assert.equal(sigintAction({ activeTurn: false, exitArmed: true }), "shutdown");
  assert.equal(sigintAction({ activeTurn: false, runtimeClosing: true }), "force-shutdown");
});

test("relative time formats with pi's thresholds", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  assert.equal(relativeTime("2026-09-09T11:59:40Z", now), "now");
  assert.equal(relativeTime("2026-09-09T11:55:00Z", now), "5m");
  assert.equal(relativeTime("2026-09-09T09:00:00Z", now), "3h");
  assert.equal(relativeTime("2026-09-06T12:00:00Z", now), "3d");
  assert.equal(relativeTime("2026-08-26T12:00:00Z", now), "2w");
  assert.equal(relativeTime("2026-07-11T12:00:00Z", now), "2mo");
  assert.equal(relativeTime("2024-09-09T12:00:00Z", now), "2y");
  assert.equal(relativeTime("not-a-date", now), "");
  assert.equal(relativeTime(null, now), "");
});

test("hint line asks for a second ctrl+c while exit is armed", () => {
  const armed = promptHintLine({ exitArmed: true, frameWidth: 90 });
  assert.match(armed, /press ctrl\+c again to exit/);

  const idle = promptHintLine({ running: false, frameWidth: 90 });
  assert.doesNotMatch(idle, /again to exit/);
});

test("cancelled text reports the elapsed work time", () => {
  assert.match(cancelledText(72_000), /worked for 1m 12s · session preserved/);
  assert.match(cancelledText(0), /session preserved/);
  assert.doesNotMatch(cancelledText(0), /worked for/);
});

test("sessions display shows relative timestamps", () => {
  const updated = new Date(Date.now() - 5 * 60_000).toISOString();
  const text = slashDisplayText({
    type: "sessions",
    sessions: [{ id: "session-a", title: "First", updated_at: updated }],
  });
  assert.match(text, /· 5m/);
  assert.doesNotMatch(text, /T\d\d:/);
});

test("activity label follows the running tool and returns to working on text", async () => {
  const labels = [];
  const controller = createEventController({
    state: { activityElapsedMs: () => 0 },
    output: {
      setActivityLabel: (label) => labels.push(label),
      beginTool() {},
      setStats() {},
    },
  });

  await controller.handle({ kind: "event", event: { type: "tool_requested", tool_call_id: "c1", tool_name: "read_file" } });
  await controller.handle({ kind: "event", event: { type: "assistant_delta", text: "ok" } });

  assert.deepEqual(labels, ["read file", "Working"]);
});
