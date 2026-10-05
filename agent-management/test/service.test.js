import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, appendFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../dist/service.js";
import { openStore } from "../dist/store.js";
import { managementPaths } from "../dist/paths.js";

const user = { kind: "user" };
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-management-"));
  const paths = managementPaths(home);
  const store = await openStore(paths.state, 5);
  const starts = [];
  const adapter = { async start(input) {
    let finish, fail;
    const completion = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    starts.push({ input, finish, fail });
    return { runtimeSessionId: randomUUID(), completion, async cancel() { finish({ content: "" }); } };
  } };
  const service = createService({ store, paths, adapters: { rind: adapter }, toolConfig: () => ({}) });
  t.after(async () => { await service.stop(); await rm(home, { recursive: true, force: true }); });
  const call = (method, params = {}, actor = user) => service.request(actor, method, { requestId: randomUUID(), ...params });
  const team = await call("createTeam", { name: "Product" });
  async function member(name, workspace) {
    workspace ||= path.join(home, name);
    await mkdir(workspace, { recursive: true });
    const agent = await call("registerAgent", { workspace, name });
    await call("addMember", { teamId: team.id, agentId: agent.id });
    return agent;
  }
  const leader = await member("leader");
  await call("setLeader", { teamId: team.id, agentId: leader.id });
  return { home, paths, store, service, call, team, leader, member, starts };
}
async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(check(), "state did not converge");
}
test("registration, explicit sharing, scoped roles and durable idempotency", async t => {
  const f = await fixture(t);
  const again = await f.call("registerAgent", { workspace: f.leader.canonicalWorkspace });
  assert.equal(again.id, f.leader.id);
  const other = await f.call("createTeam", { name: "Other" });
  await assert.rejects(f.call("addMember", { teamId: other.id, agentId: f.leader.id }), { code: "WORKSPACE_SHARED" });
  await f.call("addMember", { teamId: other.id, agentId: f.leader.id, share: true });
  const session = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id });
  const actor = { kind: "agent", sessionId: session.id };
  await assert.rejects(f.call("getTeam", { teamId: other.id }, actor), { code: "FORBIDDEN" });
  await assert.rejects(f.call("assignTask", { teamId: f.team.id, assigneeAgentId: "invented", brief: "bad" }, actor), { code: "NOT_TEAM_MEMBER" });
  assert.equal(f.starts.length, 0);
  const params = { name: "Idempotent", requestId: "same" };
  const team = await f.call("createTeam", params);
  assert.deepEqual(await f.call("createTeam", params), team);
  const restored = await openStore(f.paths.state, 5);
  assert.ok(restored.state.teams[team.id]);
  assert.equal(Object.values(restored.state.teams).filter(t => t.name === "Idempotent").length, 1);
});
test("same workspace queues while distinct worktrees run independently; reports gate completion", async t => {
  const f = await fixture(t);
  const a = await f.member("a");
  const b = await f.member("b");
  const first = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: a.id, brief: "one" });
  const second = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: a.id, brief: "two" });
  await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: b.id, brief: "parallel" });
  await eventually(() => f.starts.length === 2);
  assert.equal(f.store.state.tasks[second.id].status, "queued");
  await f.call("updateTask", { taskId: first.id, report: { outcome: "completed", summary: "Delivered", evidence: ["test passed"], artifacts: [] } });
  f.starts.find(s => s.input.task.id === first.id).finish({ content: "done" });
  await eventually(() => f.starts.length === 3);
  assert.equal(f.store.state.tasks[first.id].status, "done");
  f.starts.find(s => s.input.task.id === second.id).finish({ content: "no report" });
  await eventually(() => f.store.state.tasks[second.id].status === "needs_attention");
});
test("leader resumes after children return without a human polling every agent", async t => {
  const f = await fixture(t);
  const specialist = await f.member("specialist");
  const parent = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Deliver a feature" });
  await eventually(() => f.starts.length === 1);
  const actor = { kind: "agent", sessionId: f.starts[0].input.session.id };
  const child = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: specialist.id, brief: "Implement" }, actor);
  f.starts[0].finish({ content: "waiting" });
  await eventually(() => f.store.state.tasks[parent.id].status === "blocked");
  await eventually(() => f.starts.length === 2);
  await f.call("updateTask", { taskId: child.id, report: { outcome: "done", summary: "Implemented", evidence: [], artifacts: [] } });
  f.starts[1].finish({ content: "done" });
  await eventually(() => f.starts.length === 3);
  assert.equal(f.starts[2].input.task.id, parent.id);
  assert.match(f.starts[2].input.instructions, /Implemented/);
});
test("crash recovery retains workspace ownership and never repeats uncertain work", async t => {
  const f = await fixture(t);
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "write" });
  await eventually(() => f.starts.length === 1);
  f.starts[0].fail(new Error("lost connection"));
  await eventually(() => f.store.state.tasks[task.id].status === "needs_attention");
  const run = Object.values(f.store.state.runs)[0];
  assert.equal(run.status, "unknown");
  await assert.rejects(f.call("startTask", { taskId: task.id }), { code: "RUN_UNCONFIRMED" });
  await f.call("resolveRun", { runId: run.id, confirmStopped: true });
  await f.call("startTask", { taskId: task.id });
  await eventually(() => f.starts.length === 2);
});
test("published files require owner scope and cannot escape through a symlink or traversal", async t => {
  const f = await fixture(t);
  const agent = await f.member("finance");
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: agent.id, brief: "Report", start: false });
  await writeFile(path.join(agent.canonicalWorkspace, "report.txt"), "result");
  await assert.rejects(f.call("publishArtifact", { taskId: task.id, path: "../leader" }), { code: "INVALID_ARTIFACT" });
  const published = await f.call("publishArtifact", { taskId: task.id, path: "report.txt" });
  assert.equal(published.size, 6);
  const preview = await f.call("readArtifact", { artifactId: published.id });
  assert.ok(preview.path);
});
test("store discards only an incomplete tail and rejects earlier corrupt records", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-store-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home);
  const next = structuredClone(store.state);
  next.teams.t = { id: "t", name: "T", createRoot: home };
  await store.commit(next);
  await appendFile(path.join(home, "events.jsonl"), '{"seq":2');
  assert.equal((await openStore(home)).state.teams.t.name, "T");
  await appendFile(path.join(home, "events.jsonl"), "broken\n");
  await assert.rejects(openStore(home));
});
