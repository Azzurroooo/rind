import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, appendFile, writeFile, readFile, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../dist/service.js";
import { openStore } from "../dist/store.js";
import { managementPaths } from "../dist/paths.js";
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

test("a named member receives a blocker and its report resumes the blocked owner", async t => {
  const f = await fixture(t);
  const author = await f.member("author"), reviewer = await f.member("reviewer");
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: author.id, brief: "Need a review" });
  await eventually(() => f.starts.length === 1);
  await f.call("updateTask", { taskId: task.id, status: "blocked", blockedOn: { responder: reviewer.id, action: "Confirm the proposed tax category" } });
  f.starts[0].finish({ content: "waiting for review" });
  await eventually(() => f.starts.length === 2);
  const response = f.starts[1];
  assert.equal(response.input.agent.id, reviewer.id);
  await f.call("updateTask", { taskId: response.input.task.id, report: { outcome: "completed", summary: "Category confirmed", evidence: [], artifacts: [] } });
  response.finish({ content: "confirmed" });
  await eventually(() => f.starts.length === 3);
  assert.equal(f.starts[2].input.task.id, task.id);
  assert.match(f.starts[2].input.instructions, /Category confirmed/);
});

test("an answer received before the blocked run exits still resumes its owner", async t => {
  const f = await fixture(t);
  const task = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Need a decision" });
  await eventually(() => f.starts.length === 1);
  await f.call("updateTask", { taskId: task.id, status: "blocked", blockedOn: { responder: "user", action: "Choose A or B" } });
  await f.call("postTaskNote", { taskId: task.id, text: "Use A", answer: true });
  f.starts[0].finish({ content: "waiting" });
  await eventually(() => f.starts.length === 2);
  assert.match(f.starts[1].input.instructions, /Use A/);
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

test("three levels of delegation wait for grandchildren and deliver back through the original task chain", async t => {
  const f = await fixture(t), a = await f.member("a"), a1 = await f.member("a1");
  await f.call("setSupervisor", { teamId: f.team.id, agentId: a1.id, reportsToAgentId: a.id });
  const root = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Integrate" });
  await eventually(() => f.starts.length === 1);
  const mid = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: a.id, brief: "Build" }, { kind: "agent", sessionId: f.starts[0].input.session.id });
  await eventually(() => f.starts.length === 2);
  const leaf = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: a1.id, brief: "Implement" }, { kind: "agent", sessionId: f.starts[1].input.session.id });
  await eventually(() => f.starts.length === 3);
  f.starts[1].finish({ content: "Waiting for a1" });
  await eventually(() => f.store.state.tasks[mid.id].status === "blocked");
  f.starts[0].finish({ content: "Waiting for a" });
  await eventually(() => f.store.state.tasks[root.id].status === "blocked");
  assert.equal(f.starts.length, 3);
  await f.call("updateTask", { taskId: leaf.id, report: { outcome: "done", summary: "Leaf delivery", evidence: [], artifacts: [] } });
  f.starts[2].finish({ content: "Done" });
  await eventually(() => f.starts.length === 4);
  assert.equal(f.starts[3].input.task.id, mid.id);
  assert.equal(f.starts[3].input.session.id, f.starts[1].input.session.id, "continuations preserve session identity");
  await f.call("updateTask", { taskId: mid.id, report: { outcome: "done", summary: "Integrated child", evidence: [], artifacts: [] } });
  f.starts[3].finish({ content: "Done" });
  await eventually(() => f.starts.length === 5);
  assert.equal(f.starts[4].input.task.id, root.id);
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

test("organization enforces direct delegation, subtree visibility and acyclic reassignment", async t => {
  const f = await fixture(t);
  const a = await f.member("a"), a1 = await f.member("a1"), a11 = await f.member("a11"), b = await f.member("b");
  await f.call("setSupervisor", { teamId: f.team.id, agentId: a1.id, reportsToAgentId: a.id });
  await f.call("setSupervisor", { teamId: f.team.id, agentId: a11.id, reportsToAgentId: a1.id });
  const as = async agent => ({ kind: "agent", sessionId: (await f.call("attachSession", { teamId: f.team.id, agentId: agent.id })).id });
  const aActor = await as(a), a1Actor = await as(a1), bActor = await as(b);
  const own = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: a1.id, brief: "Coordinate", start: false }, aActor);
  const child = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: a11.id, brief: "Implement", start: false }, a1Actor);
  await assert.rejects(f.call("assignTask", { teamId: f.team.id, assigneeAgentId: a11.id, brief: "Skip level" }, aActor), { code: "FORBIDDEN" });
  await assert.rejects(f.call("getTask", { taskId: child.id }, bActor), { code: "FORBIDDEN" });
  assert.deepEqual((await f.call("getTeam", { teamId: f.team.id }, aActor)).tasks.map(t => t.id), [own.id, child.id]);
  await assert.rejects(f.call("setSupervisor", { teamId: f.team.id, agentId: a.id, reportsToAgentId: a11.id }), { code: "ORGANIZATION_CYCLE" });
  await assert.rejects(f.call("removeMember", { teamId: f.team.id, agentId: a.id }), { code: "HAS_REPORTS" });
  const added = await f.call("createWorkspace", { teamId: f.team.id, name: "a-new" }, aActor);
  assert.equal((await f.call("snapshot")).memberships.find(m => m.agentId === added.id).reportsToAgentId, a.id);
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

test("member responsibility edits respect team authority and apply to the next run", async t => {
  const f = await fixture(t), specialist = await f.member("reviewer");
  const direct = await f.call("attachSession", { teamId: f.team.id, agentId: specialist.id });
  await assert.rejects(f.call("updateMember", { teamId: f.team.id, agentId: f.leader.id, responsibility: "Bad" }, { kind: "agent", sessionId: direct.id }), { code: "FORBIDDEN" });
  await f.call("updateMember", { teamId: f.team.id, agentId: specialist.id, position: "Reviewer", responsibility: "Review tests and report evidence" });
  await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: specialist.id, brief: "Review" });
  await eventually(() => f.starts.length === 1);
  assert.match(f.starts[0].input.instructions, /Review tests and report evidence/);
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
  const briefing = (await f.call("getTeam", { teamId: f.team.id })).briefing;
  assert.equal(briefing.needsAttention.length, 0);
  assert.equal(briefing.waiting[0].taskId, parent.id);
  assert.equal((await f.call("snapshot")).memberships.find(m => m.agentId === f.leader.id).status, "Delegated");
  await f.call("updateTask", { taskId: child.id, report: { outcome: "done", summary: "Implemented", evidence: [], artifacts: [] } });
  f.starts[1].finish({ content: "done" });
  await eventually(() => f.starts.length === 3);
  assert.equal(f.starts[2].input.task.id, parent.id);
  assert.match(f.starts[2].input.instructions, /Implemented/);
  assert.equal((await f.call("getTeam", { teamId: f.team.id })).briefing.delivered[0].summary, "Implemented");
});

test("team briefings preserve task visibility and members cannot reorder or cancel team work", async t => {
  const f = await fixture(t), specialist = await f.member("specialist");
  const own = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: specialist.id, brief: "Visible task", start: false });
  const privateTask = await f.call("assignTask", { teamId: f.team.id, assigneeAgentId: f.leader.id, brief: "Leader's confidential context", start: false });
  const session = await f.call("attachSession", { teamId: f.team.id, agentId: specialist.id });
  const actor = { kind: "agent", sessionId: session.id };
  const result = await f.call("getTeam", { teamId: f.team.id }, actor);
  assert.deepEqual(result.briefing.inProgress.map(task => task.taskId), [own.id]);
  assert.doesNotMatch(JSON.stringify(result), /confidential/);
  await assert.rejects(f.call("cancelTask", { taskId: own.id }, actor), { code: "FORBIDDEN" });
  await assert.rejects(f.call("setTaskPriority", { taskId: privateTask.id, priority: "high" }, actor), { code: "FORBIDDEN" });
  const manager = await f.call("attachSession", { manager: true });
  assert.equal((await f.call("getTeam", { teamId: f.team.id }, { kind: "manager", sessionId: manager.id })).briefing.inProgress.length, 2);
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
  await symlink(f.leader.canonicalWorkspace, path.join(agent.canonicalWorkspace, "outside"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(f.leader.canonicalWorkspace, "private.txt"), "private");
  await assert.rejects(f.call("publishArtifact", { taskId: task.id, path: "outside/private.txt" }), { code: "INVALID_ARTIFACT" });
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
  assert.equal(await readFile(path.join(home, "events.jsonl"), "utf8"), "");
  await writeFile(path.join(home, "events.jsonl"), previous);
  assert.equal((await openStore(home)).state.teams.t.name, "Second");
  await writeFile(path.join(home, "events.jsonl"), "");
  assert.equal((await openStore(home)).state.teams.t.name, "Second");
});
