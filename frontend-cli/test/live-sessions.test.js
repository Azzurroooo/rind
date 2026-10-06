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
  live.view(a, "s1", { workspace: "/w/one" });
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

test("drafts, the newest viewer and what the current worker hosts", () => {
  const { live, flush } = setup();
  const a = { accepts: true }, b = { accepts: false }, c = { accepts: true };
  live.view(a, "s1", { workspace: "/w", draft: true });
  live.view(b, "s1");
  flush();
  assert.equal(live.list()[0].draft, true, "an empty new conversation is a draft");
  assert.equal(live.newestViewer("s1"), b, "the newest viewer wins");
  assert.equal(live.newestViewer("s1", viewer => viewer.accepts), a, "a filter skips viewers that cannot take input");
  live.view(c, "s1");
  live.view(a, "s1");
  assert.equal(live.newestViewer("s1", viewer => viewer.accepts), a, "showing a session again makes the window newest");
  live.event({ session_id: "s1", event: { type: "turn_started" } });
  assert.equal(live.list()[0].draft, false, "the first turn ends the draft");
  assert.equal(live.turn("s1"), "running");
  assert.equal(live.turn("never-opened"), "idle");
  live.view(c, "s2", { draft: true });
  live.reset();
  assert.deepEqual(live.list().map(s => [s.id, s.turn, s.draft]), [["s1", "idle", false], ["s2", "idle", false]], "a crash forgets turns and drafts");
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
  live.view(w, "s1", { workspace: "/w" });
  live.view(w, "s2", { workspace: "/w" });
  flush();
  assert.deepEqual(live.list().map(s => [s.id, s.watchers]), [["s1", 0], ["s2", 1]], "switching moves the viewer");
  live.event({ session_id: "s3", event: { type: "turn_started" } });
  advance(11 * 60 * 1000);
  assert.deepEqual(live.list().map(s => s.id), ["s2", "s3"], "watched and running sessions stay");
  live.leave(w);
  assert.deepEqual(live.list().map(s => s.id), ["s3"]);
});

test("a window covered by Agents does not count as showing its session until it is back", () => {
  const { live, flush, pushes } = setup();
  const a = {}, b = {};
  live.view(a, "s1"); live.view(b, "s2");
  flush(); pushes.length = 0;
  live.hide(a);
  flush();
  assert.deepEqual(live.list().map(s => [s.id, s.watchers]), [["s1", 0], ["s2", 1]], "only on-screen windows make a session Open");
  assert.equal(live.newestViewer("s1"), undefined, "a covered window takes no rind send input");
  live.view(a, "s1", { draft: false });
  assert.equal(live.list().find(s => s.id === "s1").watchers, 0, "a late request does not uncover the window");
  live.hide(a);
  flush();
  assert.equal(pushes.length, 1, "hiding twice is one change");
  live.show(a);
  assert.deepEqual(live.list().map(s => [s.id, s.watchers]), [["s1", 1], ["s2", 1]]);
  assert.equal(live.newestViewer("s1"), a);
  live.hide(b); live.leave(b);
  assert.equal(live.list().find(s => s.id === "s2").watchers, 0);
  live.show(b);
  assert.equal(live.list().find(s => s.id === "s2").watchers, 0, "a closed window never comes back");
});
