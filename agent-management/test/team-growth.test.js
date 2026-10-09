import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fixture, eventually } from "./fixture.js";

const git = promisify(execFile);
const commit = (cwd, message) => git("git", ["-c", "user.email=fixture@localhost", "-c", "user.name=Fixture", "commit", "-qam", message], { cwd });

async function repository(f) {
  const cwd = f.leader.canonicalWorkspace;
  await git("git", ["init", "-q"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "source\n");
  await git("git", ["add", "README.md"], { cwd });
  await commit(cwd, "fixture");
  return cwd;
}
async function conversation(f, agentId = f.leader.id) {
  return { kind: "agent", sessionId: (await f.call("attachSession", { agentId, teamId: f.team.id, runtimeSessionId: "chat-" + agentId })).id };
}

test("a leader adds a worktree member on a new branch for a parallel feature and gives it the task", async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  const leader = await conversation(f);
  const result = await f.call("delegate", { new: { name: "feature-a", responsibility: "Feature A", branch: "feature/a" }, brief: "Build feature A" }, leader);
  assert.match(result.workspace, /feature-a$/);
  assert.equal((await readFile(path.join(result.workspace, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "source\n");
  const { stdout } = await git("git", ["branch", "--list", "feature/a"], { cwd: repo });
  assert.match(stdout, /feature\/a/, "the main repository sees the branch");
  const member = f.store.state.memberships[f.team.id + "/" + result.agentId];
  assert.equal(member.responsibility, "Feature A");
  assert.equal((await f.call("snapshot")).memberships.find(m => m.agentId === result.agentId).reportsToAgentId, f.leader.id);
  await eventually(() => f.starts.some(s => s.input.task.id === result.taskId));
  assert.ok(!f.folderCalls.some(([method]) => method === "set"), "a worktree follows its repository's model");
});

test("an empty workspace member starts with the model chosen for its creator, never a copy of settings.json", async t => {
  const f = await fixture(t);
  const leader = await conversation(f);
  const plain = await f.call("delegate", { new: { name: "notes" }, brief: "Write notes" }, leader);
  assert.ok((await stat(plain.workspace)).isDirectory());
  assert.ok(!f.folderCalls.some(([method]) => method === "set"), "nothing chosen for the creator: settings.json stays the default");
  await f.call("setMemberModel", { teamId: f.team.id, agentId: f.leader.id, provider: "deepseek", model: "deepseek-flash" });
  const second = await f.call("delegate", { new: { name: "research" }, brief: "Research" }, leader);
  const [, set] = f.folderCalls.findLast(([method]) => method === "set");
  assert.deepEqual(set, { workspace_root: second.workspace, provider_id: "deepseek", model_id: "deepseek-flash", reasoning_effort: "" });
});

test("only the leader or a member that leads someone adds members, inside the team root", async t => {
  const f = await fixture(t);
  const leaf = await f.member("leaf");
  await assert.rejects(f.call("delegate", { new: { name: "helper" }, brief: "Help" }, await conversation(f, leaf.id)), { code: "FORBIDDEN" });
  const leader = await conversation(f);
  await assert.rejects(f.call("delegate", { new: { name: "../escape" }, brief: "Escape" }, leader), { code: "INVALID_PATH" });
  await assert.rejects(f.call("delegate", { new: { name: "x", branch: "b", repository: f.home }, brief: "Elsewhere" }, leader), { code: "FORBIDDEN" });
});

test("a member is retired once its work is finished and its worktree is clean; the branch stays", async t => {
  const f = await fixture(t);
  const repo = await repository(f);
  const leader = await conversation(f);
  const added = await f.call("delegate", { new: { name: "feature-b", branch: "feature/b" }, brief: "Build B" }, leader);
  await assert.rejects(f.call("delegate", { retire: added.agentId }, leader), { code: "MEMBER_BUSY" });
  await eventually(() => f.starts.length === 1);
  await writeFile(path.join(added.workspace, "README.md"), "changed\n");
  await f.call("report", { outcome: "done", summary: "B built", evidence: [] }, f.runner(f.starts[0]));
  f.starts[0].finish({ content: "done" });
  await eventually(() => f.store.state.tasks[added.taskId].status === "done");
  await assert.rejects(f.call("delegate", { retire: added.agentId }, leader), { code: "WORKTREE_DIRTY" });
  await commit(added.workspace, "feature b");
  const other = await f.member("other");
  await assert.rejects(f.call("delegate", { retire: other.id }, leader), { code: "FORBIDDEN" }, "only members it added");
  assert.deepEqual(await f.call("delegate", { retire: added.agentId }, leader), { retired: added.agentId, kept: "its branch" });
  await assert.rejects(stat(added.workspace), { code: "ENOENT" });
  assert.match((await git("git", ["branch", "--list", "feature/b"], { cwd: repo })).stdout, /feature\/b/);
  assert.equal(f.store.state.memberships[f.team.id + "/" + added.agentId], undefined);
});
