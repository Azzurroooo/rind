import test from "node:test";
import assert from "node:assert/strict";
import { fixture, eventually } from "./fixture.js";

const report = summary => ({ outcome: "completed", summary, evidence: ["tests pass"], artifacts: [] });

async function deliver(f, assigneeAgentId, brief, teamId = f.team.id) {
  const task = await f.call("assignTask", { teamId, assigneeAgentId, brief });
  await eventually(() => f.starts.some(s => s.input.task.id === task.id));
  await f.call("updateTask", { taskId: task.id, report: report(brief + " delivered") });
  f.starts.find(s => s.input.task.id === task.id).finish({ content: "done" });
  await eventually(() => f.store.state.tasks[task.id].status === "done");
  return f.store.state.tasks[task.id];
}
const activeRunOf = (f, taskId) => Object.values(f.store.state.runs).find(r => r.taskId === taskId && ["starting", "running"].includes(r.status));

test("accepting a delivery records the review and rework goes back to the same owner with feedback", async t => {
  const f = await fixture(t);
  const first = await deliver(f, f.leader.id, "Write the changelog");
  assert.ok(first.deliveredAt, "delivery time is recorded");

  const accepted = await f.call("reviewTask", { taskId: first.id, decision: "accept" });
  assert.equal(accepted.task.review.decision, "accepted");
  await assert.rejects(f.call("reviewTask", { taskId: first.id, decision: "accept" }), { code: "ALREADY_REVIEWED" });

  const second = await deliver(f, f.leader.id, "Draft the release notes");
  await assert.rejects(f.call("reviewTask", { taskId: second.id, decision: "rework" }), { code: "INVALID_INPUT" });
  const sent = await f.call("reviewTask", { taskId: second.id, decision: "rework", feedback: "Mention the migration steps" });
  assert.equal(f.store.state.tasks[second.id].review.decision, "rework");
  assert.equal(f.store.state.tasks[second.id].review.reworkTaskId, sent.rework.id);
  assert.equal(sent.rework.assigneeAgentId, f.leader.id);
  assert.equal(sent.rework.reworkOf, second.id);
  await eventually(() => f.starts.some(s => s.input.task.id === sent.rework.id));
  const instructions = f.starts.find(s => s.input.task.id === sent.rework.id).input.instructions;
  assert.match(instructions, /Mention the migration steps/);
  assert.match(instructions, /Draft the release notes delivered/, "the owner sees the delivery being reworked");
});

test("only the user reviews, and only finished deliveries", async t => {
  const f = await fixture(t);
  const running = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Still going" });
  await eventually(() => f.starts.length === 1);
  await assert.rejects(f.call("reviewTask", { taskId: running.id, decision: "accept" }), { code: "TASK_NOT_DELIVERED" });
  const session = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id });
  await assert.rejects(f.call("reviewTask", { taskId: running.id, decision: "accept" }, { kind: "agent", sessionId: session.id }), { code: "USER_CONFIRMATION_REQUIRED" });
});

test("deleting a team keeps its deliveries read-only and releases its members and conversations", async t => {
  const f = await fixture(t);
  const writer = await f.member("writer");
  const session = await f.call("attachSession", { agentId: writer.id, teamId: f.team.id, runtimeSessionId: "conversation-1" });
  const delivered = await deliver(f, writer.id, "Ship the docs");
  const waiting = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Later", start: false });
  const running = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: writer.id, brief: "Busy" });
  await eventually(() => f.starts.some(s => s.input.task.id === running.id));

  await assert.rejects(f.call("deleteTeam", { teamId: f.team.id, confirmName: "Product" }), { code: "TEAM_BUSY" });
  f.starts.find(s => s.input.task.id === running.id).finish({ content: "no report" });
  await eventually(() => !activeRunOf(f, running.id));
  await assert.rejects(f.call("deleteTeam", { teamId: f.team.id, confirmName: "product" }), { code: "CONFIRMATION_REQUIRED" });

  const result = await f.call("deleteTeam", { teamId: f.team.id, confirmName: "Product" });
  assert.equal(result.archived, true);
  const state = f.store.state;
  assert.ok(state.teams[f.team.id].archive.at);
  assert.equal(state.teams[f.team.id].archive.members[writer.id], "writer", "owner names outlive their registration");
  assert.equal(Object.values(state.memberships).length, 0);
  assert.equal(state.sessions[session.id], undefined, "its conversations become plain sessions in their folders");
  assert.equal(state.tasks[waiting.id].status, "cancelled");
  assert.equal(state.tasks[delivered.id].status, "done");
  assert.deepEqual(Object.keys(state.agents), [], "agents in no team are unregistered");

  const snapshot = await f.call("snapshot");
  assert.deepEqual(snapshot.teams, [], "a deleted team leaves the team list");
  assert.equal(snapshot.tasks.length, 0, "archived work stays out of every live snapshot");
  assert.deepEqual(snapshot.archivedTeams.map(team => team.name), ["Product"]);
  const archive = await f.call("listArchive");
  assert.deepEqual(archive.teams[0].tasks.map(task => task.brief).sort(), ["Busy", "Later", "Ship the docs"]);
  assert.equal((await f.call("getTask", { taskId: delivered.id })).report.summary, "Ship the docs delivered");
  await assert.rejects(f.call("postTaskNote", { taskId: delivered.id, text: "late" }), { code: "TEAM_ARCHIVED" });
  await assert.rejects(f.call("reviewTask", { taskId: delivered.id, decision: "accept" }), { code: "TEAM_ARCHIVED" });
  await assert.rejects(f.call("createWorkspace", { teamId: f.team.id, name: "again" }), { code: "TEAM_ARCHIVED" });
});

test("a team without history is removed completely, and removing a member releases it", async t => {
  const f = await fixture(t);
  const helper = await f.member("helper");
  const session = await f.call("attachSession", { agentId: helper.id, teamId: f.team.id, runtimeSessionId: "helper-chat" });
  await f.call("removeMember", { teamId: f.team.id, agentId: helper.id });
  assert.equal(f.store.state.sessions[session.id], undefined);
  assert.equal(f.store.state.agents[helper.id], undefined, "a member in no other team is unregistered");

  const empty = await f.call("createTeam", { name: "Scratch" });
  assert.deepEqual(await f.call("deleteTeam", { teamId: empty.id, confirmName: "Scratch" }), { archived: false });
  assert.equal(f.store.state.teams[empty.id], undefined);
});

test("Manager deletes empty teams directly but asks the user before deleting history or stopping work", async t => {
  const f = await fixture(t);
  const managerSession = await f.call("attachSession", { manager: true });
  const manager = { kind: "manager", sessionId: managerSession.id };

  const empty = await f.call("createTeam", { name: "Scratch" }, manager);
  assert.deepEqual(await f.call("deleteTeam", { teamId: empty.id }, manager), { archived: false });

  const running = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Long job" });
  await eventually(() => activeRunOf(f, running.id)?.status === "running");
  const run = activeRunOf(f, running.id);
  const asked = await f.call("cancelRun", { runId: run.id }, manager);
  assert.equal(asked.approval.kind, "cancelRun");
  assert.equal(f.store.state.runs[run.id].status, "running", "nothing stops before the user approves");
  assert.equal((await f.call("cancelRun", { runId: run.id }, manager)).approval.id, asked.approval.id, "one request per decision");
  assert.equal((await f.call("snapshot")).approvals.length, 1);
  await assert.rejects(f.call("resolveApproval", { approvalId: asked.approval.id, approve: true }, manager), { code: "USER_CONFIRMATION_REQUIRED" });
  await f.call("resolveApproval", { approvalId: asked.approval.id, approve: true });
  await eventually(() => f.store.state.tasks[running.id].status === "cancelled" && !activeRunOf(f, running.id));

  await deliver(f, f.leader.id, "Keep this");
  const deletion = await f.call("deleteTeam", { teamId: f.team.id }, manager);
  assert.equal(deletion.approval.kind, "deleteTeam");
  assert.deepEqual(await f.call("resolveApproval", { approvalId: deletion.approval.id, approve: false }), { declined: true });
  assert.ok(f.store.state.teams[f.team.id] && !f.store.state.teams[f.team.id].archive);
  const again = await f.call("deleteTeam", { teamId: f.team.id }, manager);
  assert.equal((await f.call("resolveApproval", { approvalId: again.approval.id, approve: true })).archived, true);
  assert.equal(Object.keys(f.store.state.approvals).length, 0);
});

test("an approval whose target is gone expires instead of failing forever", async t => {
  const f = await fixture(t);
  const managerSession = await f.call("attachSession", { manager: true });
  const manager = { kind: "manager", sessionId: managerSession.id };
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Quick" });
  await eventually(() => activeRunOf(f, task.id)?.status === "running");
  const asked = await f.call("cancelRun", { runId: activeRunOf(f, task.id).id }, manager);
  f.starts[0].finish({ content: "finished on its own" });
  await eventually(() => !activeRunOf(f, task.id));
  assert.deepEqual(await f.call("resolveApproval", { approvalId: asked.approval.id, approve: true }), { expired: true });
  assert.equal(Object.keys(f.store.state.approvals).length, 0);
});
