import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, appendFile, writeFile, readFile, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createService, DEFAULT_MAX_CONCURRENT_RUNS } from "../dist/service.js";
import { openStore } from "../dist/store.js";
import { managementPaths } from "../dist/paths.js";
import { retain, DELEGATION_LIMIT, COMPLETED_TASK_LIMIT, UNBOUND_SESSION_LIMIT } from "../dist/retention.js";
import { emptyState } from "../dist/model.js";
import { fixture, eventually, user } from "./fixture.js";

test("disconnecting a client after stop cannot write to the closed service", async t => {
  const f = await fixture(t);
  const session = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id });
  await f.call("beginRun", { sessionId: session.id });
  await f.service.stop();
  const state = structuredClone(f.store.state);
  await f.service.disconnect([session.id]);
  assert.deepEqual(f.store.state, state, "socket teardown must not enqueue another state commit");
  await assert.rejects(f.call("createTeam", { name: "Too late" }), { code: "SERVICE_STOPPING" });
});

test("task blockers only target the user and resume the owner when answered", async t => {
  const f = await fixture(t);
  const author = await f.member("author"), reviewer = await f.member("reviewer");
  await f.call("setSupervisor", { teamId: f.team.id, agentId: reviewer.id, reportsToAgentId: author.id });
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: author.id, brief: "Need a decision" });
  await eventually(() => f.starts.length === 1);
  await assert.rejects(f.call("report", { blocked: { responder: reviewer.id, action: "Confirm category" } }, f.runner(f.starts[0])), { code: "INVALID_RESPONDER" });
  await f.call("report", { blocked: { action: "Confirm the proposed tax category" } }, f.runner(f.starts[0]));
  f.starts[0].finish({ content: "waiting for user" });
  await eventually(() => f.store.state.tasks[task.id].status === "blocked");
  assert.deepEqual(f.store.state.tasks[task.id].blockedOn, { responder: "user", action: "Confirm the proposed tax category" });
  await f.call("postTaskNote", { taskId: task.id, text: "Category confirmed", answer: true });
  await eventually(() => f.starts.length === 2);
  assert.equal(f.starts[1].input.task.id, task.id);
  assert.match(f.starts[1].input.input, /Category confirmed/, "the owner is told the answer, not its brief again");
});
test("an answer received before the blocked run exits still resumes its owner", async t => {
  const f = await fixture(t);
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Need a decision" });
  await eventually(() => f.starts.length === 1);
  await f.call("report", { blocked: { responder: "user", action: "Choose A or B" } }, f.runner(f.starts[0]));
  await f.call("postTaskNote", { taskId: task.id, text: "Use A", answer: true });
  f.starts[0].finish({ content: "waiting" });
  await eventually(() => f.starts.length === 2);
  assert.match(f.starts[1].input.input, /the user answered your blocker: Use A/);
});
test("changing team scope cannot reuse private conversation history", async t => {
  const f = await fixture(t);
  const other = await f.call("createTeam", { name: "Other" });
  await f.call("addMember", { teamId: other.id, agentId: f.leader.id, share: true });
  const a = await f.call("attachSession", { teamId: f.team.id, agentId: f.leader.id });
  const b = await f.call("attachSession", { teamId: other.id, agentId: f.leader.id });
  await f.call("bindSession", { sessionId: a.id, runtimeSessionId: "private-history" });
  await assert.rejects(f.call("bindSession", { sessionId: b.id, runtimeSessionId: "private-history" }), { code: "SESSION_SCOPE_CONFLICT" });
});
test("import previews and registers legacy files without changing them", async t => {
  const f = await fixture(t);
  const root = path.join(f.home, "legacy"), agentDir = path.join(root, "agents", "main", ".aiteam");
  await mkdir(agentDir, { recursive: true }); await mkdir(path.join(root, ".aiteam"));
  const project = JSON.stringify({ kind: "Project", metadata: { name: "Legacy" }, spec: { main_agent: "main", agents_root: "../agents" } });
  await writeFile(path.join(root, ".aiteam", "project.yaml"), project);
  await writeFile(path.join(agentDir, "agent.yaml"), JSON.stringify({ kind: "Agent", metadata: { name: "Main" }, spec: {} }));
  const preview = await f.call("previewImport", { root });
  const imported = await f.call("importTeam", { root, confirmation: preview.fingerprint });
  assert.equal(imported.name, "Legacy");
  assert.ok(imported.leaderAgentId);
  assert.equal((await f.call("importTeam", { root, confirmation: preview.fingerprint })).id, imported.id);
});

test("three levels of delegation wait for grandchildren and deliver back through the original task chain without creating subtasks", async t => {
  const f = await fixture(t), a = await f.member("a"), a1 = await f.member("a1");
  await f.call("setSupervisor", { teamId: f.team.id, agentId: a1.id, reportsToAgentId: a.id });
  const root = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Integrate" });
  await eventually(() => f.starts.length === 1);
  const mid = await f.call("delegate", { to: a.id, brief: "Build" }, f.runner(f.starts[0]));
  await eventually(() => f.starts.length === 2);
  const leaf = await f.call("delegate", { to: a1.id, brief: "Implement" }, f.runner(f.starts[1]));
  await eventually(() => f.starts.length === 3);
  assert.deepEqual(Object.keys(f.store.state.tasks), [root.id], "only the entry task exists in state.tasks");
  await assert.rejects(f.call("report", { outcome: "done", summary: "Too early", evidence: [] }, f.runner(f.starts[0])), { code: "WORK_OUTSTANDING" });
  await assert.rejects(f.call("report", { outcome: "done", summary: "Not a task", evidence: [] }, f.runner(f.starts[1])), { code: "NO_TASK" });
  f.starts[1].finish({ content: "Waiting for a1" });
  await eventually(() => f.store.state.delegations[mid.taskId].status === "waiting");
  f.starts[0].finish({ content: "Waiting for a" });
  await eventually(() => f.store.state.tasks[root.id].status === "blocked");
  assert.equal(f.starts.length, 3);
  f.starts[2].finish({ content: "Leaf delivery" });
  await eventually(() => f.starts.length === 4);
  assert.equal(f.starts[0].input.delivery, undefined);
  assert.equal(f.starts[1].input.delivery, undefined);
  assert.equal(f.starts[3].input.task.id, mid.taskId);
  assert.equal(f.starts[3].input.session.id, f.starts[1].input.session.id, "continuations preserve session identity");
  assert.equal(f.starts[3].input.delivery, true, "resumed delegation run marks turn as delivery");
  assert.match(f.starts[3].input.input, new RegExp("a1 · task " + leaf.taskId + " · delivered: Leaf delivery"));
  f.starts[3].finish({ content: "Integrated child" });
  await eventually(() => f.starts.length === 5);
  assert.equal(f.starts[4].input.task.id, root.id);
  assert.equal(f.starts[4].input.delivery, true, "resumed task run marks turn as delivery");
  assert.match(f.starts[4].input.input, /Integrated child/);
  assert.doesNotMatch(f.starts[4].input.input, /Leaf delivery/, "each delegator hears from its own reports");
});
test("adding the first member establishes the root without a separate UI mutation", async t => {
  const f = await fixture(t);
  const team = await f.call("createTeam", { name: "New organization" });
  const first = await f.call("createWorkspace", { teamId: team.id, name: "main" });
  const second = await f.call("createWorkspace", { teamId: team.id, name: "member" });
  const snapshot = await f.call("snapshot");
  assert.equal(snapshot.teams.find(t => t.id === team.id).leaderAgentId, first.id);
  assert.equal(snapshot.memberships.find(m => m.agentId === second.id).reportsToAgentId, first.id);
});

test("members delegate only to direct reports and reach nothing beyond delegate and report", async t => {
  const f = await fixture(t);
  const a = await f.member("a"), a1 = await f.member("a1"), a11 = await f.member("a11");
  await f.call("setSupervisor", { teamId: f.team.id, agentId: a1.id, reportsToAgentId: a.id });
  await f.call("setSupervisor", { teamId: f.team.id, agentId: a11.id, reportsToAgentId: a1.id });
  const as = async agent => ({ kind: "agent", sessionId: (await f.call("attachSession", { teamId: f.team.id, agentId: agent.id })).id });
  const aActor = await as(a), a1Actor = await as(a1);
  await f.call("delegate", { to: a1.id, brief: "Coordinate" }, aActor);
  const child = await f.call("delegate", { to: a11.id, brief: "Implement" }, a1Actor);
  const skipped = f.call("delegate", { to: a11.id, brief: "Skip level" }, aActor);
  await assert.rejects(skipped, { code: "NOT_DIRECT_REPORT" });
  await assert.rejects(skipped, error => error.message.includes(a1.id), "the refusal names the direct reports");
  await assert.rejects(f.call("delegate", { to: a1.id, task: child.taskId, brief: "Both" }, aActor), { code: "INVALID_INPUT" });
  for (const method of ["getTask", "assignTask", "snapshot", "createWorkspace", "setMemberModel"]) {
    await assert.rejects(f.call(method, { taskId: child.taskId }, aActor), { code: "FORBIDDEN" }, method);
  }
  await assert.rejects(f.call("delegate", { to: a1.id, brief: "Not a member's tool" }, { kind: "manager", sessionId: aActor.sessionId }), { code: "FORBIDDEN" });
  await assert.rejects(f.call("report", { outcome: "done", summary: "No task", evidence: [] }, aActor), { code: "NO_TASK" });
  await assert.rejects(f.call("setSupervisor", { teamId: f.team.id, agentId: a.id, reportsToAgentId: a11.id }), { code: "ORGANIZATION_CYCLE" });
  await assert.rejects(f.call("removeMember", { teamId: f.team.id, agentId: a.id }), { code: "HAS_REPORTS" });
  await f.call("setLeader", { teamId: f.team.id, agentId: a11.id });
  const roster = (await f.call("snapshot")).memberships;
  assert.equal(roster.filter(m => !m.reportsToAgentId).length, 1);
  assert.equal(roster.find(m => m.agentId === f.leader.id).reportsToAgentId, a11.id);
});
test("feature worktrees stay under the team root, reject reused branches and preserve source files", async t => {
  const f = await fixture(t);
  const git = promisify(execFile);
  const repository = f.leader.canonicalWorkspace;
  await git("git", ["init"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "source\n");
  await git("git", ["add", "README.md"], { cwd: repository });
  await git("git", ["-c", "user.email=fixture@localhost", "-c", "user.name=Fixture", "commit", "-m", "fixture"], { cwd: repository });
  const params = { teamId: f.team.id, name: "feature-a", repository, branch: "feature/a", requestId: "worktree-a" };
  const feature = await f.call("createWorktree", params);
  assert.equal((await f.call("createWorktree", params)).id, feature.id);
  assert.match(feature.canonicalWorkspace, /feature-a$/);
  assert.equal((await readFile(path.join(feature.canonicalWorkspace, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "source\n");
  await assert.rejects(f.call("createWorkspace", { teamId: f.team.id, name: "../escape" }), { code: "INVALID_PATH" });
  await assert.rejects(f.call("createWorktree", { ...params, name: "feature-b", requestId: "worktree-b" }));
  assert.equal(await readFile(path.join(repository, "README.md"), "utf8"), "source\n");
});

test("copy is explicitly confirmed and excludes credentials and symbolic links", async t => {
  const f = await fixture(t);
  const source = f.leader.canonicalWorkspace;
  await writeFile(path.join(source, "invoice.txt"), "invoice");
  await writeFile(path.join(source, ".env"), "SECRET=value");
  const preview = await f.call("previewCopy", { source });
  assert.deepEqual(preview.files, ["invoice.txt"]);
  assert.deepEqual(preview.excluded, [".env"]);
  await assert.rejects(f.call("copyWorkspace", { teamId: f.team.id, name: "copy", source }), { code: "COPY_CONFIRMATION_REQUIRED" });
  const copy = await f.call("copyWorkspace", { teamId: f.team.id, name: "copy", source, confirmation: preview.fingerprint });
  assert.equal(await readFile(path.join(copy.canonicalWorkspace, "invoice.txt"), "utf8"), "invoice");
  await assert.rejects(readFile(path.join(copy.canonicalWorkspace, ".env")), { code: "ENOENT" });
});

test("host admission covers automatic continuations and only replay reconciliation releases an unknown direct run", async t => {
  const f = await fixture(t);
  const direct = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id });
  const other = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id });
  await f.call("bindSession", { sessionId: direct.id, runtimeSessionId: "live" });
  const run = await f.call("hostTurnStart", { sessionId: direct.id, runtimeSessionId: "live" });
  await f.call("hostTurnEnd", { sessionId: direct.id, outcome: "turn_completed", pending: true });
  await assert.rejects(f.call("hostTurnStart", { sessionId: other.id, runtimeSessionId: "other" }), { code: "WORKSPACE_BUSY" });
  await f.service.disconnect([direct.id]);
  assert.equal(f.store.state.runs[run.id].status, "unknown");
  await f.call("reattachSession", { sessionId: direct.id, runtimeSessionId: "live", active: true });
  assert.equal(f.store.state.runs[run.id].status, "running");
  await f.call("hostTurnEnd", { sessionId: direct.id, outcome: "turn_completed", pending: false });
  await f.call("hostTurnStart", { sessionId: other.id, runtimeSessionId: "other" });
  await assert.rejects(f.call("hostTurnStart", { sessionId: direct.id, runtimeSessionId: "live" }), { code: "WORKSPACE_BUSY" });
});

test("registration, explicit sharing and durable idempotency", async t => {
  const f = await fixture(t);
  const again = await f.call("registerAgent", { workspace: f.leader.canonicalWorkspace });
  assert.equal(again.id, f.leader.id);
  const other = await f.call("createTeam", { name: "Other" });
  await assert.rejects(f.call("addMember", { teamId: other.id, agentId: f.leader.id }), { code: "WORKSPACE_SHARED" });
  await f.call("addMember", { teamId: other.id, agentId: f.leader.id, share: true });
  const session = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id });
  await assert.rejects(f.call("delegate", { to: "invented", brief: "bad" }, { kind: "agent", sessionId: session.id }), { code: "NOT_DIRECT_REPORT" });
  assert.equal(f.starts.length, 0);
  const params = { name: "Idempotent", requestId: "same" };
  const team = await f.call("createTeam", params);
  assert.deepEqual(await f.call("createTeam", params), team);
  await f.store.close();
  const restored = await openStore(f.paths.state, 5);
  assert.ok(restored.state.teams[team.id]);
  assert.equal(Object.values(restored.state.teams).filter(t => t.name === "Idempotent").length, 1);
  await restored.close();
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
  const running = f.starts.find(s => s.input.task.id === first.id);
  await f.call("report", { outcome: "completed", summary: "Delivered", evidence: ["test passed"] }, f.runner(running));
  running.finish({ content: "done" });
  await eventually(() => f.starts.length === 3);
  assert.equal(f.store.state.tasks[first.id].status, "done");
  f.starts.find(s => s.input.task.id === second.id).finish({ content: "Verdict: rejected, see line 12." });
  await eventually(() => f.store.state.tasks[second.id].status === "needs_attention");
  assert.equal(f.store.state.tasks[second.id].error, "Execution ended without a delivery report. Its final reply: Verdict: rejected, see line 12.");
});
test("priority affects only queued work, cancellation is durable and status comes from the service", async t => {
  const f = await fixture(t);
  const first = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "First" });
  await eventually(() => f.starts.length === 1);
  const normal = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Normal" });
  const urgent = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Urgent" });
  await f.call("setTaskPriority", { taskId: urgent.id, priority: "high" });
  await assert.rejects(f.call("setTaskPriority", { taskId: first.id, priority: "high" }), { code: "TASK_NOT_QUEUED" });
  let snapshot = await f.call("snapshot");
  assert.match(snapshot.tasks.find(task => task.id === urgent.id).queueReason, /workspace/);
  assert.equal(snapshot.memberships[0].status, "Working");
  f.starts[0].finish({ content: "no report" });
  await eventually(() => f.starts.length === 2);
  assert.equal(f.starts[1].input.task.id, urgent.id);
  // A previous failed delivery must not hide a new live execution.
  snapshot = await f.call("snapshot"); assert.equal(snapshot.memberships[0].status, "Working");
  await f.call("cancelTask", { taskId: normal.id });
  assert.equal(f.store.state.tasks[normal.id].status, "cancelled");
  assert.equal(f.store.state.tasks[normal.id].dispatch, undefined);
  assert.ok(Object.values(f.store.state.notes).some(note => note.taskId === normal.id && note.text === "Cancelled task."));
});

test("member name and responsibility edits respect team authority and apply to the next run", async t => {
  const f = await fixture(t), specialist = await f.member("reviewer");
  const direct = await f.call("attachSession", { teamId: f.team.id, agentId: specialist.id });
  await assert.rejects(f.call("updateMember", { teamId: f.team.id, agentId: f.leader.id, responsibility: "Bad" }, { kind: "agent", sessionId: direct.id }), { code: "FORBIDDEN" });
  await f.call("updateMember", { teamId: f.team.id, agentId: specialist.id, name: "Security Reviewer", position: "Reviewer", responsibility: "Review tests and report evidence" });
  assert.equal((await f.call("snapshot")).agents.find(a => a.id === specialist.id).name, "Security Reviewer");
  await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: specialist.id, brief: "Review" });
  await eventually(() => f.starts.length === 1);
  assert.match(f.starts[0].input.instructions, /You are Security Reviewer/);
  assert.match(f.starts[0].input.instructions, /Review tests and report evidence/);
});
test("leader resumes after children return without a human polling every agent", async t => {
  const f = await fixture(t);
  const specialist = await f.member("specialist");
  const parent = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Deliver a feature" });
  await eventually(() => f.starts.length === 1);
  await f.call("delegate", { to: specialist.id, brief: "Implement" }, f.runner(f.starts[0]));
  f.starts[0].finish({ content: "waiting" });
  await eventually(() => f.store.state.tasks[parent.id].status === "blocked");
  await eventually(() => f.starts.length === 2);
  const briefing = (await f.call("getTeam", { teamId: f.team.id })).briefing;
  assert.equal(briefing.needsAttention.length, 0);
  assert.equal(briefing.waiting[0].taskId, parent.id);
  const snap1 = await f.call("snapshot");
  assert.equal(snap1.memberships.find(m => m.agentId === f.leader.id).status, "Delegated");
  assert.equal(snap1.sessions.find(s => s.taskId === parent.id).status, "Delegated");
  f.starts[1].finish({ content: "Implemented" });
  await eventually(() => f.starts.length === 3);
  assert.equal(f.starts[2].input.task.id, parent.id);
  assert.match(f.starts[2].input.input, /Implemented/);
  assert.doesNotMatch(f.starts[2].input.instructions, /Implemented/, "results arrive as the input, not in the instructions");
  assert.deepEqual((await f.call("getTeam", { teamId: f.team.id })).briefing.delivered, [], "sub-agents never create delivered tasks");
  await f.call("report", { outcome: "done", summary: "Feature complete", evidence: [] }, f.runner(f.starts[2]));
  f.starts[2].finish({ content: "done" });
  await eventually(() => f.store.state.tasks[parent.id].status === "done");

  // Interactive session delegating to a member also shows Delegated on both session and member until returned.
  const direct = await f.call("attachSession", { teamId: f.team.id, agentId: f.leader.id, runtimeSessionId: "r-direct", shared: true });
  await f.call("delegate", { to: specialist.id, brief: "Follow-up check", start: false }, { kind: "agent", sessionId: direct.id });
  const snap2 = await f.call("snapshot");
  assert.equal(snap2.sessions.find(s => s.id === direct.id).status, "Delegated");
  assert.equal(snap2.memberships.find(m => m.agentId === f.leader.id).status, "Delegated");
});
test("members cannot reorder or cancel team work, and the Manager reads every briefing", async t => {
  const f = await fixture(t), specialist = await f.member("specialist");
  const own = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: specialist.id, brief: "Visible task", start: false });
  const other = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Leader's work", start: false });
  const session = await f.call("attachSession", { teamId: f.team.id, agentId: specialist.id });
  const actor = { kind: "agent", sessionId: session.id };
  await assert.rejects(f.call("delegate", { task: own.id, cancel: true }, actor), { code: "FORBIDDEN" });
  await assert.rejects(f.call("setTaskPriority", { taskId: other.id, priority: "high" }, actor), { code: "FORBIDDEN" });
  const manager = await f.call("attachSession", { manager: true });
  assert.equal((await f.call("getTeam", { teamId: f.team.id }, { kind: "manager", sessionId: manager.id })).briefing.inProgress.length, 2);
});
test("crash recovery retains workspace ownership, rolls sub-agent unconfirmed runs up to the entry owner, and never repeats uncertain work", async t => {
  const f = await fixture(t);
  const specialist = await f.member("specialist");
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "write" });
  await eventually(() => f.starts.length === 1);
  await f.call("delegate", { to: specialist.id, brief: "subwork" }, f.runner(f.starts[0]));
  f.starts[0].finish({ content: "delegating" });
  await eventually(() => f.starts.length === 2);
  f.starts[1].fail(new Error("lost connection"));
  await eventually(() => f.store.state.tasks[task.id].status === "needs_attention");
  const run = Object.values(f.store.state.runs).find(r => r.delegationId);
  assert.equal(run.status, "unknown");
  const snap = await f.call("snapshot");
  assert.equal(snap.memberships.find(m => m.agentId === f.leader.id).status, "Unconfirmed", "entry owner is marked Unconfirmed");
  assert.equal(snap.memberships.find(m => m.agentId === specialist.id).status, "Idle", "sub-agent never shows Needs you / Unconfirmed");
  await assert.rejects(f.call("startTask", { taskId: task.id }), { code: "RUN_UNCONFIRMED" });
  await f.call("resolveRun", { runId: run.id, confirmStopped: true });
  await f.call("startTask", { taskId: task.id });
  await eventually(() => f.starts.length === 3);
  assert.equal(f.starts[2].input.task.id, task.id);
});
test("delivered files are copied for the delegator and cannot escape through a symlink or traversal", async t => {
  const f = await fixture(t);
  const agent = await f.member("finance");
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: agent.id, brief: "Report" });
  await eventually(() => f.starts.length === 1);
  const runner = f.runner(f.starts[0]);
  await writeFile(path.join(agent.canonicalWorkspace, "report.txt"), "result");
  await assert.rejects(f.call("report", { outcome: "done", summary: "s", evidence: [], artifacts: ["../leader"] }, runner), { code: "INVALID_ARTIFACT" });
  await symlink(f.leader.canonicalWorkspace, path.join(agent.canonicalWorkspace, "outside"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(f.leader.canonicalWorkspace, "private.txt"), "private");
  await assert.rejects(f.call("report", { outcome: "done", summary: "s", evidence: [], artifacts: ["outside/private.txt"] }, runner), { code: "INVALID_ARTIFACT" });
  await f.call("report", { outcome: "done", summary: "s", evidence: [], artifacts: ["report.txt"] }, runner);
  const [artifactId] = f.store.state.tasks[task.id].report.artifacts;
  const preview = await f.call("readArtifact", { artifactId });
  assert.equal(preview.size, 6);
  assert.equal(path.relative(f.paths.artifacts, preview.path), path.join(f.team.id, "user", task.id, artifactId, "report.txt"));
  assert.equal(await readFile(preview.path, "utf8"), "result");
});
test("store discards only an incomplete tail and rejects earlier corrupt records", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-store-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home);
  const next = structuredClone(store.state);
  next.teams.t = { id: "t", name: "T", createRoot: home };
  await store.commit(next);
  await store.close();
  await appendFile(path.join(home, "events.jsonl"), '{"seq":2');
  const reopened = await openStore(home);
  assert.equal(reopened.state.teams.t.name, "T");
  await reopened.close();
  await appendFile(path.join(home, "events.jsonl"), "broken\n");
  await assert.rejects(openStore(home));
});

test("snapshot rotation recovers before or after the previous journal is truncated", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rind-rotate-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home, 2);
  const first = structuredClone(store.state);
  first.teams.t = { id: "t", name: "First", createRoot: home };
  await store.commit(first);
  const previous = await readFile(path.join(home, "events.jsonl"), "utf8");
  const second = structuredClone(store.state); second.teams.t.name = "Second";
  await store.commit(second);
  await store.close();
  assert.equal(await readFile(path.join(home, "events.jsonl"), "utf8"), "");
  await writeFile(path.join(home, "events.jsonl"), previous);
  const recovered1 = await openStore(home);
  assert.equal(recovered1.state.teams.t.name, "Second");
  await recovered1.close();
  await writeFile(path.join(home, "events.jsonl"), "");
  const recovered2 = await openStore(home);
  assert.equal(recovered2.state.teams.t.name, "Second");
  await recovered2.close();
});

test("team names are unique among live teams, ignoring case and spaces", async t => {
  const f = await fixture(t);
  await f.call("createTeam", { name: "Notes" });
  await assert.rejects(f.call("createTeam", { name: " notes " }), { code: "TEAM_NAME_TAKEN" });
  assert.equal((await f.call("snapshot")).teams.filter(team => team.name.toLowerCase().trim() === "notes").length, 1);
  // A deleted team no longer holds its name.
  const archived = await f.call("createTeam", { name: "Old" });
  await f.call("deleteTeam", { teamId: archived.id, confirmName: "Old" });
  await f.call("createTeam", { name: "Old" });
});
test("the Manager's snapshot is an overview; the user's keeps every detail", async t => {
  const f = await fixture(t);
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Draft", start: false });
  await f.call("postTaskNote", { taskId: task.id, text: "Context" });
  const session = await f.call("attachSession", { manager: true });
  const overview = await f.call("snapshot", {}, { kind: "manager", sessionId: session.id });
  assert.deepEqual(Object.keys(overview).sort(), ["approvals", "omittedTasks", "runs", "tasks", "teams"]);
  assert.equal(overview.tasks[0].id, task.id);
  assert.equal(overview.teams[0].members[0].agentId, f.leader.id);
  const full = await f.call("snapshot");
  assert.ok(full.notes.some(n => n.text === "Context"));
  assert.ok(full.sessions.length && full.memberships.length);
});

test("forgetSession drops a deleted conversation's registration", async t => {
  const f = await fixture(t);
  const session = await f.call("attachSession", { agentId: f.leader.id });
  await f.call("bindSession", { sessionId: session.id, runtimeSessionId: "gone" });

  await f.call("forgetSession", { sessionId: session.id });

  assert.equal(f.store.state.sessions[session.id], undefined, "the registration is dropped");
  assert.ok(Object.values(f.store.state.runs).every(run => run.sessionId !== session.id), "its runs are dropped with it");
  assert.ok((await f.call("snapshot")).sessions.every(item => item.id !== session.id));
});

test("forgetSession refuses while the conversation is running", async t => {
  const f = await fixture(t);
  const session = await f.call("attachSession", { agentId: f.leader.id });
  await f.call("bindSession", { sessionId: session.id, runtimeSessionId: "live" });
  await f.call("beginRun", { sessionId: session.id });

  await assert.rejects(f.call("forgetSession", { sessionId: session.id }), { code: "SESSION_BUSY" });
  assert.ok(f.store.state.sessions[session.id]);
});

test("reconcileSession settles completed turns without false Unconfirmed and restores Delegated parent task when child is active", async t => {
  const f = await fixture(t);
  const specialist = await f.member("specialist");
  const direct = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id, runtimeSessionId: "r-direct", shared: true });
  const directRun = await f.call("hostTurnStart", { sessionId: direct.id, runtimeSessionId: "r-direct" });
  await f.call("reconcileSession", { sessionId: direct.id, connected: false, active: false, outcome: "completed" });
  assert.equal(f.store.state.runs[directRun.id].status, "succeeded", "completed turn state settles run instead of marking it unknown");

  // Parent task yielded waiting on child; after recover() and child reconcile(active: true), parent task returns to Delegated.
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Coordinate" });
  await eventually(() => f.starts.length === 1);
  await f.call("delegate", { to: specialist.id, brief: "Subwork" }, f.runner(f.starts[0]));
  f.starts[0].finish({ content: "Waiting on child" });
  await eventually(() => f.starts.length === 2 && f.store.state.tasks[task.id].status === "blocked");
  const childSessionId = f.starts[1].input.session.id;
  await f.service.recover();
  assert.equal(f.store.state.tasks[task.id].status, "needs_attention");
  await f.call("reconcileSession", { sessionId: childSessionId, connected: true, active: true, outcome: "running" });
  assert.equal(f.store.state.tasks[task.id].status, "blocked");
  assert.equal(f.store.state.tasks[task.id].blockedOn?.responder, "children");
  const snap = await f.call("snapshot");
  assert.equal(snap.memberships.find(m => m.agentId === f.leader.id).status, "Delegated");
  assert.equal(snap.memberships.find(m => m.agentId === specialist.id).status, "Working");
  f.starts[1].finish({ content: "Done" });
});

test("reconcileSession skips state commits when status is unchanged or no active run exists, and heals stale direct unknown runs", async t => {
  const f = await fixture(t);
  const direct = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id, runtimeSessionId: "r-1", shared: true });
  const seqBeforeIdle = f.store.state.seq;
  await f.call("reconcileSession", { sessionId: direct.id, connected: true, active: false });
  assert.equal(f.store.state.seq, seqBeforeIdle, "idle session reconcile short-circuits without committing state");
  assert.equal(f.service.isConnected(direct.id), true);

  const run = await f.call("hostTurnStart", { sessionId: direct.id, runtimeSessionId: "r-1" });
  const observedAt = f.store.state.runs[run.id].lastObservedAt;
  const seqRunning = f.store.state.seq;
  await f.call("reconcileSession", { sessionId: direct.id, connected: true, active: true, needsInput: false, outcome: "running" });
  assert.equal(f.store.state.seq, seqRunning, "unchanged running state does not write events.jsonl");
  assert.equal(f.store.state.runs[run.id].lastObservedAt, observedAt);

  // Stale unknown direct run heals when host reports session is idle and connected, or when same agent starts a new turn.
  await f.service.recover();
  assert.equal(f.store.state.runs[run.id].status, "unknown");
  const nextDirect = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id, runtimeSessionId: "r-2", shared: true });
  const run2 = await f.call("hostTurnStart", { sessionId: nextDirect.id, runtimeSessionId: "r-2" });
  assert.equal(f.store.state.runs[run.id].status, "failed", "new turn on same agent clears stale direct unknown run");
  assert.equal(f.store.state.runs[run2.id].status, "running");
  await f.service.recover();
  assert.equal(f.store.state.runs[run2.id].status, "unknown");
  await f.call("reconcileSession", { sessionId: nextDirect.id, connected: true, active: false });
  assert.equal(f.store.state.runs[run2.id].status, "failed", "connected idle reconcile settles direct unknown run");

  // Unknown delegation run settles when host reports connected+idle (even without terminal outcome), clearing Unconfirmed and unblocking startTask.
  const specialist = await f.member("specialist");
  const parentTask = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Delegate and recover" });
  await eventually(() => f.starts.length === 1);
  const sub = await f.call("delegate", { to: specialist.id, brief: "Subwork" }, f.runner(f.starts[0]));
  f.starts[0].finish({ content: "Waiting on specialist" });
  await eventually(() => f.starts.length === 2);
  const subSessionId = f.starts[1].input.session.id;
  f.starts[1].fail(new Error("runtime connection lost"));
  await eventually(() => {
    const r = Object.values(f.store.state.runs).find(r => r.delegationId === sub.taskId);
    return r?.status === "unknown";
  });
  const subRun = Object.values(f.store.state.runs).find(r => r.delegationId === sub.taskId);
  const seqUnknown = f.store.state.seq;
  await f.call("reconcileSession", { sessionId: subSessionId, connected: false });
  assert.equal(f.store.state.seq, seqUnknown, "disconnected reconcile on already-unknown run skips state commit");
  await assert.rejects(f.call("startTask", { taskId: parentTask.id }), { code: "RUN_UNCONFIRMED" });
  await f.call("reconcileSession", { sessionId: subSessionId, connected: true, active: false });
  assert.equal(f.store.state.runs[subRun.id].status, "failed", "connected idle reconcile settles unknown delegation run");
  await f.call("startTask", { taskId: parentTask.id });
  await eventually(() => f.starts.length === 3, "parent task can restart once the crashed delegation is reconciled as failed");
  f.starts[2].finish({ content: "Handled failure" });
});

test("resolveRun settles delegations, returns direct-session deliveries, and marks running tasks needs_attention; resumed start failure is failed not unknown", async t => {
  const f = await fixture(t);
  const specialist = await f.member("specialist");

  // 1. Direct session delegates to specialist; after recover(), resolving specialist's unknown run returns the failure delivery and clears Delegated.
  const direct = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id, runtimeSessionId: "direct-1", shared: true });
  f.service.setLive([{ id: "direct-1", turn: "idle", watchers: 1 }]);
  const d1 = await f.call("delegate", { to: specialist.id, brief: "Check logs" }, { kind: "agent", sessionId: direct.id });
  await eventually(() => f.starts.length === 1);
  await f.service.recover();
  const d1Run = Object.values(f.store.state.runs).find(r => r.delegationId === d1.taskId);
  assert.equal(d1Run.status, "unknown");
  await f.call("resolveRun", { runId: d1Run.id, confirmStopped: true });
  assert.equal(f.store.state.delegations[d1.taskId].returned, true, "resolveRun wakes delegator and returns settled delegation");
  await eventually(() => f.delivered.some(item => item.runtimeSessionId === "direct-1" && item.text.includes(d1.taskId)) && !f.store.state.deliveries[direct.id]);
  const snapAfterD1 = await f.call("snapshot");
  assert.equal(snapAfterD1.sessions.find(s => s.id === direct.id).status, "Open", "direct session is no longer stuck in Delegated");

  // 2. Direct session's own run is unknown while child delegation finishes; resolving the direct run flushes the waiting delivery.
  const directRun = await f.call("hostTurnStart", { sessionId: direct.id, runtimeSessionId: "direct-1" });
  const d2 = await f.call("delegate", { to: specialist.id, brief: "Second check" }, { kind: "agent", sessionId: direct.id });
  await eventually(() => f.starts.length === 2);
  await f.call("reconcileSession", { sessionId: direct.id, connected: false });
  assert.equal(f.store.state.runs[directRun.id].status, "unknown");
  f.starts[1].finish({ content: "Second check complete" });
  await eventually(() => f.store.state.delegations[d2.taskId].status === "done");
  assert.ok(!f.store.state.delegations[d2.taskId].returned, "held while direct session run is unknown");
  await f.call("reconcileSession", { sessionId: direct.id, connected: true, active: true, outcome: "running" });
  await f.call("reconcileSession", { sessionId: direct.id, connected: false });
  await f.call("resolveRun", { runId: directRun.id, confirmStopped: true });
  assert.equal(f.store.state.delegations[d2.taskId].returned, true, "resolving direct unknown run returns completed child delegation");

  // 3. Entry task run becomes unknown while task is running; resolveRun transitions task from running to needs_attention.
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Build feature" });
  await eventually(() => f.starts.length === 3);
  const taskSessionId = f.starts[2].input.session.id;
  const taskRun = Object.values(f.store.state.runs).find(r => r.taskId === task.id);
  f.starts[2].finish({ content: "" });
  await eventually(() => !f.store.state.runs[taskRun.id] || f.store.state.runs[taskRun.id].status === "succeeded");
  f.store.state.runs[taskRun.id].status = "unknown";
  f.store.state.tasks[task.id].status = "running";
  delete f.store.state.tasks[task.id].error;
  await f.call("resolveRun", { runId: taskRun.id, confirmStopped: true });
  assert.equal(f.store.state.runs[taskRun.id].status, "failed");
  assert.equal(f.store.state.tasks[task.id].status, "needs_attention", "resolveRun transitions stranded running task to needs_attention");

  // 4. Pre-start failure on a resumed run where session.runtimeSessionId is already set: must be 'failed', not 'unknown'.
  assert.ok(f.store.state.sessions[taskSessionId].runtimeSessionId, "session already has runtimeSessionId from first run");
  f.failStartOnce(new Error("transient start failure before prompt"));
  await f.call("startTask", { taskId: task.id });
  await eventually(() => {
    const runs = Object.values(f.store.state.runs).filter(r => r.taskId === task.id);
    return runs.length === 2 && runs.every(r => r.status === "failed");
  });
  const secondRun = Object.values(f.store.state.runs).filter(r => r.taskId === task.id && r.id !== taskRun.id)[0];
  assert.equal(secondRun.status, "failed", "resumed run that fails before starting is marked failed, not unknown");
});

test("direct Manager and Team Member sessions support multi-turn conversation across reopened sessions and auto-heal stale direct runs without WORKSPACE_BUSY", async t => {
  const f = await fixture(t);

  // 1. Legacy shared session followed by Web/Desktop attachSession(shared: false) + bindSession on the same runtimeSessionId.
  const oldShared = await f.call("attachSession", {
    agentId: f.leader.id,
    teamId: f.team.id,
    runtimeSessionId: "rt-member-1",
    shared: true,
  });
  assert.equal(f.store.state.sessions[oldShared.id].shared, true);

  const webAttached = await f.call("attachSession", {
    agentId: f.leader.id,
    teamId: f.team.id,
    shared: false,
  });
  await f.call("bindSession", {
    sessionId: webAttached.id,
    runtimeSessionId: "rt-member-1",
  });
  assert.ok(!f.store.state.sessions[oldShared.id].shared, "bindSession with shared:false clears shared on older duplicate session");

  // Start a turn on webAttached, and end it even if hostTurnEnd receives oldShared.id:
  const turn1 = await f.call("hostTurnStart", { sessionId: webAttached.id, runtimeSessionId: "rt-member-1" });
  assert.equal(f.store.state.runs[turn1.id].status, "running");
  await f.call("hostTurnEnd", { sessionId: oldShared.id, outcome: "completed" });
  assert.equal(f.store.state.runs[turn1.id].status, "succeeded", "hostTurnEnd matches active direct run by runtimeSessionId fallback");

  // Second turn on the same member workspace succeeds immediately without WORKSPACE_BUSY:
  const turn2 = await f.call("hostTurnStart", { sessionId: webAttached.id, runtimeSessionId: "rt-member-1" });
  assert.equal(f.store.state.runs[turn2.id].status, "running");
  await f.call("hostTurnEnd", { sessionId: webAttached.id, outcome: "completed" });
  assert.equal(f.store.state.runs[turn2.id].status, "succeeded");

  // 2. Manager session with a stranded direct run whose runtime session is idle in runtimeSessions:
  const mgr1 = await f.call("attachSession", { manager: true, runtimeSessionId: "rt-mgr-1", shared: false });
  const mgrRun1 = await f.call("hostTurnStart", { sessionId: mgr1.id, runtimeSessionId: "rt-mgr-1" });
  assert.equal(f.store.state.runs[mgrRun1.id].status, "running");

  // Simulate runtime reporting rt-mgr-1 is now idle (previous turn ended while notification was missed), then user sends next message:
  f.service.setLive([{ id: "rt-mgr-1", turn: "idle", watchers: 1 }]);
  const mgrRun2 = await f.call("hostTurnStart", { sessionId: mgr1.id, runtimeSessionId: "rt-mgr-1" });
  assert.equal(f.store.state.runs[mgrRun1.id].status, "succeeded", "previous direct run on same runtimeSessionId is settled automatically");
  assert.equal(f.store.state.runs[mgrRun2.id].status, "running");
  await f.call("hostTurnEnd", { sessionId: mgr1.id, outcome: "completed" });
  assert.equal(f.store.state.runs[mgrRun2.id].status, "succeeded");
});



test("renameTeam enforces uniqueness and authority, updates member instructions, and cancelRun stops direct session runs and child delegations", async t => {
  const f = await fixture(t);
  const specialist = await f.member("specialist");
  const other = await f.call("createTeam", { name: "Platform" });
  const direct = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id, runtimeSessionId: "r-direct", shared: true });

  await assert.rejects(f.call("renameTeam", { teamId: f.team.id, name: "Hacked" }, { kind: "agent", sessionId: direct.id }), { code: "FORBIDDEN" });
  await assert.rejects(f.call("renameTeam", { teamId: f.team.id, name: " platform " }), { code: "TEAM_NAME_TAKEN" });

  // Case-only rename on the same team is allowed; renaming updates instructions on subsequent runs.
  const sameCase = await f.call("renameTeam", { teamId: other.id, name: "PLATFORM" });
  assert.equal(sameCase.name, "PLATFORM");
  const renamed = await f.call("renameTeam", { teamId: f.team.id, name: "Core Infrastructure" });
  assert.equal(renamed.name, "Core Infrastructure");

  await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: specialist.id, brief: "Verify team name" });
  await eventually(() => f.starts.length === 1);
  assert.match(f.starts[0].input.instructions, /in team Core Infrastructure/);
  f.starts[0].finish({ content: "done" });

  // Direct session run with an active child delegation can be cancelled via cancelRun.
  const directRun = await f.call("hostTurnStart", { sessionId: direct.id, runtimeSessionId: "r-direct" });
  const child = await f.call("delegate", { to: specialist.id, brief: "Long search" }, { kind: "agent", sessionId: direct.id });
  await eventually(() => f.starts.length === 2);
  const cancelled = await f.call("cancelRun", { runId: directRun.id });
  assert.equal(cancelled.cancelling, true);
  assert.equal(cancelled.runtimeSessionId, "r-direct");
  assert.equal(f.store.state.runs[directRun.id].status, "cancelled");
  assert.equal(f.store.state.delegations[child.taskId].status, "cancelled");
  await eventually(() => Object.values(f.store.state.runs).find(r => r.delegationId === child.taskId)?.status === "cancelled");
});

test("scheduler caps concurrent active runs at runLimit, reads cli-state.json on startup, and dispatches queued runs when setMaxConcurrentRuns raises the limit", async t => {
  assert.equal(DEFAULT_MAX_CONCURRENT_RUNS, 128);
  const f = await fixture(t, { cliState: { maxConcurrentRuns: 4 } });
  const m1 = await f.member("m1"), m2 = await f.member("m2"), m3 = await f.member("m3"), m4 = await f.member("m4"), m5 = await f.member("m5"), m6 = await f.member("m6");
  const leaderSession = await f.call("attachSession", { agentId: f.leader.id, teamId: f.team.id });
  for (const m of [m1, m2, m3, m4, m5, m6]) {
    await f.call("delegate", { to: m.id, brief: "work " + m.name }, { kind: "agent", sessionId: leaderSession.id });
  }
  await eventually(() => f.starts.length === 4);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.starts.length, 4, "5th and 6th delegations stay queued while 4 runs are active");
  f.starts[0].finish({ content: "done 1" });
  await eventually(() => f.starts.length === 5, "finishing a run frees a slot for the 5th delegation");

  await assert.rejects(f.call("setMaxConcurrentRuns", { maxConcurrentRuns: 5 }), { code: "INVALID_INPUT" });
  await assert.rejects(f.call("setMaxConcurrentRuns", { maxConcurrentRuns: 8 }, { kind: "agent", sessionId: leaderSession.id }), { code: "FORBIDDEN" });
  assert.deepEqual(await f.call("setMaxConcurrentRuns", { maxConcurrentRuns: 8 }), { maxConcurrentRuns: 8 });
  await eventually(() => f.starts.length === 6, "raising runLimit in memory immediately dispatches the remaining queued delegation");
  for (const s of f.starts.slice(1)) s.finish({ content: "done" });
});

test("delegation depth is capped at MAX_DELEGATION_DEPTH and leaf members do not receive the delegate tool", async t => {
  const f = await fixture(t);
  const d1 = await f.member("d1"), d2 = await f.member("d2"), d3 = await f.member("d3"), d4 = await f.member("d4");
  await f.call("setSupervisor", { teamId: f.team.id, agentId: d2.id, reportsToAgentId: d1.id });
  await f.call("setSupervisor", { teamId: f.team.id, agentId: d3.id, reportsToAgentId: d2.id });
  await f.call("setSupervisor", { teamId: f.team.id, agentId: d4.id, reportsToAgentId: d3.id });

  await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "root" });
  await eventually(() => f.starts.length === 1);
  await f.call("delegate", { to: d1.id, brief: "level 1" }, f.runner(f.starts[0]));
  await eventually(() => f.starts.length === 2);
  await f.call("delegate", { to: d2.id, brief: "level 2" }, f.runner(f.starts[1]));
  await eventually(() => f.starts.length === 3);
  await f.call("delegate", { to: d3.id, brief: "level 3" }, f.runner(f.starts[2]));
  await eventually(() => f.starts.length === 4);

  // At depth 3, d3 cannot delegate to d4 (neither in instructions nor via RPC).
  assert.doesNotMatch(f.starts[3].input.instructions, /Delegate parts of the work with delegate/);
  await assert.rejects(
    f.call("delegate", { to: d4.id, brief: "level 4" }, f.runner(f.starts[3])),
    { code: "DELEGATION_DEPTH_EXCEEDED" },
  );
  for (const s of f.starts) s.finish({ content: "done" });
});

test("retain bounds settled delegations and completed tasks with cascading notes/artifacts/runs without evicting bound direct sessions", async t => {
  const state = emptyState();
  state.teams.t1 = { id: "t1", name: "T1", createRoot: "/tmp", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  for (let i = 0; i < DELEGATION_LIMIT + 15; i++) {
    const id = `del-${i}`;
    state.delegations[id] = {
      id, teamId: "t1", originSessionId: "s-origin", fromAgentId: "a1", toAgentId: "a2",
      brief: "b", status: "done", returned: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
  }
  for (let i = 0; i < COMPLETED_TASK_LIMIT + 12; i++) {
    const id = `task-${i}`;
    state.tasks[id] = {
      id, teamId: "t1", assigneeAgentId: "a1", brief: "b", priority: "normal",
      status: "done", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
    state.notes[`note-${i}`] = { id: `note-${i}`, taskId: id, author: "user", text: "n", createdAt: "2026-01-01T00:00:00Z" };
    state.artifacts[`art-${i}`] = { id: `art-${i}`, taskId: id, name: "a", path: "/tmp/a", sha256: "0", size: 1, createdAt: "2026-01-01T00:00:00Z" };
  }
  for (let i = 0; i < 220; i++) {
    const id = `sess-${i}`;
    state.sessions[id] = { id, agentId: "a1", teamId: "t1", runtimeSessionId: `r-${i}`, origin: "direct", shared: true };
  }
  for (let i = 0; i < UNBOUND_SESSION_LIMIT + 15; i++) {
    const id = `unbound-${i}`;
    state.sessions[id] = { id, agentId: "a1", teamId: "t1", runtimeSessionId: "", origin: "direct", shared: true };
  }
  retain(state);
  assert.equal(Object.keys(state.delegations).length, DELEGATION_LIMIT);
  assert.equal(Object.keys(state.tasks).length, COMPLETED_TASK_LIMIT);
  assert.equal(Object.keys(state.notes).length, COMPLETED_TASK_LIMIT);
  assert.equal(Object.keys(state.artifacts).length, COMPLETED_TASK_LIMIT);
  assert.equal(Object.values(state.sessions).filter(s => Boolean(s.runtimeSessionId)).length, 220, "bound direct team sessions are never evicted");
  assert.equal(Object.values(state.sessions).filter(s => !s.runtimeSessionId).length, UNBOUND_SESSION_LIMIT, "leaked unbound sessions are bounded");
});

test("recover settles interrupted runs without runtimeSessionId as failed so subsequent tasks are not stuck queued, and getTask surfaces queueReason", async t => {
  const f = await fixture(t);
  const task1 = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Interrupted before session bound" });
  await eventually(() => f.starts.length === 1);
  const run1 = Object.values(f.store.state.runs).find(r => r.taskId === task1.id);
  // Simulate daemon interruption during adapter.start before runtimeSessionId was bound:
  f.store.state.sessions[run1.sessionId].runtimeSessionId = "";
  delete f.store.state.runs[run1.id].runtimeSessionId;

  const reopened = createService({
    store: f.store,
    paths: f.paths,
    adapters: {
      rind: {
        async start(input) {
          let finish;
          const completion = new Promise(resolve => { finish = resolve; });
          f.starts.push({ input, finish });
          return { runtimeSessionId: randomUUID(), completion, async cancel() { finish({ content: "" }); } };
        },
      },
    },
    toolConfig: () => ({}),
  });
  await reopened.recover();
  assert.equal(f.store.state.runs[run1.id].status, "failed", "unbound interrupted run cannot be reconciled and must settle as failed");
  assert.equal(f.store.state.tasks[task1.id].status, "needs_attention");

  // Starting task1 again now dispatches immediately instead of staying queued forever:
  const restarted = await reopened.request({ kind: "user" }, "startTask", { requestId: "req-restart", taskId: task1.id });
  await eventually(() => f.starts.length === 2);
  assert.equal(f.store.state.tasks[restarted.id].status, "running");

  // While task1 is running on f.leader's workspace, a second task assigned to f.leader is queued and getTask explains why:
  const task2 = await reopened.request({ kind: "user" }, "assignTask", {
    requestId: "req-task2",
    teamId: f.team.id,
    assigneeAgentId: f.leader.id,
    brief: "Queued behind active run",
  });
  assert.equal(task2.status, "queued");
  const detailQueued = await reopened.request({ kind: "user" }, "getTask", { requestId: "req-get2", taskId: task2.id });
  assert.equal(detailQueued.status, "queued");
  assert.equal(detailQueued.queueReason, "Waiting for this workspace to become free");
  for (const s of f.starts) s.finish({ content: "done" });
  await reopened.stop();
});

