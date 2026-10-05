import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgentsSnapshot, organizationRows, teamSessions, taskRows, inboxRows, sidebarRows, memberSessionRows, relativeTime, teamStatus } from "../lib/agents-model.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
function fixture() {
  const snapshot = emptyAgentsSnapshot();
  snapshot.teams.push({ id: "team", name: "Product", leaderAgentId: "lead", createRoot: "/w" }, { id: "other", name: "Other", createRoot: "/w" });
  const member = (id, name, status, extra = {}) => {
    snapshot.agents.push({ id, name, canonicalWorkspace: "/w/" + id });
    snapshot.memberships.push({ teamId: "team", agentId: id, status, ...extra });
  };
  member("lead", "Lead", "Working");
  member("api", "API", "Ready", { reportsToAgentId: "lead", position: "Backend" });
  member("db", "DB", "Inactive", { reportsToAgentId: "api" });
  member("web", "Web", "Ready", { reportsToAgentId: "lead" });
  snapshot.sessions.push(
    { id: "a", agentId: "lead", teamId: "team", runtimeSessionId: "r-lead", status: "Working", lastActivity: "2026-10-06T11:58:00Z" },
    { id: "b", agentId: "db", teamId: "team", runtimeSessionId: "r-db", status: "Needs input" },
    { id: "c", agentId: "lead", runtimeSessionId: "r-independent", status: "Ready" },
    { id: "d", agentId: "lead", teamId: "other", runtimeSessionId: "r-other", status: "Ready" },
  );
  const history = [
    { runtimeSessionId: "r-lead", agentId: "lead", teamId: "team", title: "Plan release", updatedAt: "2026-10-06T10:00:00Z" },
    { runtimeSessionId: "r-old", agentId: "lead", teamId: "team", title: "Kickoff", updatedAt: "2026-10-01T10:00:00Z" },
    { runtimeSessionId: "r-private", agentId: "lead", title: "Private" },
  ];
  return { snapshot, sessions: teamSessions(snapshot, "team", history) };
}

test("team sessions merge titles with live status and drop independent or foreign conversations", () => {
  const { sessions } = fixture();
  assert.deepEqual(sessions.map(s => s.id).sort(), ["r-db", "r-lead", "r-old"]);
  const lead = sessions.find(s => s.id === "r-lead");
  assert.equal(lead.title, "Plan release");
  assert.equal(lead.status, "Working");
  assert.equal(lead.updatedAt, "2026-10-06T11:58:00Z");
});

test("organization nests sessions under their member with tree guides", () => {
  const { snapshot, sessions } = fixture();
  const rows = organizationRows(snapshot, "team", sessions, { now: NOW });
  assert.deepEqual(rows.map(r => r.guide + r.title), [
    "Lead", "├─ Plan release", "├─ Kickoff", "├─ API", "│  └─ DB", "│     └─ r-db", "└─ Web",
  ]);
  assert.equal(rows[1].time, "2m");
  assert.equal(rows.find(r => r.title === "API").role, "Backend");
  assert.equal(rows[0].role, "Leader");
});

test("collapsed branches surface the most urgent hidden status and a hidden count", () => {
  const { snapshot, sessions } = fixture();
  const rows = organizationRows(snapshot, "team", sessions, { collapsed: new Set(["api"]), now: NOW });
  const api = rows.find(r => r.agentId === "api");
  assert.equal(api.expanded, false);
  assert.equal(api.status, "Needs input");
  assert.equal(api.ownStatus, "Ready");
  assert.equal(api.hidden, 1);
  assert.ok(!rows.some(r => r.agentId === "db"));
});

test("search and status filters keep ancestors and ignore collapse", () => {
  const { snapshot, sessions } = fixture();
  const found = organizationRows(snapshot, "team", sessions, { collapsed: new Set(["lead", "api"]), query: "r-db" });
  assert.deepEqual(found.map(r => r.title), ["Lead", "API", "DB", "r-db"]);
  const attention = organizationRows(snapshot, "team", sessions, { filter: "Needs input" });
  assert.deepEqual(attention.map(r => r.title), ["Lead", "API", "DB", "r-db"]);
  assert.equal(organizationRows(snapshot, "team", sessions, { query: "nothing" }).length, 0);
});

test("sessions beyond the inline limit become a single overflow row", () => {
  const { snapshot, sessions } = fixture();
  const rows = organizationRows(snapshot, "team", sessions, { sessionLimit: 1 });
  assert.equal(rows[1].title, "Plan release");
  assert.equal(rows[2].kind, "more");
  assert.match(rows[2].title, /\+1 more/);
});

test("tasks are grouped into sections a human acts on first", () => {
  const { snapshot } = fixture();
  snapshot.tasks.push(
    { id: "t1", teamId: "team", assigneeAgentId: "api", brief: "Ship", status: "done", report: { summary: "Shipped" } },
    { id: "t2", teamId: "team", assigneeAgentId: "lead", brief: "Decide", status: "blocked", blockedOn: { responder: "user", action: "Pick a date" } },
    { id: "t3", teamId: "team", assigneeAgentId: "lead", brief: "Coordinate", status: "blocked", blockedOn: { responder: "children", action: "Wait" } },
  );
  const rows = taskRows(snapshot, "team");
  assert.deepEqual(rows.map(r => r.kind === "section" ? "#" + r.title : r.title), ["Assign a task", "#Needs you", "Decide", "#Waiting on members", "Coordinate", "#Delivered", "Ship"]);
  assert.equal(rows.find(r => r.title === "Decide").note, "Pick a date");
  assert.equal(rows.find(r => r.title === "Coordinate").status, "Waiting");
});

test("inbox and sidebar only count team-scoped attention", () => {
  const { snapshot } = fixture();
  snapshot.sessions.push({ id: "x", agentId: "lead", runtimeSessionId: "r-x", status: "Needs input" });
  snapshot.runs.push({ id: "run", sessionId: "c", status: "unknown" }, { id: "run2", sessionId: "a", status: "unknown" });
  const inbox = inboxRows(snapshot);
  assert.deepEqual(inbox.filter(r => r.kind === "session" || r.kind === "run").map(r => r.id), ["r:run2", "s:r-db"]);
  assert.equal(sidebarRows(snapshot)[0].badge, 2);
  assert.equal(teamStatus(snapshot, "team"), "Needs input");
});

test("a running task that asks a question reaches the inbox once", () => {
  const { snapshot } = fixture();
  snapshot.tasks.push({ id: "run-task", teamId: "team", assigneeAgentId: "api", brief: "Migrate schema", status: "running" },
    { id: "blocked", teamId: "team", assigneeAgentId: "lead", brief: "Pick", status: "blocked", blockedOn: { responder: "user", action: "Pick a date" } });
  snapshot.sessions.push({ id: "e", agentId: "api", teamId: "team", runtimeSessionId: "r-task", status: "Needs input", taskId: "run-task" },
    { id: "f", agentId: "lead", teamId: "team", runtimeSessionId: "r-blocked", status: "Needs input", taskId: "blocked" });
  const items = inboxRows(snapshot).filter(r => r.kind === "session" || r.kind === "task");
  assert.deepEqual(items.map(r => r.id).sort(), ["s:r-db", "s:r-task", "t:blocked"]);
  assert.equal(items.find(r => r.id === "s:r-task").title, "Task asks: Migrate schema");
  assert.equal(sidebarRows(snapshot)[0].badge, 3);
});

test("member pages list every team conversation with new conversation first", () => {
  const { sessions } = fixture();
  const rows = memberSessionRows(sessions, "lead", { now: NOW });
  assert.deepEqual(rows.map(r => r.title), ["New conversation", "Plan release", "Kickoff"]);
  assert.deepEqual(memberSessionRows(sessions, "lead", { query: "kick" }).map(r => r.title), ["New conversation", "Kickoff"]);
});

test("relative time is compact and never negative", () => {
  assert.equal(relativeTime("2026-10-06T11:59:30Z", NOW), "now");
  assert.equal(relativeTime("2026-10-06T09:00:00Z", NOW), "3h");
  assert.equal(relativeTime("2026-10-04T12:00:00Z", NOW), "2d");
  assert.equal(relativeTime("2026-10-06T13:00:00Z", NOW), "now");
  assert.equal(relativeTime(undefined, NOW), "");
});
