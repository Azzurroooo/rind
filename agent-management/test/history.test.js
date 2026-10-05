import test from "node:test";
import assert from "node:assert/strict";
import { sessionHistory } from "../dist/history.js";
import { emptyState } from "../dist/model.js";

function fixture() {
  const state = emptyState();
  state.agents.lead = { id: "lead", name: "Lead", canonicalWorkspace: "/w/lead", adapter: "rind" };
  state.agents.dev = { id: "dev", name: "Dev", canonicalWorkspace: "/w/dev", adapter: "rind" };
  state.teams.a = { id: "a", name: "A", leaderAgentId: "lead", createRoot: "/w" };
  state.teams.b = { id: "b", name: "B", createRoot: "/w" };
  state.memberships["a/lead"] = { teamId: "a", agentId: "lead" };
  state.memberships["a/dev"] = { teamId: "a", agentId: "dev", reportsToAgentId: "lead" };
  state.memberships["b/dev"] = { teamId: "b", agentId: "dev" };
  state.sessions.s1 = { id: "s1", agentId: "lead", teamId: "a", runtimeSessionId: "r-team", origin: "direct" };
  state.sessions.s2 = { id: "s2", agentId: "dev", teamId: "b", runtimeSessionId: "r-other-team", origin: "direct" };
  state.sessions.s3 = { id: "s3", agentId: "dev", teamId: "a", runtimeSessionId: "r-unsaved", origin: "managed" };
  state.sessions.s4 = { id: "s4", agentId: "dev", teamId: "a", runtimeSessionId: "", origin: "direct" };
  const histories = {
    "/w/lead": [{ id: "r-team", title: "Untitled", first_user_message: "Plan release", updated_at: "2026-10-06T02:00:00Z" }, { id: "r-private", title: "Private notes", updated_at: "2026-10-06T03:00:00Z" }],
    "/w/dev": [{ session_id: "r-other-team", title: "Other team", updated_at: "2026-10-06T04:00:00Z" }],
  };
  return { state, list: async workspace => histories[workspace] };
}

test("team history only contains conversations registered to that team", async () => {
  const { state, list } = fixture();
  const rows = await sessionHistory(state, { teamId: "a" }, list);
  assert.deepEqual(rows.map(r => r.runtimeSessionId).sort(), ["r-team", "r-unsaved"]);
  assert.equal(rows.find(r => r.runtimeSessionId === "r-team").title, "Plan release");
  assert.ok(rows.every(r => r.teamId === "a"));
  assert.deepEqual((await sessionHistory(state, { teamId: "a", agentId: "lead" }, list)).map(r => r.runtimeSessionId), ["r-team"]);
});

test("agent history keeps every conversation but labels its team scope", async () => {
  const { state, list } = fixture();
  const rows = await sessionHistory(state, { agentId: "lead" }, list);
  assert.deepEqual(rows.map(r => r.runtimeSessionId), ["r-private", "r-team"]);
  assert.equal(rows[0].teamId, undefined);
  assert.equal(rows[1].teamId, "a");
});

test("history scopes are validated before reading any workspace", async () => {
  const { state } = fixture();
  const list = async () => assert.fail("workspace must not be read");
  await assert.rejects(sessionHistory(state, { teamId: "missing" }, list), /Team not found/);
  await assert.rejects(sessionHistory(state, { teamId: "b", agentId: "lead" }, list), /not a member/);
  await assert.rejects(sessionHistory(state, {}, list), /Agent not found/);
});
