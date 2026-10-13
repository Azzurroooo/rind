import test from "node:test";
import assert from "node:assert/strict";
import { sessionHistory, independentHistory, independentFolder } from "../dist/history.js";
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
    "/w/lead": [{ id: "r-team", title: "Plan release", updated_at: "2026-10-06T02:00:00Z" }, { id: "r-private", title: "Private notes", updated_at: "2026-10-06T03:00:00Z" }],
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

test("independent history reads one grouped page and skips team and Manager history", async () => {
  const { state } = fixture();
  state.sessions.s5 = { id: "s5", agentId: "lead", runtimeSessionId: "r-standalone", origin: "direct" };
  const all = [
    { id: "r-team", workspace_root: "/w/lead", title: "Team work", updated_at: "2026-10-06T05:00:00Z" },
    { id: "r-standalone", workspace_root: "/w/lead/", title: "Quick fix", updated_at: "2026-10-06T04:00:00Z" },
    { id: "r-loose", workspace_root: "/home/me/scratch", title: "Try an idea", updated_at: "2026-10-06T06:00:00Z" },
    { id: "r-manager", workspace_root: "/rind/manager", title: "Coordinate" },
  ];
  const queries = [];
  // Stands in for the Runtime's grouped query: newest per folder plus totals.
  const list = async query => {
    queries.push(query);
    const skipped = new Set(query.exclude_session_ids || []);
    const excluded = (query.exclude_workspace_roots || []).map(w => w.replace(/\/+$/, ""));
    const matches = all.filter(e => !skipped.has(e.id) && !excluded.some(w => e.workspace_root.replace(/\/+$/, "").startsWith(w)));
    const byFolder = new Map();
    for (const entry of matches) {
      const key = entry.workspace_root.replace(/\/+$/, "");
      if (!byFolder.has(key)) byFolder.set(key, { total: 0, sessions: [] });
      const bucket = byFolder.get(key);
      bucket.total += 1;
      if (bucket.sessions.length < query.per_workspace_limit) bucket.sessions.push(entry);
    }
    return {
      sessions: [...byFolder.values()].flatMap(bucket => bucket.sessions),
      totals: [...byFolder.entries()].map(([workspace_root, bucket]) => ({ workspace_root, count: bucket.total })),
    };
  };
  const groups = await independentHistory(state, "/rind/manager", list);
  assert.equal(queries.length, 1, "one grouped query, not one per folder");
  assert.equal(queries[0].per_workspace_limit, 3);
  assert.deepEqual(queries[0].exclude_workspace_roots, ["/rind/manager"]);
  assert.deepEqual(queries[0].exclude_session_ids.sort(), ["r-other-team", "r-team", "r-unsaved"], "team conversations are excluded by id");
  assert.deepEqual(groups.map(g => g.name).sort(), ["Lead", "scratch"]);
  const lead = groups.find(g => g.agentId === "lead");
  assert.deepEqual(lead.sessions.map(s => s.runtimeSessionId), ["r-standalone"]);
  assert.equal(lead.total, 1);
  assert.deepEqual(groups.find(g => g.name === "scratch").sessions.map(s => s.runtimeSessionId), ["r-loose"]);
  assert.equal(groups.find(g => g.name === "scratch").total, 1);
});

test("a folder's page reads that folder's conversations with the same exclusions", async () => {
  const { state } = fixture();
  const queries = [];
  const list = async query => {
    queries.push(query);
    return { sessions: [
      { id: "r-team", workspace_root: "/w/lead", title: "Team work" },
      { id: "r-standalone", workspace_root: "/w/lead", title: "Quick fix", updated_at: "2026-10-06T04:00:00Z" },
    ] };
  };
  const sessions = await independentFolder(state, "/rind/manager", "/w/lead", list);
  assert.deepEqual(queries, [{ workspace_root: "/w/lead", limit: 100, exclude_session_ids: ["r-team", "r-other-team", "r-unsaved"] }]);
  assert.deepEqual(sessions.map(s => s.runtimeSessionId), ["r-standalone"]);
  assert.deepEqual(await independentFolder(state, "/rind/manager", "/rind/manager", list), []);
});

test("history carries what each conversation runs on, and whether its connection can run", async () => {
  const { state } = fixture();
  const list = async () => [{ id: "r-team", title: "Plan", provider: "deepseek", model: "deepseek-flash", reasoning_effort: "high", selection_source: { model: "folder", effort: "session" }, connection_ready: false }];
  const [row] = await sessionHistory(state, { teamId: "a", agentId: "lead" }, list);
  assert.deepEqual([row.provider, row.model, row.reasoningEffort, row.selectionSource.model, row.connectionReady], ["deepseek", "deepseek-flash", "high", "folder", false]);
  const [group] = await independentHistory(state, "/w/manager", async () => ({ sessions: [{ id: "r-free", title: "Free", workspace_root: "/w/free", provider: "openai", model: "gpt-5.5" }] }));
  assert.deepEqual([group.sessions[0].provider, group.sessions[0].model, group.sessions[0].reasoningEffort], ["openai", "gpt-5.5", undefined]);
});
