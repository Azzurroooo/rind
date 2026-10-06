import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSessions } from "../../rind-runtime-client/live-sessions.js";

function setup() {
  let clock = Date.parse("2026-10-06T12:00:00Z");
  const queue = [], pushes = [];
  const live = createLiveSessions({ onChange: list => pushes.push(list), now: () => clock, schedule: fn => queue.push(fn) });
  const flush = () => { while (queue.length) queue.shift()(); };
  return { live, pushes, flush, advance: ms => { clock += ms; } };
}

test("turn events and viewers become one compact table, pushed once per burst", () => {
  const { live, pushes, flush } = setup();
  const a = {}, b = {};
  live.view(a, "s1", "/w/one");
  live.event({ session_id: "s1", event: { type: "turn_started" } });
  live.event({ session_id: "s1", event: { type: "text_delta" } });
  flush();
  assert.equal(pushes.length, 1, "a burst of changes is one push");
  assert.deepEqual(pushes[0].map(s => [s.id, s.workspace, s.turn, s.watchers]), [["s1", "/w/one", "running", 1]]);
  live.event({ session_id: "s1", event: { type: "user_question_requested" } });
  live.view(b, "s1");
  flush();
  assert.deepEqual(live.list().map(s => [s.turn, s.watchers]), [["question", 2]]);
  live.event({ session_id: "s1", event: { type: "tool_result", tool_name: "ask_user_question" } });
  live.event({ session_id: "s1", event: { type: "turn_completed" } });
  live.leave(a);
  flush();
  assert.deepEqual(live.list().map(s => [s.turn, s.watchers]), [["idle", 1]]);
});

test("a crashed worker ends every running turn instead of leaving it working forever", () => {
  const { live, pushes, flush } = setup();
  live.event({ session_id: "s1", event: { type: "turn_started" } });
  live.event({ session_id: "s2", event: { type: "user_question_requested" } });
  flush(); pushes.length = 0;
  live.reset();
  flush();
  assert.deepEqual(live.list().map(s => s.turn), ["idle", "idle"]);
  assert.equal(pushes.length, 1);
  live.reset(); flush();
  assert.equal(pushes.length, 1, "nothing to report when every turn is already idle");
});

test("a window shows one session at a time, and idle unwatched sessions are forgotten", () => {
  const { live, flush, advance } = setup();
  const w = {};
  live.view(w, "s1", "/w");
  live.view(w, "s2", "/w");
  flush();
  assert.deepEqual(live.list().map(s => [s.id, s.watchers]), [["s1", 0], ["s2", 1]], "switching moves the viewer");
  live.event({ session_id: "s3", event: { type: "turn_started" } });
  advance(11 * 60 * 1000);
  assert.deepEqual(live.list().map(s => s.id), ["s2", "s3"], "watched and running sessions stay");
  live.leave(w);
  assert.deepEqual(live.list().map(s => s.id), ["s3"]);
});
