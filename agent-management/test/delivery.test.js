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
  assert.match(first.next, /End your turn/);
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

test("work the delegator cancels is not reported back; work sent back is reported again", async t => {
  const f = await fixture(t);
  const ui = await f.member("ui"), api = await f.member("api");
  const { actor } = await leaderConversation(f);
  const kept = await f.call("delegate", { to: ui.id, brief: "Build" }, actor);
  const dropped = await f.call("delegate", { to: api.id, brief: "Maybe later", }, actor);
  await eventually(() => f.starts.some(s => s.input.task.id === dropped.taskId));
  await f.call("delegate", { task: dropped.taskId, cancel: true }, actor);
  await eventually(() => f.store.state.delegations[dropped.taskId].status === "cancelled");
  await assert.rejects(f.call("delegate", { task: kept.taskId, message: "More" }, actor), { code: "TASK_IN_PROGRESS" });
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
