// A member's model is its workspace's folder default. Only the user and the
// Manager set it; what the Manager changes is listed in the user's Inbox.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.js";

test("the user sets a member's model and effort as its workspace defaults, without a notice", async t => {
  const f = await fixture(t);
  const result = await f.call("setMemberModel", { teamId: f.team.id, agentId: f.leader.id, provider: "deepseek", model: "deepseek-flash", reasoningEffort: "high" });
  const workspace = f.store.state.agents[f.leader.id].canonicalWorkspace;
  assert.deepEqual(f.folderCalls.at(-1), ["set", { workspace_root: workspace, provider_id: "deepseek", model_id: "deepseek-flash", reasoning_effort: "high" }]);
  assert.equal(result.folder.model_id, "deepseek-flash");
  assert.deepEqual(Object.values(f.store.state.notices), [], "the user's own change needs no notice");
  assert.deepEqual((await f.call("getMemberModel", { teamId: f.team.id, agentId: f.leader.id })).folder.reasoning_effort, "high");
  assert.equal((await f.call("listModels")).models[0].id, "deepseek-flash");
});

test("what the Manager changes shows in the user's Inbox until dismissed", async t => {
  const f = await fixture(t);
  const managerSession = await f.call("attachSession", { manager: true });
  const manager = { kind: "manager", sessionId: managerSession.id };
  await f.call("setMemberModel", { teamId: f.team.id, agentId: f.leader.id, reasoningEffort: "low" }, manager);
  await f.call("clearMemberModel", { teamId: f.team.id, agentId: f.leader.id, part: "model" }, manager);

  const notices = (await f.call("snapshot")).notices;
  assert.deepEqual(notices.map(n => n.title), ["Manager set leader's effort low", "Manager cleared leader's model; the default applies"]);
  assert.equal(f.folderCalls.at(-1)[1].group, "model");
  assert.equal((await f.call("snapshot", {}, manager)).notices, undefined, "notices are for the user");
  await assert.rejects(f.call("dismissNotice", { noticeId: notices[0].id }, manager), { code: "USER_CONFIRMATION_REQUIRED" });
  await f.call("dismissNotice", { noticeId: notices[0].id });
  assert.equal((await f.call("snapshot")).notices.length, 1);
});

test("leaders and members cannot choose models, not even their own", async t => {
  const f = await fixture(t);
  const worker = await f.member("worker");
  const leader = { kind: "agent", sessionId: (await f.call("attachSession", { teamId: f.team.id, agentId: f.leader.id })).id };
  for (const [method, params] of [
    ["setMemberModel", { agentId: worker.id, provider: "deepseek", model: "deepseek-flash" }],
    ["setMemberModel", { agentId: f.leader.id, reasoningEffort: "high" }],
    ["clearMemberModel", { agentId: worker.id, part: "model" }],
    ["getMemberModel", { agentId: worker.id }],
    ["listModels", {}],
  ]) await assert.rejects(f.call(method, { teamId: f.team.id, ...params }, leader), { code: "FORBIDDEN" }, method);
  assert.deepEqual(f.folderCalls, [], "nothing reached the runtime");
});

test("a member model needs provider and model together, and a known part to clear", async t => {
  const f = await fixture(t);
  await assert.rejects(f.call("setMemberModel", { teamId: f.team.id, agentId: f.leader.id, model: "deepseek-flash" }), { code: "INVALID_INPUT" });
  await assert.rejects(f.call("setMemberModel", { teamId: f.team.id, agentId: f.leader.id }), { code: "INVALID_INPUT" });
  await assert.rejects(f.call("clearMemberModel", { teamId: f.team.id, agentId: f.leader.id, part: "theme" }), { code: "INVALID_INPUT" });
});

test("a refused change leaves no notice", async t => {
  const f = await fixture(t);
  const managerSession = await f.call("attachSession", { manager: true });
  const manager = { kind: "manager", sessionId: managerSession.id };
  await assert.rejects(f.call("setMemberModel", { teamId: f.team.id, agentId: f.leader.id, provider: "x", model: "missing" }, manager), /not available/);
  assert.deepEqual(Object.values(f.store.state.notices), []);
});

test("a notice goes when its member leaves the team", async t => {
  const f = await fixture(t);
  const worker = await f.member("worker");
  const managerSession = await f.call("attachSession", { manager: true });
  await f.call("setMemberModel", { teamId: f.team.id, agentId: worker.id, reasoningEffort: "low" }, { kind: "manager", sessionId: managerSession.id });
  assert.equal(Object.keys(f.store.state.notices).length, 1);
  await f.call("removeMember", { teamId: f.team.id, agentId: worker.id });
  assert.equal(Object.keys(f.store.state.notices).length, 0);
});
