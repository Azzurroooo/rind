// Pure projections from the management snapshot into the rows the Agents page
// renders. Nothing here touches the terminal or the service.

export const emptyAgentsSnapshot = () => ({ teams: [], memberships: [], agents: [], tasks: [], runs: [], sessions: [], notes: [], artifacts: [], approvals: [], archivedTeams: [] });

export const clean = value => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export const single = value => clean(value).replace(/\s+/g, " ").trim();

const STATUS = {
  "Needs input": { glyph: "!", tone: "warning", rank: 0, attention: true },
  Unconfirmed: { glyph: "?", tone: "danger", rank: 1, attention: true },
  Working: { glyph: "●", tone: "accent", rank: 2 },
  // Not your move: a job it started still runs, or its members work for it.
  // Both resume by themselves, so neither says "waiting".
  "Running job": { glyph: "↻", tone: "accent", rank: 3 },
  Delegated: { glyph: "⋯", tone: "notice", rank: 4 },
  Queued: { glyph: "◦", tone: "notice", rank: 5 },
  Open: { glyph: "○", tone: "success", rank: 6 },
  Done: { glyph: "✓", tone: "success", rank: 7 },
  Idle: { glyph: "·", tone: "dim", rank: 8 },
  Cancelled: { glyph: "×", tone: "dim", rank: 9 },
};
export const STATUS_FILTERS = ["All", ...Object.keys(STATUS)];

// A member's state is described in terms of the person, so a member whose
// conversation is open in a window reads "1 open" instead of repeating the child status.
const MEMBER_STATE = { "Needs input": "needs you", Unconfirmed: "unconfirmed", Working: "working", "Running job": "running a job", Delegated: "delegated", Queued: "task queued" };
export function memberState(status, open = 0) {
  if (MEMBER_STATE[status]) return { tone: status, label: MEMBER_STATE[status] };
  if (open) return { tone: "Open", label: open + " open" };
  return { tone: "Idle", label: "idle" };
}
export const statusMeta = status => STATUS[status] || STATUS.Idle;

// A conversation's state as the shared Runtime reports it.
export const liveStatus = live => live.turn === "question" ? "Needs input" : live.turn === "running" ? "Working" : live.background?.count > 0 ? "Running job" : live.watchers > 0 ? "Open" : "Idle";
// The jobs a conversation resumes after, in a few words: "npm test +1".
export function jobSummary(background) {
  if (!background?.count) return "";
  const first = single(background.commands?.[0]);
  const more = background.count - (first ? 1 : 0);
  return first ? first + (more > 0 ? " +" + more : "") : background.count + (background.count === 1 ? " job" : " jobs");
}

const TASK_STATUS = { running: "Working", queued: "Queued", blocked: "Needs input", needs_attention: "Needs input", done: "Done", cancelled: "Cancelled" };
export const needsUser = task => task.status === "needs_attention" || (task.status === "blocked" && task.blockedOn?.responder === "user");
export function taskStatus(task) {
  if (task.status === "blocked" && !needsUser(task)) return "Delegated";
  return TASK_STATUS[task.status] || "Idle";
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

// A rename reaches the live table at once; history catches up on its next read.
const liveTitle = (snapshot, id) => single((snapshot.live || []).find(item => item.id === id)?.title);

// Saved history supplies titles; the snapshot supplies live status. Only
// conversations registered to this team are kept.
export function teamSessions(snapshot, teamId, history = []) {
  const sessions = new Map();
  for (const entry of history) if (entry.teamId === teamId && entry.runtimeSessionId) {
    sessions.set(entry.runtimeSessionId, { id: entry.runtimeSessionId, agentId: entry.agentId, teamId, title: liveTitle(snapshot, entry.runtimeSessionId) || single(entry.title) || entry.runtimeSessionId, updatedAt: entry.updatedAt, status: "Idle" });
  }
  for (const live of snapshot.sessions) if (live.teamId === teamId && live.runtimeSessionId) {
    const saved = sessions.get(live.runtimeSessionId);
    sessions.set(live.runtimeSessionId, { id: live.runtimeSessionId, agentId: live.agentId, teamId, title: saved?.title || liveTitle(snapshot, live.runtimeSessionId) || live.runtimeSessionId,
      updatedAt: later(saved?.updatedAt, live.lastActivity), status: live.status || "Idle", ...(live.taskId ? { taskId: live.taskId } : {}) });
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
    const row = { id: "m:" + member.agentId, kind: "member", depth, title: single(agent?.name) || "Missing member", role: role === "Member" ? "" : role, status: member.status || "Idle", ownStatus: member.status || "Idle",
      agentId: member.agentId, teamId, leader: role === "Leader", sessionCount: own.length,
      tasks: snapshot.tasks.filter(t => t.teamId === teamId && t.assigneeAgentId === member.agentId && !["done", "cancelled"].includes(t.status)).length, open: own.filter(s => s.status !== "Idle").length, reportCount: reports(member.agentId).length,
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
  { id: "delegated", title: "Delegated to members", test: task => task.status === "blocked" && !needsUser(task) },
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

const liveById = (live, id) => { const item = live.find(entry => entry.id === id); return item ? liveStatus(item) : "Idle"; };
export function managerRows(history = [], { query = "", now = Date.now(), live = [] } = {}) {
  return [{ id: "new:manager", kind: "new-session", title: "New conversation with Manager", manager: true },
    ...history.filter(entry => matches(query, entry.title)).map(entry => ({ id: "s:" + entry.runtimeSessionId, kind: "session", depth: 0, title: single(live.find(item => item.id === entry.runtimeSessionId)?.title) || single(entry.title) || entry.runtimeSessionId,
      status: liveById(live, entry.runtimeSessionId), time: relativeTime(entry.updatedAt, now), sessionId: entry.runtimeSessionId, manager: true }))];
}

export function teamSummary(snapshot, teamId, inbox = inboxItems(snapshot)) {
  const members = snapshot.memberships.filter(m => m.teamId === teamId);
  const tasks = snapshot.tasks.filter(t => t.teamId === teamId);
  return { members: members.length, working: members.filter(m => m.status === "Working").length, needs: inbox.filter(item => item.teamId === teamId).length,
    queued: tasks.filter(t => t.status === "queued").length, delivered: tasks.filter(t => t.status === "done").length };
}

// The worst status in a team drives its sidebar glyph.
export function teamStatus(snapshot, teamId, inbox = inboxItems(snapshot)) {
  const statuses = [...snapshot.memberships.filter(m => m.teamId === teamId).map(m => m.status || "Idle"), ...inbox.filter(item => item.teamId === teamId).map(item => item.status)];
  return statuses.sort((a, b) => statusMeta(a).rank - statusMeta(b).rank)[0] || "Idle";
}

// A delivery the user has not accepted or sent back yet: a top-level task the
// user or Manager gave out. Work members hand each other, and deliveries from
// before reviews existed (no deliveredAt), are not marked new.
export const unreviewed = task => task.status === "done" && Boolean(task.report && task.deliveredAt) && !task.review && !task.parentTaskId && ["user", "manager"].includes(task.createdBy);
const FRESH_LIMIT = 20;

export function inboxItems(snapshot) {
  const items = [];
  const name = id => single(byId(snapshot.agents, id)?.name) || "Removed member";
  const teamName = id => single(byId(snapshot.teams, id)?.name) || "Team";
  // The Manager's destructive requests wait for the user's decision first.
  for (const approval of snapshot.approvals || []) {
    items.push({ id: "a:" + approval.id, kind: "approval", status: "Needs input", title: "Approve: " + single(approval.title), context: teamName(approval.teamId) + " › Manager", approvalId: approval.id, teamId: approval.teamId });
  }
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
  // What was delivered lately: every delivery not reviewed yet (marked new),
  // then the latest reviewed ones, newest first.
  const finished = task => task.deliveredAt || snapshot.runs.filter(run => run.taskId === task.id).reduce((max, run) => later(max, run.lastObservedAt), "");
  const done = snapshot.tasks.filter(task => task.status === "done").map(task => ({ task, at: finished(task) })).sort((a, b) => b.at.localeCompare(a.at));
  const fresh = done.filter(({ task }) => unreviewed(task));
  const delivered = [...fresh.slice(0, FRESH_LIMIT), ...done.filter(({ task }) => !unreviewed(task)).slice(0, Math.max(0, 8 - fresh.length))];
  // What the Manager changed on its own, until the user dismisses it.
  const notices = [...(snapshot.notices || [])].reverse();
  if (notices.length) rows.push({ id: "section:notices", kind: "section", title: "Changed by the Manager", count: notices.length },
    ...notices.map(notice => ({ id: "n:" + notice.id, kind: "notice", title: single(notice.title), noticeId: notice.id, teamId: notice.teamId, agentId: notice.agentId,
      context: (single(byId(snapshot.teams, notice.teamId)?.name) || "Team") + " › " + (single(byId(snapshot.agents, notice.agentId)?.name) || "Member") + " · " + relativeTime(notice.createdAt) })));
  if (delivered.length) rows.push({ id: "section:delivered", kind: "section", title: "Recently delivered" + (fresh.length ? " · " + fresh.length + " new" : ""), count: undefined },
    ...delivered.map(({ task, at }) => ({ id: "d:" + task.id, kind: "task", status: "Done", fresh: unreviewed(task), reworked: task.review?.decision === "rework", title: single(task.brief), note: single(task.report?.summary),
      context: (single(byId(snapshot.teams, task.teamId)?.name) || "Team") + " › " + (single(byId(snapshot.agents, task.assigneeAgentId)?.name) || "Removed member") + (at ? " · " + relativeTime(at) : ""),
      owner: single(byId(snapshot.agents, task.assigneeAgentId)?.name), taskId: task.id, teamId: task.teamId })));
  if (!snapshot.teams.length) rows.push({ id: "new-team", kind: "new-team", title: "Create your first team" });
  return rows;
}

export function sidebarRows(snapshot) {
  const inbox = inboxItems(snapshot), attention = inbox.length;
  return [
    { id: "inbox", kind: "inbox", title: "Inbox", badge: attention, status: attention ? "Needs input" : undefined },
    { id: "manager", kind: "manager", title: "Manager" },
    { id: "independent", kind: "independent", title: "Independent" },
    { id: "background", kind: "background", title: "Background", badge: runningCount(snapshot) },
    { id: "section:teams", kind: "section", title: "Teams", count: snapshot.teams.length },
    ...snapshot.teams.map(team => ({ id: team.id, kind: "team", title: single(team.name), status: teamStatus(snapshot, team.id, inbox), teamId: team.id, summary: teamSummary(snapshot, team.id, inbox) })),
    { id: "new-team", kind: "new-team", title: "New team" },
    ...(snapshot.archivedTeams?.length ? [{ id: "archive", kind: "archive", title: "Archive", badge: snapshot.archivedTeams.length }] : []),
  ];
}

// Deleted teams, newest first, with what they delivered. Read-only.
export function archiveRows(archive, { query = "" } = {}) {
  if (!archive) return [{ id: "loading", kind: "clear", title: "Loading…" }];
  const rows = [];
  for (const team of archive.teams) {
    const owner = id => single(team.archive?.members?.[id]) || "Removed member";
    const tasks = team.tasks.filter(task => matches(query, task.brief, owner(task.assigneeAgentId), task.report?.summary))
      .sort((a, b) => (b.deliveredAt || "").localeCompare(a.deliveredAt || "") || single(a.brief).localeCompare(single(b.brief)));
    if (!tasks.length) continue;
    rows.push({ id: "section:" + team.id, kind: "section", title: single(team.name) + " · deleted " + relativeTime(team.archive?.at), count: undefined },
      ...tasks.map(task => ({ id: "x:" + task.id, kind: "task", archived: true, status: taskStatus(task), title: single(task.brief), note: single(task.report?.summary), owner: owner(task.assigneeAgentId), taskId: task.id, teamId: team.id })));
  }
  return rows.length ? rows : [{ id: "clear", kind: "clear", title: query ? "Nothing matches" : "No deleted teams" }];
}

// One folder can be spelled with different case or a trailing separator.
export const workspaceKey = (value, platform = process.platform) => {
  const trimmed = String(value || "").replace(/[\\/]+$/, "");
  return platform === "win32" ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
};

// Conversations outside every team, grouped by folder. Saved history gives
// titles; the shared Runtime's live table gives what runs and what is open,
// including plain conversations that management never registered.
export function independentSessions(snapshot, groups = [], managerWorkspace = "") {
  const byWorkspace = new Map(groups.map(group => [workspaceKey(group.workspace), { ...group, sessions: group.sessions.map(s => ({ ...s, status: "Idle" })) }]));
  const scoped = new Set(snapshot.sessions.filter(s => s.teamId && s.runtimeSessionId).map(s => s.runtimeSessionId));
  const manager = workspaceKey(managerWorkspace);
  for (const item of snapshot.live || []) {
    if (scoped.has(item.id)) continue;
    const key = workspaceKey(item.workspace);
    let found;
    for (const group of byWorkspace.values()) found ||= group.sessions.find(s => s.runtimeSessionId === item.id);
    if (found) { found.status = liveStatus(item); found.updatedAt = later(found.updatedAt, item.updatedAt); if (single(item.title)) found.title = single(item.title); continue; }
    // A conversation that started after the last history refresh.
    if (!item.workspace || key === manager) continue;
    const agent = snapshot.agents.find(a => workspaceKey(a.canonicalWorkspace) === key);
    const group = byWorkspace.get(key) || { workspace: agent?.canonicalWorkspace || item.workspace, ...(agent ? { agentId: agent.id } : {}), name: single(agent?.name) || item.workspace.split(/[\\/]/).filter(Boolean).at(-1) || item.workspace, teams: [], sessions: [] };
    group.sessions.push({ runtimeSessionId: item.id, title: single(item.title) || "New conversation", updatedAt: item.updatedAt, status: liveStatus(item) });
    byWorkspace.set(key, group);
  }
  // Conversations management registered outside any team, in case history
  // has not caught up (or could not be read).
  const listed = new Set([...byWorkspace.values()].flatMap(group => group.sessions.map(s => s.runtimeSessionId)));
  for (const session of snapshot.sessions) {
    if (session.teamId || !session.runtimeSessionId || listed.has(session.runtimeSessionId)) continue;
    const agent = byId(snapshot.agents, session.agentId);
    if (!agent || workspaceKey(agent.canonicalWorkspace) === manager) continue;
    const key = workspaceKey(agent.canonicalWorkspace);
    const group = byWorkspace.get(key) || { workspace: agent.canonicalWorkspace, agentId: agent.id, name: single(agent.name), teams: [], sessions: [] };
    group.sessions.push({ runtimeSessionId: session.runtimeSessionId, title: session.runtimeSessionId, updatedAt: session.lastActivity, status: session.status || "Idle" });
    byWorkspace.set(key, group);
  }
  return [...byWorkspace.values()];
}

// Folders show their most urgent few conversations; the rest open on the folder's own page.
export function independentRows(workspaces, { query = "", filter = "All", now = Date.now(), collapsed = new Set(), sessionLimit = 3 } = {}) {
  const rank = group => Math.min(...group.sessions.map(s => statusMeta(s.status).rank), 99);
  const latest = group => group.sessions.reduce((max, s) => later(max, s.updatedAt), "");
  const rows = [];
  for (const group of [...workspaces].sort((a, b) => rank(a) - rank(b) || latest(b).localeCompare(latest(a)))) {
    const self = matches(query, group.name, group.workspace);
    const sessions = group.sessions.filter(s => (self || matches(query, s.title)) && statusOk(filter, s.status)).sort(bySessionPriority);
    if (!sessions.length && !(self && filter === "All")) continue;
    const working = group.sessions.filter(s => s.status === "Working").length;
    const narrowed = Boolean(query) || filter !== "All";
    const open = narrowed || !collapsed.has(group.workspace);
    rows.push({ id: "w:" + group.workspace, kind: "workspace", depth: 0, title: single(group.name), workspace: group.workspace, agentId: group.agentId, teams: group.teams,
      status: group.sessions.map(s => s.status).sort((a, b) => statusMeta(a).rank - statusMeta(b).rank)[0] || "Idle", sessionCount: group.sessions.length, working, expanded: open });
    if (!open) continue;
    const limit = narrowed ? Infinity : sessionLimit;
    for (const session of sessions.slice(0, limit)) rows.push(independentSessionRow(session, group, 1, now));
    if (sessions.length > limit) rows.push({ id: "more:" + group.workspace, kind: "more", depth: 1, title: "+" + (sessions.length - limit) + " more conversations", workspace: group.workspace });
  }
  return withGuides(rows);
}

function independentSessionRow(session, group, depth, now) {
  return { id: "s:" + session.runtimeSessionId, kind: "session", depth, title: single(session.title) || session.runtimeSessionId, status: session.status,
    time: relativeTime(session.updatedAt, now), sessionId: session.runtimeSessionId, agentId: group.agentId, workspace: group.workspace, independent: true };
}

// Every conversation of one folder: running and open first, then by age.
export function folderRows(group, { query = "", filter = "All", now = Date.now() } = {}) {
  if (!group) return [];
  const rows = [{ id: "new:" + group.workspace, kind: "new-session", title: "New conversation in this folder", workspace: group.workspace, agentId: group.agentId }];
  const sessions = group.sessions.filter(s => matches(query, s.title) && statusOk(filter, s.status));
  const active = sessions.filter(s => s.status !== "Idle").sort(bySessionPriority);
  const day = 86400000, age = s => now - (Date.parse(s.updatedAt || "") || 0);
  const sections = [
    ["Active", active],
    ["Today", sessions.filter(s => s.status === "Idle" && age(s) < day)],
    ["This week", sessions.filter(s => s.status === "Idle" && age(s) >= day && age(s) < 7 * day)],
    ["Earlier", sessions.filter(s => s.status === "Idle" && age(s) >= 7 * day)],
  ];
  for (const [title, items] of sections) {
    if (!items.length) continue;
    rows.push({ id: "section:" + title, kind: "section", title, count: items.length });
    if (title !== "Active") items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    rows.push(...items.map(session => independentSessionRow(session, group, 0, now)));
  }
  return rows;
}

// Conversations with a turn in the shared Runtime, plus managed runs it has not reported yet.
const keepsRunning = item => item.turn !== "idle" || item.background?.count > 0;
export function runningCount(snapshot) {
  const live = new Set((snapshot.live || []).filter(keepsRunning).map(item => item.id));
  const pending = snapshot.runs.filter(run => ["starting", "running"].includes(run.status))
    .filter(run => !live.has(snapshot.sessions.find(s => s.id === run.sessionId)?.runtimeSessionId)).length;
  return live.size + pending;
}

// What keeps running after you leave Rind, and the only place that stops it.
// Every running conversation in the shared Runtime is listed, in a team or
// not; managed tasks that are still starting come from their run.
export function backgroundRows(snapshot, service, { now = Date.now() } = {}) {
  const name = id => single(byId(snapshot.agents, id)?.name) || "Agent";
  const teamName = id => single(byId(snapshot.teams, id)?.name);
  const folder = value => String(value || "").split(/[\\/]/).filter(Boolean).at(-1) || "Conversation";
  const running = [];
  const seen = new Set();
  for (const item of snapshot.live || []) {
    if (!keepsRunning(item)) continue;
    const session = snapshot.sessions.find(s => s.runtimeSessionId === item.id);
    const job = item.turn === "idle" ? item.background : null;
    const run = session && snapshot.runs.find(r => r.sessionId === session.id && ["starting", "running"].includes(r.status));
    const task = run?.taskId && snapshot.tasks.find(t => t.id === run.taskId);
    seen.add(item.id);
    running.push({ id: "live:" + item.id, kind: "live", title: task ? single(task.brief) : "Conversation", status: liveStatus(item),
      context: session ? [teamName(session.teamId), name(session.agentId)].filter(Boolean).join(" › ") : folder(item.workspace),
      time: relativeTime(job?.startedAt || item.startedAt || item.updatedAt, now), ...(job ? { note: jobSummary(job) } : {}),
      taskId: task?.id, agentId: session?.agentId, teamId: session?.teamId, sessionId: item.id, workspace: item.workspace });
  }
  for (const run of snapshot.runs.filter(r => ["starting", "running"].includes(r.status))) {
    const session = snapshot.sessions.find(s => s.id === run.sessionId);
    if (session?.runtimeSessionId && seen.has(session.runtimeSessionId)) continue;
    const task = snapshot.tasks.find(t => t.id === run.taskId);
    running.push({ id: "run:" + run.id, kind: "live", title: task ? single(task.brief) : "Conversation", status: run.needsInput ? "Needs input" : "Working",
      context: [teamName(session?.teamId), name(session?.agentId)].filter(Boolean).join(" › "), time: relativeTime(run.startedAt, now), taskId: task?.id,
      agentId: session?.agentId, teamId: session?.teamId, sessionId: session?.runtimeSessionId });
  }
  const unconfirmed = snapshot.runs.filter(run => run.status === "unknown");
  const rows = [{ id: "section:running", kind: "section", title: "Running now", count: running.length }];
  if (!running.length) rows.push({ id: "idle", kind: "clear", title: "Nothing is running. Leaving Rind stops nothing." });
  rows.push(...running.sort((a, b) => statusMeta(a.status).rank - statusMeta(b.status).rank));
  if (unconfirmed.length) {
    rows.push({ id: "section:unconfirmed", kind: "section", title: "Unconfirmed", count: unconfirmed.length });
    for (const run of unconfirmed) {
      const session = snapshot.sessions.find(s => s.id === run.sessionId);
      rows.push({ id: "r:" + run.id, kind: "run", status: "Unconfirmed", title: "Confirm the previous run stopped", context: [teamName(session?.teamId), name(session?.agentId)].filter(Boolean).join(" › "), runId: run.id });
    }
  }
  const age = value => relativeTime(value, now);
  rows.push({ id: "section:services", kind: "section", title: "Services" },
    { id: "svc:management", kind: "service", title: "Agents management", up: Boolean(service), stale: Boolean(service?.stale),
      note: service ? "pid " + service.pid + " · up " + age(service.startedAt) + (service.stale ? " · update waiting" : "") : "not connected" },
    { id: "svc:runtime", kind: "service", title: "Shared Runtime", up: Boolean(service?.runtime), stale: Boolean(service?.runtime?.stale || service?.runtime?.legacy), legacy: Boolean(service?.runtime?.legacy),
      note: !service?.runtime ? "starts when a conversation needs it" : service.runtime.legacy ? "started by an older Rind · restart to update"
        : "pid " + service.runtime.pid + " · up " + age(service.runtime.startedAt) + " · " + service.runtime.busy + " running" + (service.runtime.stale ? " · update waiting" : "") });
  // A button, not a list entry: it is also reachable with S from anywhere on the page.
  rows.push({ id: "gap", kind: "clear", title: "" }, { id: "stop-all", kind: "stop-all", title: running.length ? "Stop all agents…" : "Stop background services…", working: running.length });
  return rows;
}

export const selectable = row => row && !["section", "clear"].includes(row.kind);
