import test from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../dist/model.js";
import { memberStatus, projectionIndex, sessionStatus } from "../dist/projection.js";

function state() {
  const s = emptyState();
  s.teams.team = { id: "team", name: "Product", leaderAgentId: "lead", createRoot: "/w" };
  s.agents.lead = { id: "lead", name: "Lead", canonicalWorkspace: "/w/lead", adapter: "rind" };
  s.memberships["team/lead"] = { teamId: "team", agentId: "lead" };
  s.sessions.s = { id: "s", agentId: "lead", teamId: "team", runtimeSessionId: "r", origin: "direct", shared: true };
  return s;
}
const live = (extra = {}) => new Map([["r", { id: "r", workspace: "/w/lead", turn: "idle", startedAt: "", updatedAt: "2026-10-07T12:00:00Z", watchers: 0, ...extra }]]);
const run = (status = "running") => ({ id: "run", sessionId: "s", status, startedAt: "2026-10-07T11:00:00Z", lastObservedAt: "2026-10-07T11:00:00Z", hostSequence: 0 });

test("a session whose turn ended while its jobs still run is Running job, not Working or Idle", () => {
  const s = state();
  const jobs = live({ background: { count: 1, commands: ["npm test"], startedAt: "2026-10-07T11:59:00Z" } });
  assert.equal(sessionStatus(projectionIndex(s, new Set(), jobs), "s").status, "Running job", "a plain conversation resumes after its job");
  s.runs.run = run();
  assert.equal(sessionStatus(projectionIndex(s, new Set(), jobs), "s").status, "Running job", "the run kept open for the job is not thinking");
  assert.equal(memberStatus(projectionIndex(s, new Set(), jobs), "lead", "team"), "Running job");
  assert.equal(sessionStatus(projectionIndex(s, new Set(), live({ turn: "running", background: { count: 1, commands: [], startedAt: "" } })), "s").status, "Working", "a running turn is Working");
  assert.equal(sessionStatus(projectionIndex(s, new Set(), live()), "s").status, "Working", "no jobs: the active run is Working");
});

test("a leader whose task waits for its members is Delegated", () => {
  const s = state();
  s.tasks.t = { id: "t", teamId: "team", assigneeAgentId: "lead", createdBy: "user", brief: "Ship", status: "blocked", blockedOn: { responder: "children", action: "Continues when its members deliver." } };
  assert.equal(memberStatus(projectionIndex(s, new Set(), new Map()), "lead", "team"), "Delegated");
});
