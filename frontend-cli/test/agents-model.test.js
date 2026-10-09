import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgentsSnapshot, organizationRows, teamSessions, taskRows, inboxRows, sidebarRows, memberSessionRows, relativeTime, teamStatus, independentSessions, independentRows, folderRows, backgroundRows } from "../lib/agents-model.js";

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
  assert.deepEqual(rows.map(r => r.kind === "section" ? "#" + r.title : r.title), ["Assign a task", "#Needs you", "Decide", "#Delegated to members", "Coordinate", "#Delivered", "Ship"]);
  assert.equal(rows.find(r => r.title === "Decide").note, "Pick a date");
  assert.equal(rows.find(r => r.title === "Coordinate").status, "Delegated");
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

test("independent folders take live state from the Runtime, include plain sessions, and fold extra conversations", () => {
  const { snapshot } = fixture();
  const groups = [
    { workspace: "/home/me/scratch", name: "scratch", teams: [], sessions: ["a", "b", "c", "d", "e"].map((id, i) => ({ runtimeSessionId: "r-" + id, title: "Idea " + id, updatedAt: "2026-10-0" + (6 - i) + "T09:00:00Z" })) },
    { workspace: "/w/lead/", agentId: "lead", name: "Lead", teams: ["Product"], sessions: [{ runtimeSessionId: "r-independent", title: "Quick fix", updatedAt: "2026-10-06T09:00:00Z" }] },
  ];
  snapshot.live = [
    { id: "r-independent", workspace: "/w/lead", turn: "idle", watchers: 1, updatedAt: "2026-10-06T11:00:00Z" },
    { id: "r-e", workspace: "/home/me/scratch", turn: "running", watchers: 0, updatedAt: "2026-10-06T11:59:00Z" },
    { id: "r-plain", workspace: "/home/me/notes", turn: "question", watchers: 1, updatedAt: "2026-10-06T11:58:00Z" },
    { id: "r-lead", workspace: "/w/lead", turn: "running", watchers: 1, updatedAt: "2026-10-06T11:58:00Z" },
    { id: "r-mgr", workspace: "/rind/manager", turn: "running", watchers: 1, updatedAt: "2026-10-06T11:58:00Z" },
  ];
  const merged = independentSessions(snapshot, groups, "/rind/manager");
  const lead = merged.find(g => g.agentId === "lead");
  assert.deepEqual(lead.sessions.map(s => [s.runtimeSessionId, s.status]), [["r-independent", "Open"]], "team conversations stay on their team");
  assert.equal(merged.find(g => g.name === "scratch").sessions.find(s => s.runtimeSessionId === "r-e").status, "Working");
  assert.deepEqual(merged.find(g => g.name === "notes").sessions.map(s => s.status), ["Needs input"], "a plain session in an unregistered folder appears live");
  assert.ok(!merged.some(g => g.workspace === "/rind/manager"), "Manager conversations are not independent");
  const rows = independentRows(merged, { now: NOW });
  assert.deepEqual(rows.filter(r => r.kind === "workspace").map(r => r.title), ["notes", "scratch", "Lead"]);
  const scratch = rows.filter(r => r.workspace === "/home/me/scratch" && r.kind !== "workspace");
  assert.deepEqual(scratch.map(r => r.title), ["Idea e", "Idea a", "Idea b", "+2 more conversations"], "running first, then the newest, the rest behind one row");
  assert.equal(independentRows(merged, { collapsed: new Set(["/home/me/scratch"]) }).filter(r => r.workspace === "/home/me/scratch").length, 1);
  assert.deepEqual(independentRows(merged, { query: "idea d" }).map(r => r.title), ["scratch", "Idea d"]);
  const folder = folderRows(merged.find(g => g.name === "scratch"), { now: NOW });
  assert.deepEqual(folder.map(r => r.kind === "section" ? "#" + r.title : r.title), ["New conversation in this folder", "#Active", "Idea e", "#Today", "Idea a", "#This week", "Idea b", "Idea c", "Idea d"]);
});

test("relative time is compact and never negative", () => {
  assert.equal(relativeTime("2026-10-06T11:59:30Z", NOW), "now");
  assert.equal(relativeTime("2026-10-06T09:00:00Z", NOW), "3h");
  assert.equal(relativeTime("2026-10-04T12:00:00Z", NOW), "2d");
  assert.equal(relativeTime("2026-10-06T13:00:00Z", NOW), "now");
  assert.equal(relativeTime(undefined, NOW), "");
});

test("background lists every running conversation, services and one stop action", () => {
  const { snapshot } = fixture();
  snapshot.tasks.push({ id: "t-run", teamId: "team", assigneeAgentId: "api", brief: "Migrate schema", status: "running" });
  snapshot.sessions.push({ id: "e", agentId: "api", teamId: "team", runtimeSessionId: "r-task" });
  snapshot.runs.push({ id: "w1", sessionId: "e", taskId: "t-run", status: "running", startedAt: "2026-10-06T11:50:00Z" },
    { id: "w2", sessionId: "a", status: "starting", startedAt: "2026-10-06T11:59:00Z" }, { id: "w3", sessionId: "a", status: "unknown", startedAt: "2026-10-06T10:00:00Z" });
  snapshot.live = [
    { id: "r-task", workspace: "/w/api", turn: "running", watchers: 0, startedAt: "2026-10-06T11:50:00Z", updatedAt: "2026-10-06T11:50:00Z" },
    { id: "r-plain", workspace: "/home/me/notes", turn: "question", watchers: 1, startedAt: "2026-10-06T11:58:00Z", updatedAt: "2026-10-06T11:58:00Z" },
    { id: "r-idle", workspace: "/home/me/notes", turn: "idle", watchers: 1, updatedAt: "2026-10-06T11:58:00Z" },
  ];
  const rows = backgroundRows(snapshot, { pid: 7, startedAt: "2026-10-06T09:00:00Z", runtime: { pid: 8, startedAt: "2026-10-06T09:00:00Z", busy: 2 }, stale: { reason: "busy" } }, { now: NOW });
  const live = rows.filter(r => r.kind === "live");
  assert.deepEqual(live.map(r => [r.title, r.status, r.context, r.note, r.time]), [
    ["notes", "Needs input", "Independent", "Conversation", "2m"],
    ["API", "Working", "Product", "Task: Migrate schema", "10m"],
    ["Lead", "Working", "Product", "Conversation", "1m"],
  ], "named after who runs it; a plain window's turn, a managed task once, and a run the Runtime has not reported yet");
  const task = live.find(r => r.taskId === "t-run");
  assert.deepEqual([task.sessionId, task.runId], ["r-task", "w1"], "Enter joins its conversation; the run is there to stop");
  assert.equal(rows.find(r => r.kind === "run").runId, "w3");
  assert.match(rows.find(r => r.id === "svc:management").note, /pid 7 · up 3h · update waiting/);
  assert.match(rows.find(r => r.id === "svc:runtime").note, /2 running/);
  assert.deepEqual(rows.filter(r => r.kind === "stop-all").map(r => [r.title, r.working]), [["Stop all agents…", 3]]);
  assert.equal(sidebarRows(snapshot).find(r => r.id === "background").badge, 3);
  const idle = backgroundRows(fixture().snapshot, null, { now: NOW });
  assert.equal(idle.find(r => r.id === "idle").title, "Nothing is running. Leaving Rind stops nothing.");
  assert.equal(idle.find(r => r.kind === "stop-all").title, "Stop background services…");
  assert.equal(idle.find(r => r.id === "svc:runtime").note, "starts when a conversation needs it");
});

test("the inbox shows recent deliveries instead of repeating the team list", () => {
  const { snapshot } = fixture();
  snapshot.tasks.push({ id: "d1", teamId: "team", assigneeAgentId: "api", brief: "Ship login", status: "done", report: { summary: "Merged and released" } });
  snapshot.runs.push({ id: "x", sessionId: "a", taskId: "d1", status: "succeeded", startedAt: "2026-10-06T10:00:00Z", lastObservedAt: "2026-10-06T11:00:00Z" });
  const rows = inboxRows(snapshot);
  assert.ok(!rows.some(r => r.kind === "team"));
  const delivered = rows.find(r => r.id === "d:d1");
  assert.deepEqual([delivered.title, delivered.note, delivered.status], ["Ship login", "Merged and released", "Done"]);
  assert.match(delivered.context, /^Product › API · /);
  assert.equal(organizationRows(snapshot, "team", []).find(r => r.agentId === "api").tasks, 0, "delivered work is not an open task");
});

test("a conversation running a job reads Running job everywhere, and delegated work reads Delegated", async () => {
  const { liveStatus, statusMeta, memberState, taskStatus, jobSummary } = await import("../lib/agents-model.js");
  const job = { id: "r", workspace: "/w/notes", turn: "idle", watchers: 0, updatedAt: "2026-10-06T11:59:00Z", startedAt: "", background: { count: 2, commands: ["npm test", "cargo build"], startedAt: "2026-10-06T11:57:00Z" } };
  assert.equal(liveStatus(job), "Running job");
  assert.equal(liveStatus({ ...job, watchers: 1 }), "Running job", "a job outranks Open");
  assert.equal(liveStatus({ ...job, turn: "running" }), "Working");
  assert.equal(statusMeta("Running job").glyph, "↻");
  assert.equal(statusMeta("Delegated").glyph, "⋯");
  assert.ok(statusMeta("Working").rank < statusMeta("Running job").rank && statusMeta("Running job").rank < statusMeta("Delegated").rank);
  assert.equal(memberState("Running job").label, "running a job");
  assert.equal(memberState("Delegated").label, "delegated");
  assert.equal(taskStatus({ status: "blocked", blockedOn: { responder: "children" } }), "Delegated");
  assert.equal(jobSummary(job.background), "npm test +1");
  assert.equal(jobSummary({ count: 1, commands: ["npm   run\n build"] }), "npm run build");

  const snapshot = emptyAgentsSnapshot();
  snapshot.live = [job];
  const rows = backgroundRows(snapshot, null, { now: NOW });
  const row = rows.find(r => r.kind === "live");
  assert.deepEqual([row.status, row.note, row.time], ["Running job", "Conversation · npm test +1", "3m"], "Background lists it: it keeps running after you leave");
  const { runningCount } = await import("../lib/agents-model.js");
  assert.equal(runningCount(snapshot), 1);
});

test("lists show a conversation's new name before history is read again", () => {
  const { snapshot } = fixture();
  snapshot.live = [{ id: "r-lead", workspace: "/w/lead", turn: "idle", watchers: 0, title: "Release checks" }];
  const history = [{ runtimeSessionId: "r-lead", agentId: "lead", teamId: "team", title: "Plan release", updatedAt: "2026-10-06T10:00:00Z" }];
  assert.equal(teamSessions(snapshot, "team", history).find(s => s.id === "r-lead").title, "Release checks");
  snapshot.live = [];
  assert.equal(teamSessions(snapshot, "team", history).find(s => s.id === "r-lead").title, "Plan release", "without a rename, history decides");
});

test("folders whose conversations have no recorded activity still sort", () => {
  const workspaces = [
    { workspace: "/home/me/a", name: "a", teams: [], sessions: [{ runtimeSessionId: "r1", title: "r1", updatedAt: undefined, status: "Idle" }] },
    { workspace: "/home/me/b", name: "b", teams: [], sessions: [{ runtimeSessionId: "r2", title: "r2", updatedAt: "2026-10-09T10:00:00Z", status: "Idle" }] },
  ];
  assert.deepEqual(independentRows(workspaces).filter(r => r.kind === "workspace").map(r => r.title), ["b", "a"]);
});
