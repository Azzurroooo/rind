import test from "node:test";
import assert from "node:assert/strict";
import { fixture, eventually } from "./fixture.js";

// A conversation delegates; its results come back as one delivery once all of its work has settled.
async function leaderConversation(f, runtimeSessionId = "leader-chat") {
  const session = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id, runtimeSessionId });
  return { session, actor: { kind: "agent", sessionId: session.id } };
}
async function deliverTask(f, taskId, summary) {
  await eventually(() => f.store.state.tasks[taskId].status === "running");
  const start = f.starts.findLast(s => s.input.task.id === taskId);
  await f.call("report", { outcome: "done", summary, evidence: ["checked"] }, f.runner(start));
  start.finish({ content: "done" });
}

test("a conversation hears once, when all the work it delegated has settled", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui"), api = await f.member("api");
  const { actor } = await leaderConversation(f);
  const first = await f.call("delegate", { to: ui.id, brief: "Build the page" }, actor);
  const second = await f.call("delegate", { to: api.id, brief: "Build the endpoint" }, actor);
  assert.match(first.next, /End your turn/);
  await deliverTask(f, first.taskId, "Page built");
  await eventually(() => f.store.state.tasks[first.taskId].status === "done");
  assert.deepEqual(f.delivered, [], "nothing arrives while other delegated work is still running");
  await deliverTask(f, second.taskId, "Endpoint built");
  await eventually(() => f.delivered.length === 1);
  assert.equal(f.delivered[0].runtimeSessionId, "leader-chat");
  assert.match(f.delivered[0].text, /ui · task .* · delivered: done\n  Page built\n  Evidence: checked/);
  assert.match(f.delivered[0].text, /api · task .* · delivered: done\n  Endpoint built/);
  await eventually(() => !Object.keys(f.store.state.deliveries).length);
});

test("a result waits for a conversation that is not hosted, and arrives when it is again", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui");
  const { session, actor } = await leaderConversation(f);
  const task = await f.call("delegate", { to: ui.id, brief: "Build" }, actor);
  await f.call("detachSession", { sessionId: session.id });
  await deliverTask(f, task.taskId, "Built while away");
  await eventually(() => f.store.state.deliveries[session.id]);
  assert.deepEqual(f.delivered, []);
  await f.call("reattachSession", { sessionId: session.id, runtimeSessionId: "leader-chat" });
  await eventually(() => f.delivered.length === 1);
  assert.match(f.delivered[0].text, /Built while away/);
  await eventually(() => !f.store.state.deliveries[session.id]);
});

test("work the delegator cancels is not reported back; work sent back is reported again", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui"), api = await f.member("api");
  const { actor } = await leaderConversation(f);
  const kept = await f.call("delegate", { to: ui.id, brief: "Build" }, actor);
  const dropped = await f.call("delegate", { to: api.id, brief: "Maybe later", }, actor);
  await eventually(() => f.starts.some(s => s.input.task.id === dropped.taskId));
  await f.call("delegate", { task: dropped.taskId, cancel: true }, actor);
  await eventually(() => f.store.state.tasks[dropped.taskId].status === "cancelled");
  await assert.rejects(f.call("delegate", { task: kept.taskId, message: "More" }, actor), { code: "TASK_IN_PROGRESS" });
  await deliverTask(f, kept.taskId, "First version");
  await eventually(() => f.delivered.length === 1);
  assert.doesNotMatch(f.delivered[0].text, /api/);
  await f.call("delegate", { task: kept.taskId, message: "Add a dark mode" }, actor);
  await eventually(() => f.starts.filter(s => s.input.task.id === kept.taskId).length === 2);
  const again = f.starts.filter(s => s.input.task.id === kept.taskId)[1];
  assert.equal(again.input.input, "From leader: Add a dark mode", "the rerun is told what changed, not the brief again");
  await deliverTask(f, kept.taskId, "Dark mode added");
  await eventually(() => f.delivered.length === 2);
  assert.match(f.delivered[1].text, /Dark mode added/);
});

test("a blocker routed to the delegator comes back to its conversation", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui");
  const { actor } = await leaderConversation(f);
  const task = await f.call("delegate", { to: ui.id, brief: "Pick colours" }, actor);
  await eventually(() => f.starts.length === 1);
  await f.call("report", { blocked: { responder: f.leader.id, action: "Choose light or dark" } }, f.runner(f.starts[0]));
  f.starts[0].finish({ content: "waiting" });
  await eventually(() => f.delivered.length === 1);
  assert.match(f.delivered[0].text, new RegExp("task " + task.taskId + " · blocked, needs leader: Choose light or dark"));
});

test("the Manager's conversation hears back from work it assigned", async t => {
  const f = await fixture(t);
  const managerSession = await f.call("attachSession", { manager: true, runtimeSessionId: "manager-chat" });
  const manager = { kind: "manager", sessionId: managerSession.id };
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Plan the release" }, manager);
  await deliverTask(f, task.id, "Release planned");
  await eventually(() => f.delivered.length === 1);
  assert.equal(f.delivered[0].runtimeSessionId, "manager-chat");
});
