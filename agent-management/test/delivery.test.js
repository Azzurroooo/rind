import test from "node:test";
import assert from "node:assert/strict";
import { fixture, eventually } from "./fixture.js";

// A conversation delegates; its results come back as one delivery once all of its work has settled.
async function leaderConversation(f, runtimeSessionId = "leader-chat") {
  const session = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id, runtimeSessionId });
  return { session, actor: { kind: "agent", sessionId: session.id } };
}
async function finishDelegation(f, taskId, reply) {
  await eventually(() => f.store.state.delegations[taskId]?.status === "running");
  const start = f.starts.findLast(s => s.input.task.id === taskId);
  start.finish({ content: reply });
}

test("a conversation hears once, when all the work it delegated has settled", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui"), api = await f.member("api");
  const { actor } = await leaderConversation(f);
  const first = await f.call("delegate", { to: ui.id, brief: "Build the page" }, actor);
  const second = await f.call("delegate", { to: api.id, brief: "Build the endpoint" }, actor);
  assert.match(first.next, /delegate\(\{wait: true\}\).*end your turn/);
  assert.equal(Object.keys(f.store.state.tasks).length, 0, "delegations never create user-facing tasks");
  await finishDelegation(f, first.taskId, "Page built");
  await eventually(() => f.store.state.delegations[first.taskId].status === "done");
  assert.deepEqual(f.delivered, [], "nothing arrives while other delegated work is still running");
  await finishDelegation(f, second.taskId, "Endpoint built");
  await eventually(() => f.delivered.length === 1);
  assert.equal(f.delivered[0].runtimeSessionId, "leader-chat");
  assert.match(f.delivered[0].text, /ui · task .* · delivered: Page built/);
  assert.match(f.delivered[0].text, /api · task .* · delivered: Endpoint built/);
  await eventually(() => !Object.keys(f.store.state.deliveries).length);
});

test("a result waits for a conversation that is not hosted, and arrives when it is again", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui");
  const { session, actor } = await leaderConversation(f);
  const task = await f.call("delegate", { to: ui.id, brief: "Build" }, actor);
  await f.call("detachSession", { sessionId: session.id });
  await finishDelegation(f, task.taskId, "Built while away");
  await eventually(() => f.store.state.deliveries[session.id]);
  assert.deepEqual(f.delivered, []);
  await f.call("reattachSession", { sessionId: session.id, runtimeSessionId: "leader-chat" });
  await eventually(() => f.delivered.length === 1);
  assert.match(f.delivered[0].text, /Built while away/);
  await eventually(() => !f.store.state.deliveries[session.id]);
});

test("work the delegator cancels is not reported back; running work can be steered; finished work sent back is reported again", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui"), api = await f.member("api");
  const { actor } = await leaderConversation(f);
  const kept = await f.call("delegate", { to: ui.id, brief: "Build" }, actor);
  const dropped = await f.call("delegate", { to: api.id, brief: "Maybe later" }, actor);
  await eventually(() => f.starts.some(s => s.input.task.id === dropped.taskId));
  await eventually(() => f.starts.some(s => s.input.task.id === kept.taskId));
  await f.call("delegate", { task: dropped.taskId, cancel: true }, actor);
  await eventually(() => f.store.state.delegations[dropped.taskId].status === "cancelled");
  await assert.rejects(f.call("delegate", { task: dropped.taskId, message: "Revive" }, actor), { code: "TASK_FINISHED" });
  const steered = await f.call("delegate", { task: kept.taskId, message: "Keep header compact" }, actor);
  assert.equal(steered.status, "steered");
  const keptStart = f.starts.find(s => s.input.task.id === kept.taskId);
  assert.deepEqual(keptStart.steered, ["From leader: Keep header compact"]);
  await finishDelegation(f, kept.taskId, "First version");
  await eventually(() => f.delivered.length === 1);
  assert.doesNotMatch(f.delivered[0].text, /api/);
  await f.call("delegate", { task: kept.taskId, message: "Add a dark mode" }, actor);
  await eventually(() => f.starts.filter(s => s.input.task.id === kept.taskId).length === 2);
  const again = f.starts.filter(s => s.input.task.id === kept.taskId)[1];
  assert.equal(again.input.input, "From leader: Add a dark mode", "the rerun is told what changed, not the brief again");
  await finishDelegation(f, kept.taskId, "Dark mode added");
  await eventually(() => f.delivered.length === 2);
  assert.match(f.delivered[1].text, /Dark mode added/);
});

test("delegate({ wait: true }) collects settled results in-turn, supports timeout and releaseWait, and prevents duplicate turn-end delivery", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui"), api = await f.member("api");
  const { session, actor } = await leaderConversation(f);
  await f.call("hostTurnStart", { sessionId: session.id, runtimeSessionId: "leader-chat" });
  const first = await f.call("delegate", { to: ui.id, brief: "Part A" }, actor);
  const second = await f.call("delegate", { to: api.id, brief: "Part B" }, actor);
  await eventually(() => f.store.state.delegations[first.taskId]?.status === "running" && f.store.state.delegations[second.taskId]?.status === "running");

  // Wait times out when neither delegation has settled yet.
  const timedOut = await f.call("delegate", { wait: true, timeoutMs: 1000 }, actor);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.settled.length, 0);
  assert.equal(timedOut.running.length, 2);
  assert.match(timedOut.output, /Do not call delegate\(\{wait: true\}\) again; continue local work or end your turn to be resumed automatically when they settle\./);

  // Release wait wakes an active wait immediately without claiming results.
  const waitingPromise = f.call("delegate", { wait: true, timeoutMs: 30000 }, actor);
  await eventually(() => true);
  setTimeout(() => f.service.releaseWait("leader-chat"), 30);
  const released = await waitingPromise;
  assert.equal(released.released, true);
  assert.equal(released.settled.length, 0);

  // When one delegation settles while waiting, wait returns immediately with that settled item and the remaining running item.
  const collectFirst = f.call("delegate", { wait: true, timeoutMs: 30000 }, actor);
  setTimeout(() => { void finishDelegation(f, first.taskId, "Part A ready"); }, 30);
  const firstWait = await collectFirst;
  assert.equal(firstWait.timedOut, false);
  assert.equal(firstWait.settled.length, 1);
  assert.equal(firstWait.settled[0].taskId, first.taskId);
  assert.equal(firstWait.settled[0].reply, "Part A ready");
  assert.equal(firstWait.running.length, 1);
  assert.equal(firstWait.running[0].taskId, second.taskId);
  assert.match(firstWait.output, /ui · task .* · delivered: Part A ready/);

  // Re-reading a specific settled task by ID still returns its result.
  const reread = await f.call("delegate", { wait: true, task: first.taskId }, actor);
  assert.equal(reread.settled.length, 1);
  assert.equal(reread.settled[0].reply, "Part A ready");

  // Finish the second delegation while the turn is active, then call wait({ wait: true }) which returns immediately (0ms).
  await finishDelegation(f, second.taskId, "Part B ready");
  await eventually(() => f.store.state.delegations[second.taskId].status === "done");
  const secondWait = await f.call("delegate", { wait: true }, actor);
  assert.equal(secondWait.settled.length, 1);
  assert.equal(secondWait.settled[0].taskId, second.taskId);
  assert.equal(secondWait.running.length, 0);
  await f.call("hostTurnEnd", { sessionId: session.id, runtimeSessionId: "leader-chat", outcome: "turn_completed" });
  assert.equal(f.delivered.length, 0, "results claimed in-turn via wait are not delivered again on turn end");
});

test("delegate({ task, message, interrupt: true }) stops an active sub-agent run and restarts it with the new instructions", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui");
  const { actor } = await leaderConversation(f);
  const d = await f.call("delegate", { to: ui.id, brief: "Old approach" }, actor);
  await eventually(() => f.starts.some(s => s.input.task.id === d.taskId));
  const interrupted = await f.call("delegate", { task: d.taskId, message: "Switch to new approach", interrupt: true }, actor);
  assert.equal(interrupted.status, "queued");
  assert.equal(interrupted.interrupted, true);
  await eventually(() => f.starts.filter(s => s.input.task.id === d.taskId).length === 2);
  const secondRun = f.starts.filter(s => s.input.task.id === d.taskId)[1];
  assert.equal(secondRun.input.input, "From leader: Switch to new approach");
  secondRun.finish({ content: "Completed with new approach" });
  await eventually(() => f.delivered.length === 1);
  assert.match(f.delivered[0].text, /Completed with new approach/);
});

test("entry task owner can delegate, wait in-turn, and report in a single run; report refuses if settled results were not yet read", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui");
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Deliver feature" });
  await eventually(() => f.store.state.tasks[task.id].status === "running");
  const leaderRun = f.starts.find(s => s.input.task.id === task.id);
  const leaderActor = f.runner(leaderRun);

  // Post a note while the leader's task is running -> steers the active run in place.
  await f.call("postTaskNote", { taskId: task.id, text: "Include unit tests" });
  assert.deepEqual(leaderRun.steered, ["the user noted: Include unit tests"]);

  const sub = await f.call("delegate", { to: ui.id, brief: "Implement widget" }, leaderActor);
  await finishDelegation(f, sub.taskId, "Widget implemented");
  await eventually(() => f.store.state.delegations[sub.taskId].status === "done");

  // Sub-agent finished while leader's turn is still running, so d.returned is still false!
  // Calling report before reading the result via delegate({ wait: true }) is rejected.
  await assert.rejects(
    f.call("report", { outcome: "done", summary: "Premature report" }, leaderActor),
    { code: "WORK_OUTSTANDING" },
  );

  // Leader collects the sub-agent result in-turn using delegate({ wait: true }).
  const waited = await f.call("delegate", { wait: true }, leaderActor);
  assert.equal(waited.settled.length, 1);
  assert.equal(waited.settled[0].reply, "Widget implemented");

  // Now leader can report and finish in the very same run!
  await f.call("report", { outcome: "done", summary: "Feature delivered in one turn", evidence: ["Widget implemented"] }, leaderActor);
  leaderRun.finish({ content: "All done" });
  await eventually(() => f.store.state.tasks[task.id].status === "done");
  assert.equal(f.store.state.tasks[task.id].report.summary, "Feature delivered in one turn");
});

test("delegated sub-agents cannot call report and return their reply or failure directly to the delegator", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui");
  const { actor } = await leaderConversation(f);
  const task = await f.call("delegate", { to: ui.id, brief: "Pick colours" }, actor);
  await eventually(() => f.starts.length === 1);
  await assert.rejects(f.call("report", { blocked: { action: "Choose light or dark" } }, f.runner(f.starts[0])), { code: "NO_TASK" });
  f.starts[0].finish({ content: "Need to know whether to use light or dark palette." });
  await eventually(() => f.delivered.length === 1);
  assert.match(f.delivered[0].text, new RegExp("task " + task.taskId + " · delivered: Need to know whether to use light or dark palette\\."));
});

test("work the Manager assigns reports to the user's Tasks and Inbox, never back into the Manager's conversation", async t => {
  const f = await fixture(t);
  const managerSession = await f.call("attachSession", { manager: true, runtimeSessionId: "manager-chat" });
  const manager = { kind: "manager", sessionId: managerSession.id };
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Plan the release" }, manager);
  await eventually(() => f.store.state.tasks[task.id].status === "running");
  const start = f.starts.findLast(s => s.input.task.id === task.id);
  await f.call("report", { outcome: "done", summary: "Release planned", evidence: ["checked"] }, f.runner(start));
  start.finish({ content: "done" });
  await eventually(() => f.store.state.tasks[task.id].status === "done");
  assert.equal(f.store.state.tasks[task.id].report.summary, "Release planned");
  assert.deepEqual(f.delivered, []);
  assert.deepEqual(f.store.state.deliveries, {});
});

test("a delivery waits while another run owns the delegator's folder, then arrives", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui");
  const { actor } = await leaderConversation(f);
  const delegated = await f.call("delegate", { to: ui.id, brief: "Build" }, actor);
  const busy = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Leader's own task" });
  await eventually(() => f.store.state.tasks[busy.id].status === "running");
  await finishDelegation(f, delegated.taskId, "Built");
  await eventually(() => f.store.state.delegations[delegated.taskId].status === "done");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(f.delivered, [], "the leader's task run owns its folder");
  f.starts.find(s => s.input.task.id === busy.id).finish({ content: "no report" });
  await eventually(() => f.delivered.length === 1);
  assert.match(f.delivered[0].text, /Built/);
});

test("a shared conversation receives settled deliveries even when no window hosts it (connected: false)", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui");
  const session = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id, runtimeSessionId: "shared-leader", shared: true });
  const actor = { kind: "agent", sessionId: session.id };
  const delegated = await f.call("delegate", { to: ui.id, brief: "Build" }, actor);
  await eventually(() => f.store.state.delegations[delegated.taskId]?.status === "running");
  // When no window shows the shared conversation, reconcileSession reports connected: false (replay.hosted === false).
  await f.call("reconcileSession", { sessionId: session.id, connected: false, active: false });
  assert.equal(f.service.isConnected(session.id), false);
  await finishDelegation(f, delegated.taskId, "Delivered to shared session");
  await eventually(() => f.delivered.length === 1);
  assert.equal(f.delivered[0].runtimeSessionId, "shared-leader");
  assert.match(f.delivered[0].text, /Delivered to shared session/);
  assert.equal(f.service.isConnected(session.id), true);
});


test("concurrent single-turn delegate calls start existing and newly registered members in parallel and auto-deliver after wait timeout", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui");
  const { session, actor } = await leaderConversation(f);
  await f.call("hostTurnStart", { sessionId: session.id, runtimeSessionId: "leader-chat" });
  const [first, second] = await Promise.all([
    f.call("delegate", { to: ui.id, brief: "Build UI component" }, actor),
    f.call("delegate", { new: { name: "qa", responsibility: "Verification" }, brief: "Prepare test plan" }, actor),
  ]);
  assert.match(first.next, /Dispatch any other independent delegations/);
  assert.ok(second.agentId && second.workspace);
  await eventually(() => f.store.state.delegations[first.taskId]?.status === "running" && f.store.state.delegations[second.taskId]?.status === "running");

  // Leader checks once with wait, times out, and ends its turn instead of polling in a loop.
  const timedOut = await f.call("delegate", { wait: true, timeoutMs: 1000 }, actor);
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.output, /Do not call delegate\(\{wait: true\}\) again/);
  await f.call("hostTurnEnd", { sessionId: session.id, runtimeSessionId: "leader-chat", outcome: "turn_completed" });

  await finishDelegation(f, first.taskId, "UI component ready");
  await finishDelegation(f, second.taskId, "Test plan ready");
  await eventually(() => f.delivered.length === 1);
  assert.match(f.delivered[0].text, /ui · task .* · delivered: UI component ready/);
  assert.match(f.delivered[0].text, /qa · task .* · delivered: Test plan ready/);
});
