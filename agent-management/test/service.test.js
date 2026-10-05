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

const user = { kind: "user" };
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
