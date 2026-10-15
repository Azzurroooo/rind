import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgentsSnapshot, organizationRows, teamSessions, taskRows, inboxRows, sidebarRows, memberSessionRows, relativeTime, teamStatus, independentSessions, independentRows, folderRows, backgroundRows, workspaceKey } from "../lib/agents-model.js";

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

test("a bounded folder window shows the folder's full count while its page opens the fuller list", () => {
  const { snapshot } = fixture();
  // The overview fetched the newest conversation only; the folder has 52.
  const groups = [{ workspace: "/home/me/scratch", name: "scratch", teams: [], total: 52, sessions: [{ runtimeSessionId: "r-a", title: "Newest", updatedAt: "2026-10-06T09:00:00Z" }] }];
  const rows = independentRows(groups, { now: NOW });
  assert.equal(rows.find(r => r.kind === "workspace").sessionCount, 52, "the row reports the folder's own count");
  assert.deepEqual(rows.filter(r => r.kind !== "workspace").map(r => r.title), ["Newest", "+51 more conversations"]);

  // Opening the folder's page replaces the window with its full list.
  const extras = {
    [workspaceKey("/home/me/scratch")]: { sessions: [
      { runtimeSessionId: "r-a", title: "Newest", updatedAt: "2026-10-06T09:00:00Z" },
      { runtimeSessionId: "r-old", title: "Older", updatedAt: "2026-10-01T09:00:00Z" },
    ] },
  };
  snapshot.live = [{ id: "r-old", workspace: "/home/me/scratch", turn: "idle", watchers: 0, updatedAt: "2026-10-01T09:00:00Z" }];
  const merged = independentSessions(snapshot, groups, "/rind/manager", extras);
  const scratch = merged.find(g => g.name === "scratch");
  assert.deepEqual(scratch.sessions.map(s => s.runtimeSessionId).sort(), ["r-a", "r-old"], "the full list replaces the bounded window");
  assert.equal(scratch.total, 52, "the folder's count survives the fuller list");
  assert.equal(scratch.sessions.find(s => s.runtimeSessionId === "r-old").status, "Idle");
  assert.deepEqual(folderRows(scratch, { now: NOW }).map(r => r.kind === "section" ? "#" + r.title : r.title), ["New conversation in this folder", "#Today", "Newest", "#This week", "Older"]);
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
  assert.equal(memberState("Working").label, "Working");
  assert.equal(memberState("Running job").label, "Running a job");
  assert.equal(memberState("Delegated").label, "Delegated");
  assert.equal(memberState("Idle", 1).label, "1 Open");
  assert.equal(memberState("Idle").label, "Idle");
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

test("unconfirmed sub-agent runs roll up to the entry task or conversation owner", async () => {
  const { createActions } = await import("../lib/agents-actions.js");
  const { snapshot } = fixture();
  snapshot.tasks.push({ id: "t-entry", teamId: "team", assigneeAgentId: "lead", brief: "Coordinate release", status: "blocked", blockedOn: { responder: "children", action: "Wait" } });
  snapshot.sessions.push({ id: "s-sub", agentId: "api", teamId: "team", runtimeSessionId: "r-sub", delegationId: "d1", taskId: "t-entry" });
  snapshot.runs.push({ id: "run-sub", sessionId: "s-sub", taskId: "t-entry", delegationId: "d1", status: "unknown", startedAt: "2026-10-06T11:50:00Z" });

  const inbox = inboxRows(snapshot).find(r => r.id === "r:run-sub");
  assert.equal(inbox.agentId, "lead", "inbox attributes the unconfirmed run to the entry member");
  assert.equal(inbox.title, "Confirm the previous run stopped");
  assert.equal(inbox.context, "Product › Lead");

  const bg = backgroundRows(snapshot, null, { now: NOW }).find(r => r.kind === "run" && r.runId === "run-sub");
  assert.equal(bg.context, "Product › Lead", "background attributes the unconfirmed run to the entry member");

  const menus = [];
  const actions = createActions({ view: { snapshot }, choose: (_, items) => menus.push(items) });
  actions.memberActions("team", "lead");
  actions.memberActions("team", "api");
  actions.taskActions("t-entry");
  assert.ok(menus[0].some(a => a.label === "Resolve unconfirmed run"));
  assert.ok(!menus[1].some(a => a.label === "Resolve unconfirmed run"));
  assert.ok(menus[2].some(a => a.label === "Resolve unconfirmed run"));
});

test("delegating member and session surface Delegated status, Waits on details, and conversation waiting prompt", async () => {
  const { detailLines } = await import("../lib/agents-detail.js");
  const { promptActivityLine } = await import("../lib/rendering.js");
  const { createEventController } = await import("../lib/event-controller.js");
  const { createCliOutputController } = await import("../lib/cli-output-controller.js");
  const strip = value => value.replace(/\x1b\[[0-9;]*m/g, "");

  const { snapshot } = fixture();
  snapshot.memberships.find(m => m.agentId === "lead").status = "Delegated";
  snapshot.sessions.push({ id: "s-lead", agentId: "lead", teamId: "team", runtimeSessionId: "r-lead", status: "Delegated", lastActivity: "2026-10-06T11:55:00Z", pendingDelegations: [{ taskId: "d-child", assignee: "API" }] });
  const sessions = teamSessions(snapshot, "team", [{ runtimeSessionId: "r-lead", agentId: "lead", teamId: "team", title: "Coordinate auth", updatedAt: "2026-10-06T11:50:00Z" }]);
  assert.equal(sessions[0].status, "Delegated");

  const orgRows = organizationRows(snapshot, "team", sessions, { now: NOW });
  const memberRow = orgRows.find(r => r.id === "m:lead");
  const sessionRow = orgRows.find(r => r.id === "s:r-lead");
  assert.equal(memberRow.status, "Delegated");
  assert.equal(sessionRow.status, "Delegated");

  const memberDetail = detailLines({ snapshot }, memberRow, 60).map(strip).join("\n");
  assert.match(memberDetail, /⋯ Delegated/);
  assert.match(memberDetail, /Waits on\s+API · resumes on delivery/);

  const sessionDetail = detailLines({ snapshot }, sessionRow, 60).map(strip).join("\n");
  assert.match(sessionDetail, /⋯ Delegated/);
  assert.match(sessionDetail, /Waits on\s+API · resumes on delivery/);

  // Conversation UI shows live waiting activity line while waiting for delegated sub-agents.
  const activity = strip(promptActivityLine({ running: false, delegatedWait: ["API"], frameWidth: 80 }));
  assert.match(activity, /Waiting · API · wakes on delivery/);

  // Manual /compact turn does not log "Worked for 0ms", whereas ordinary turns do.
  const logs = [];
  const state = { sessionInfo: { session_id: "r-lead" }, pendingDelegations: new Map() };
  const events = createEventController({ state, output: { log: item => logs.push(typeof item === "function" ? strip(item()) : strip(String(item))) } });
  await events.handle({ event: { type: "turn_started", operation: "compact", session_id: "r-lead" } });
  await events.handle({ event: { type: "context_compacted", session_id: "r-lead" } });
  await events.handle({ event: { type: "turn_completed", duration_ms: 0, session_id: "r-lead" } });
  assert.equal(logs.length, 0, "compact-only turn must not emit Worked for 0ms");

  await events.handle({ event: { type: "turn_started", operation: "prompt", session_id: "r-lead" } });
  await events.handle({ event: { type: "turn_completed", duration_ms: 1200, session_id: "r-lead" } });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Worked for 1\.20s/);

  // Output controller exposes delegatedWait in mainPromptText when delegations are pending.
  const cliState = {
    runtime: { status: "ready" },
    turn: { active: false, interruptRequested: false },
    display: { activeCompact: false, activityLabel: "", activityFrame: 0, activityStartedAt: 0, activityTimer: null, backgroundWait: null, pendingDelegations: new Map([["t-child", { taskId: "t-child", assignee: "API", sessionId: "r-lead" }]]), stats: {} },
    input: { pending: [], session: { mode: "prompt", editor: { input: () => "" } } },
    session: { info: { session_id: "r-lead", provider: "openai", model: "gpt" } },
  };
  const out = createCliOutputController({ state: cliState, terminalUi: null, transcript: { addChild() {}, changed() {}, clear() {} } });
  assert.match(strip(out.mainPromptText(80)), /Waiting · API · wakes on delivery/);

  // Task detail panel names the delegated member in Waits on, and Running job tasks surface Job on both Member and Task panels.
  snapshot.tasks.push({ id: "t-delegated", teamId: "team", assigneeAgentId: "lead", createdBy: "user", brief: "Coordinate auth", status: "blocked", blockedOn: { responder: "children", action: "Continues when its members deliver." } });
  snapshot.sessions.find(s => s.id === "s-lead").taskId = "t-delegated";
  const delegatedTaskRow = taskRows(snapshot, "team").find(r => r.id === "t:t-delegated");
  const delegatedTaskDetail = detailLines({ snapshot }, delegatedTaskRow, 60).map(strip).join("\n");
  assert.match(delegatedTaskDetail, /⋯ Delegated/);
  assert.match(delegatedTaskDetail, /Waits on\s+API · resumes on delivery/);

  snapshot.tasks.push({ id: "t-job", teamId: "team", assigneeAgentId: "api", createdBy: "user", brief: "Run regression suite", status: "running" });
  snapshot.memberships.find(m => m.agentId === "api").status = "Running job";
  snapshot.sessions.push({ id: "s-api", agentId: "api", teamId: "team", runtimeSessionId: "r-api", taskId: "t-job", status: "Running job", lastActivity: "2026-10-06T11:58:00Z" });
  (snapshot.live ||= []).push({ id: "r-api", workspace: "/w/api", turn: "idle", watchers: 0, background: { count: 1, commands: ["pytest -q"], startedAt: "2026-10-06T11:57:00Z" } });
  const jobTaskRow = taskRows(snapshot, "team").find(r => r.id === "t:t-job");
  assert.equal(jobTaskRow.status, "Running job");
  const jobTaskDetail = detailLines({ snapshot }, jobTaskRow, 60).map(strip).join("\n");
  assert.match(jobTaskDetail, /↻ Running job/);
  assert.match(jobTaskDetail, /Job\s+pytest -q · continues by itself/);
  const apiMemberRow = organizationRows(snapshot, "team", teamSessions(snapshot, "team"), { now: NOW }).find(r => r.id === "m:api");
  const apiMemberDetail = detailLines({ snapshot }, apiMemberRow, 60).map(strip).join("\n");
  assert.match(apiMemberDetail, /↻ Running a job/);
  assert.match(apiMemberDetail, /Job\s+pytest -q · continues by itself/);

  // live-sessions synchronizes background_wait attached to turn_completed and clears it on turn_cancelled.
  const { createLiveSessions } = await import("../../rind-runtime-client/live-sessions.js");
  const liveTable = createLiveSessions({ now: () => NOW, schedule: fn => fn() });
  liveTable.event({ session_id: "r-job", event: { type: "turn_started" } });
  assert.equal(liveTable.list()[0].turn, "running");
  liveTable.event({ session_id: "r-job", event: { type: "turn_completed", background_wait: { count: 1, started_at: 1700000000, commands: ["npm test"] } } });
  assert.equal(liveTable.list()[0].turn, "idle");
  assert.equal(liveTable.list()[0].background?.count, 1);
  assert.deepEqual(liveTable.list()[0].background?.commands, ["npm test"]);
  liveTable.event({ session_id: "r-job", event: { type: "turn_cancelled" } });
  assert.equal(liveTable.list()[0].background, null);
});

