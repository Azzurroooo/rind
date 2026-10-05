// Pure projections from the management snapshot into the rows the Agents page
// renders. Nothing here touches the terminal or the service.

export const emptyAgentsSnapshot = () => ({ teams: [], memberships: [], agents: [], tasks: [], runs: [], sessions: [], notes: [], artifacts: [] });

export const clean = value => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export const single = value => clean(value).replace(/\s+/g, " ").trim();

const STATUS = {
  "Needs input": { glyph: "!", tone: "warning", rank: 0, attention: true },
  Unconfirmed: { glyph: "?", tone: "danger", rank: 1, attention: true },
  Working: { glyph: "●", tone: "accent", rank: 2 },
  Waiting: { glyph: "…", tone: "notice", rank: 3 },
  Queued: { glyph: "◦", tone: "notice", rank: 4 },
  Ready: { glyph: "○", tone: "success", rank: 5 },
  Done: { glyph: "✓", tone: "success", rank: 6 },
  Inactive: { glyph: "·", tone: "dim", rank: 7 },
  Cancelled: { glyph: "×", tone: "dim", rank: 8 },
};
export const STATUS_FILTERS = ["All", ...Object.keys(STATUS)];

// A member's state is described in terms of the person, so a member whose
// conversation is "Ready" reads "1 open" instead of repeating the child status.
const MEMBER_STATE = { "Needs input": "needs you", Unconfirmed: "unconfirmed", Working: "working", Waiting: "waiting on team", Queued: "task queued" };
export function memberState(status, open = 0) {
  if (MEMBER_STATE[status]) return { tone: status, label: MEMBER_STATE[status] };
  if (open) return { tone: "Ready", label: open + " open" };
  return { tone: "Inactive", label: "idle" };
}
export const statusMeta = status => STATUS[status] || STATUS.Inactive;

const TASK_STATUS = { running: "Working", queued: "Queued", blocked: "Needs input", needs_attention: "Needs input", done: "Done", cancelled: "Cancelled" };
export const needsUser = task => task.status === "needs_attention" || (task.status === "blocked" && task.blockedOn?.responder === "user");
export function taskStatus(task) {
  if (task.status === "blocked" && !needsUser(task)) return "Waiting";
  return TASK_STATUS[task.status] || "Inactive";
}

export function relativeTime(value, now = Date.now()) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
  if (seconds < 30 * 86400) return Math.floor(seconds / 86400) + "d";
  const date = new Date(time);
  return String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

const byId = (items, id) => items.find(item => item.id === id);
const later = (a, b) => ((a || "") > (b || "") ? a : b);
const matches = (query, ...values) => !query || values.some(value => single(value).toLowerCase().includes(query.toLowerCase()));
const statusOk = (filter, status) => filter === "All" || status === filter;
const bySessionPriority = (a, b) => statusMeta(a.status).rank - statusMeta(b.status).rank || (b.updatedAt || "").localeCompare(a.updatedAt || "");

export function roleOf(snapshot, teamId, agentId) {
  const team = byId(snapshot.teams, teamId);
  const membership = snapshot.memberships.find(m => m.teamId === teamId && m.agentId === agentId);
  return agentId === team?.leaderAgentId ? "Leader" : single(membership?.position) || "Member";
}

// Saved history supplies titles; the snapshot supplies live status. Only
// conversations registered to this team are kept.
export function teamSessions(snapshot, teamId, history = []) {
  const sessions = new Map();
  for (const entry of history) if (entry.teamId === teamId && entry.runtimeSessionId) {
    sessions.set(entry.runtimeSessionId, { id: entry.runtimeSessionId, agentId: entry.agentId, teamId, title: single(entry.title) || entry.runtimeSessionId, updatedAt: entry.updatedAt, status: "Inactive" });
  }
  for (const live of snapshot.sessions) if (live.teamId === teamId && live.runtimeSessionId) {
    const saved = sessions.get(live.runtimeSessionId);
    sessions.set(live.runtimeSessionId, { id: live.runtimeSessionId, agentId: live.agentId, teamId, title: saved?.title || live.runtimeSessionId,
      updatedAt: later(saved?.updatedAt, live.lastActivity), status: live.status || "Inactive", ...(live.taskId ? { taskId: live.taskId } : {}) });
  }
  return [...sessions.values()];
}

function sessionRow(session, depth, now) {
  return { id: "s:" + session.id, kind: "session", depth, title: session.title, status: session.status, time: relativeTime(session.updatedAt, now),
    agentId: session.agentId, teamId: session.teamId, sessionId: session.id, taskId: session.taskId };
}

export function organizationRows(snapshot, teamId, sessions, { collapsed = new Set(), query = "", filter = "All", sessionLimit = 3, now = Date.now() } = {}) {
  const team = byId(snapshot.teams, teamId);
  const members = snapshot.memberships.filter(m => m.teamId === teamId);
  const memberIds = new Set(members.map(m => m.agentId));
  const parentOf = member => member.agentId === team?.leaderAgentId ? undefined : memberIds.has(member.reportsToAgentId) ? member.reportsToAgentId : team?.leaderAgentId;
  const reports = id => members.filter(m => m.agentId !== id && parentOf(m) === id);
  const descendants = (id, seen = new Set([id])) => reports(id).filter(m => !seen.has(m.agentId) && seen.add(m.agentId)).reduce((sum, m) => sum + 1 + descendants(m.agentId, seen), 0);
  const narrowed = Boolean(query) || filter !== "All";
  const rows = [], visited = new Set();
  const worst = (...statuses) => statuses.filter(Boolean).sort((a, b) => statusMeta(a).rank - statusMeta(b).rank)[0];
  // A collapsed branch must still surface the most urgent status hidden below it.
  const branchStatus = (agentId, seen = new Set()) => {
    if (seen.has(agentId)) return undefined;
    seen.add(agentId);
    return worst(members.find(m => m.agentId === agentId)?.status, ...sessions.filter(s => s.agentId === agentId).map(s => s.status), ...reports(agentId).map(m => branchStatus(m.agentId, seen)));
  };

  // Returns the member's rows, or an empty list when nothing in its branch survives the search.
  function branch(member, depth) {
    if (visited.has(member.agentId)) return [];
    visited.add(member.agentId);
    const agent = byId(snapshot.agents, member.agentId);
    const role = roleOf(snapshot, teamId, member.agentId);
    const self = matches(query, agent?.name, role, member.responsibility) && statusOk(filter, member.status);
    const own = sessions.filter(s => s.agentId === member.agentId).sort(bySessionPriority);
    const shownSessions = narrowed ? own.filter(s => (self && !query || matches(query, s.title)) && statusOk(filter, s.status)) : own;
    const childRows = reports(member.agentId).flatMap(child => branch(child, depth + 1));
    if (narrowed && !self && !shownSessions.length && !childRows.length) return [];
    const open = narrowed || !collapsed.has(member.agentId);
    const row = { id: "m:" + member.agentId, kind: "member", depth, title: single(agent?.name) || "Missing member", role: role === "Member" ? "" : role, status: member.status || "Inactive", ownStatus: member.status || "Inactive",
      agentId: member.agentId, teamId, leader: role === "Leader", sessionCount: own.length, open: own.filter(s => s.status !== "Inactive").length, reportCount: reports(member.agentId).length,
      expandable: own.length > 0 || reports(member.agentId).length > 0, expanded: open };
    if (!open) return [{ ...row, status: branchStatus(member.agentId) || row.status, hidden: own.length + descendants(member.agentId) }];
    const limit = narrowed ? Infinity : sessionLimit;
    const children = shownSessions.slice(0, limit).map(session => sessionRow(session, depth + 1, now));
    if (shownSessions.length > limit) children.push({ id: "more:" + member.agentId, kind: "more", depth: depth + 1, title: "+" + (shownSessions.length - limit) + " more conversations", agentId: member.agentId, teamId });
    return [row, ...children, ...childRows];
  }
  const roots = members.filter(m => !parentOf(m) || !memberIds.has(parentOf(m)));
  for (const root of roots) rows.push(...branch(root, 0));
  // Members on a broken chain still appear rather than silently disappearing.
  for (const member of members) if (!visited.has(member.agentId)) rows.push(...branch(member, 0));
  return withGuides(rows);
}

// Adds ├─ └─ │ guides from depth information; a row is "last" when no later
// sibling exists before its parent's branch ends.
function withGuides(rows) {
  const last = rows.map((row, index) => {
    for (let next = index + 1; next < rows.length; next++) {
      if (rows[next].depth < row.depth) return true;
      if (rows[next].depth === row.depth) return false;
    }
    return true;
  });
  const open = [];
  return rows.map((row, index) => {
    open.length = row.depth;
    const guide = row.depth === 0 ? "" : open.slice(1).map(more => (more ? "│  " : "   ")).join("") + (last[index] ? "└─ " : "├─ ");
    open[row.depth] = !last[index];
    return { ...row, guide };
  });
}

const TASK_SECTIONS = [
  { id: "needs", title: "Needs you", test: task => needsUser(task) },
  { id: "working", title: "In progress", test: task => task.status === "running" },
  { id: "queued", title: "Queued", test: task => task.status === "queued" },
  { id: "waiting", title: "Waiting on members", test: task => task.status === "blocked" && !needsUser(task) },
  { id: "done", title: "Delivered", test: task => task.status === "done" },
  { id: "cancelled", title: "Cancelled", test: task => task.status === "cancelled" },
];
export function taskRows(snapshot, teamId, { query = "", filter = "All" } = {}) {
  const tasks = snapshot.tasks.filter(t => t.teamId === teamId);
  const rows = [{ id: "assign", kind: "assign", title: "Assign a task", teamId }];
  for (const section of TASK_SECTIONS) {
    const items = tasks.filter(section.test).filter(task => {
      const owner = byId(snapshot.agents, task.assigneeAgentId)?.name;
      return matches(query, task.brief, owner, task.blockedOn?.action, task.report?.summary) && statusOk(filter, taskStatus(task));
    });
    if (section.id === "working" || section.id === "queued") items.sort((a, b) => ({ high: 0, low: 2 }[a.priority] ?? 1) - ({ high: 0, low: 2 }[b.priority] ?? 1));
    if (!items.length) continue;
    rows.push({ id: "section:" + section.id, kind: "section", title: section.title, count: items.length });
    for (const task of items) {
      const owner = single(byId(snapshot.agents, task.assigneeAgentId)?.name) || "Removed member";
      rows.push({ id: "t:" + task.id, kind: "task", title: single(task.brief), status: taskStatus(task), owner, priority: task.priority, subtask: Boolean(task.parentTaskId),
        note: single(needsUser(task) ? task.blockedOn?.action || task.error : task.status === "queued" ? task.queueReason : task.report?.summary), taskId: task.id, teamId });
    }
  }
  return rows;
}

export function memberSessionRows(sessions, agentId, { query = "", filter = "All", now = Date.now() } = {}) {
  const own = sessions.filter(s => s.agentId === agentId && matches(query, s.title) && statusOk(filter, s.status)).sort(bySessionPriority);
  return [{ id: "new:" + agentId, kind: "new-session", title: "New conversation", agentId }, ...own.map(session => sessionRow(session, 0, now))];
}

export function managerRows(history = [], { query = "", now = Date.now() } = {}) {
  return [{ id: "new:manager", kind: "new-session", title: "New conversation with Manager", manager: true },
    ...history.filter(entry => matches(query, entry.title)).map(entry => ({ id: "s:" + entry.runtimeSessionId, kind: "session", depth: 0, title: single(entry.title) || entry.runtimeSessionId,
      status: "Inactive", time: relativeTime(entry.updatedAt, now), sessionId: entry.runtimeSessionId, manager: true }))];
}

export function teamSummary(snapshot, teamId, inbox = inboxItems(snapshot)) {
  const members = snapshot.memberships.filter(m => m.teamId === teamId);
  const tasks = snapshot.tasks.filter(t => t.teamId === teamId);
  return { members: members.length, working: members.filter(m => m.status === "Working").length, needs: inbox.filter(item => item.teamId === teamId).length,
    queued: tasks.filter(t => t.status === "queued").length, delivered: tasks.filter(t => t.status === "done").length };
}

// The worst status in a team drives its sidebar glyph.
export function teamStatus(snapshot, teamId, inbox = inboxItems(snapshot)) {
  const statuses = [...snapshot.memberships.filter(m => m.teamId === teamId).map(m => m.status || "Inactive"), ...inbox.filter(item => item.teamId === teamId).map(item => item.status)];
  return statuses.sort((a, b) => statusMeta(a).rank - statusMeta(b).rank)[0] || "Inactive";
}

export function inboxItems(snapshot) {
  const items = [];
  const name = id => single(byId(snapshot.agents, id)?.name) || "Removed member";
  const teamName = id => single(byId(snapshot.teams, id)?.name) || "Team";
  for (const task of snapshot.tasks.filter(needsUser)) {
    items.push({ id: "t:" + task.id, kind: "task", status: "Needs input", title: task.status === "blocked" ? "Answer: " + single(task.blockedOn.action) : "Review: " + single(task.error || task.brief),
      context: teamName(task.teamId) + " › " + name(task.assigneeAgentId), owner: name(task.assigneeAgentId), taskId: task.id, teamId: task.teamId, answer: task.status === "blocked" });
  }
  for (const run of snapshot.runs.filter(r => r.status === "unknown")) {
    const session = snapshot.sessions.find(s => s.id === run.sessionId);
    if (!session?.teamId) continue;
    items.push({ id: "r:" + run.id, kind: "run", status: "Unconfirmed", title: "Confirm the previous run stopped", context: teamName(session.teamId) + " › " + name(session.agentId), runId: run.id, teamId: session.teamId, agentId: session.agentId });
  }
  // A running task that stops to ask a question is only visible through its
  // conversation; it is listed unless the task itself is already listed.
  const listed = new Set(items.map(item => item.taskId).filter(Boolean));
  for (const session of snapshot.sessions.filter(s => s.teamId && s.runtimeSessionId && s.status === "Needs input" && !listed.has(s.taskId))) {
    const task = snapshot.tasks.find(t => t.id === session.taskId);
    items.push({ id: "s:" + session.runtimeSessionId, kind: "session", status: "Needs input", title: task ? "Task asks: " + single(task.brief) : "Conversation is waiting for your answer",
      context: teamName(session.teamId) + " › " + name(session.agentId), sessionId: session.runtimeSessionId, agentId: session.agentId, teamId: session.teamId, ...(task ? { taskId: task.id } : {}) });
  }
  return items;
}

export function inboxRows(snapshot) {
  const items = inboxItems(snapshot);
  const rows = items.length ? [{ id: "section:needs", kind: "section", title: "Needs you", count: items.length }, ...items] : [{ id: "clear", kind: "clear", title: "Nothing needs you right now" }];
  if (snapshot.teams.length) rows.push({ id: "section:teams", kind: "section", title: "Teams", count: snapshot.teams.length },
    ...snapshot.teams.map(team => ({ id: "team:" + team.id, kind: "team", title: single(team.name), status: teamStatus(snapshot, team.id, items), teamId: team.id, summary: teamSummary(snapshot, team.id, items) })));
  else rows.push({ id: "new-team", kind: "new-team", title: "Create your first team" });
  return rows;
}

export function sidebarRows(snapshot) {
  const inbox = inboxItems(snapshot), attention = inbox.length;
  return [
    { id: "inbox", kind: "inbox", title: "Inbox", badge: attention, status: attention ? "Needs input" : undefined },
    { id: "manager", kind: "manager", title: "Manager" },
    { id: "independent", kind: "independent", title: "Independent" },
    { id: "section:teams", kind: "section", title: "Teams", count: snapshot.teams.length },
    ...snapshot.teams.map(team => ({ id: team.id, kind: "team", title: single(team.name), status: teamStatus(snapshot, team.id, inbox), teamId: team.id, summary: teamSummary(snapshot, team.id, inbox) })),
    { id: "new-team", kind: "new-team", title: "New team" },
  ];
}

// Conversations outside every team, grouped by folder. Saved history gives
// titles; registered sessions add live status. Unregistered folders run in a
// private Worker, so only their last saved activity is known.
export function independentSessions(snapshot, groups = [], managerWorkspace = "") {
  const byWorkspace = new Map(groups.map(group => [group.workspace, { ...group, sessions: group.sessions.map(s => ({ ...s })) }]));
  const live = new Map(snapshot.sessions.filter(s => !s.teamId && s.runtimeSessionId).map(s => [s.runtimeSessionId, s]));
  for (const group of byWorkspace.values()) for (const session of group.sessions) {
    const state = live.get(session.runtimeSessionId);
    session.status = state?.status || "Inactive";
    session.tracked = Boolean(state);
    if (state?.lastActivity) session.updatedAt = later(session.updatedAt, state.lastActivity);
    live.delete(session.runtimeSessionId);
  }
  // A just-started conversation is live before it is written to history.
  for (const state of live.values()) {
    const agent = byId(snapshot.agents, state.agentId);
    if (!agent || agent.canonicalWorkspace === managerWorkspace) continue;
    const key = [...byWorkspace.keys()].find(workspace => workspace === agent.canonicalWorkspace) || agent.canonicalWorkspace;
    const group = byWorkspace.get(key) || { workspace: key, agentId: agent.id, name: single(agent.name), teams: [], sessions: [] };
    group.sessions.push({ runtimeSessionId: state.runtimeSessionId, title: state.runtimeSessionId, updatedAt: state.lastActivity, status: state.status || "Inactive", tracked: true });
    byWorkspace.set(key, group);
  }
  return [...byWorkspace.values()];
}

export function independentRows(workspaces, { query = "", filter = "All", now = Date.now() } = {}) {
  const rank = group => Math.min(...group.sessions.map(s => statusMeta(s.status).rank), 99);
  const latest = group => group.sessions.reduce((max, s) => later(max, s.updatedAt), "");
  const rows = [];
  for (const group of [...workspaces].sort((a, b) => rank(a) - rank(b) || latest(b).localeCompare(latest(a)))) {
    const self = matches(query, group.name, group.workspace);
    const sessions = group.sessions.filter(s => (self || matches(query, s.title)) && statusOk(filter, s.status)).sort(bySessionPriority);
    if (!sessions.length && !(self && filter === "All")) continue;
    const working = group.sessions.filter(s => s.status === "Working").length;
    rows.push({ id: "w:" + group.workspace, kind: "workspace", depth: 0, title: single(group.name), workspace: group.workspace, agentId: group.agentId, teams: group.teams,
      status: group.sessions.map(s => s.status).sort((a, b) => statusMeta(a).rank - statusMeta(b).rank)[0] || "Inactive", sessionCount: group.sessions.length, working });
    for (const session of sessions) rows.push({ id: "s:" + session.runtimeSessionId, kind: "session", depth: 1, title: single(session.title) || session.runtimeSessionId, status: session.status,
      time: relativeTime(session.updatedAt, now), sessionId: session.runtimeSessionId, agentId: group.agentId, workspace: group.workspace, tracked: session.tracked, independent: true });
  }
  return withGuides(rows);
}

export const selectable = row => row && !["section", "clear"].includes(row.kind);
