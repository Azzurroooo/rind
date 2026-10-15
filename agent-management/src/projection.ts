import { activeRun, entryTask, memberKey, type Approval, type Delegation, type Membership, type Run, type Session, type State, type Task, type Team } from "./model.js";

// Lookups shared by one snapshot. Built once, so projecting every member,
// session and queued task is linear in the state instead of quadratic.
// What the shared Runtime reports for one session right now.
// background: jobs a session started that still run; it resumes when they finish.
// title: set when the conversation was renamed since its history was read.
export interface LiveSession { id: string; workspace: string; turn: "idle" | "running" | "question"; startedAt: string; updatedAt: string; watchers: number; background?: { count: number; commands: string[]; startedAt: string } | null; title?: string }

// Not thinking, but not stopped: the turn ended and its jobs still run.
const runningJob = (live?: LiveSession) => live?.turn === "idle" && (live.background?.count || 0) > 0;

export interface ProjectionIndex {
  state: State;
  connected: Set<string>;
  live: Map<string, LiveSession>;
  runsBySession: Map<string, Run[]>;
  sessionsByMember: Map<string, Session[]>;
  tasksByMember: Map<string, Task[]>;
  delegationsByMember: Map<string, Delegation[]>;
  delegationsByOriginSession: Map<string, Delegation[]>;
  delegationsByTask: Map<string, Delegation[]>;
  unknownByMember: Set<string>;
  reservedWorkspaces: Map<string, Run>;
}

const push = <T>(map: Map<string, T[]>, key: string, value: T) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };

export function projectionIndex(state: State, connected: Set<string>, live: Map<string, LiveSession> = new Map()): ProjectionIndex {
  const runsBySession = new Map<string, Run[]>(), sessionsByMember = new Map<string, Session[]>(), tasksByMember = new Map<string, Task[]>(), delegationsByMember = new Map<string, Delegation[]>(), delegationsByOriginSession = new Map<string, Delegation[]>(), delegationsByTask = new Map<string, Delegation[]>(), unknownByMember = new Set<string>(), reservedWorkspaces = new Map<string, Run>();
  for (const run of Object.values(state.runs)) {
    push(runsBySession, run.sessionId, run);
    const session = state.sessions[run.sessionId];
    const workspace = activeRun(run) && state.agents[session?.agentId]?.canonicalWorkspace;
    if (workspace && (!reservedWorkspaces.has(workspace) || run.status === "unknown")) reservedWorkspaces.set(workspace, run);
    const liveSession = session?.runtimeSessionId ? live.get(session.runtimeSessionId) : undefined;
    const liveActive = liveSession?.turn === "running" || liveSession?.turn === "question" || runningJob(liveSession);
    if (run.status === "unknown" && !liveActive) {
      const task = run.taskId ? state.tasks[run.taskId] : undefined;
      const origin = run.delegationId ? state.delegations?.[run.delegationId]?.originSessionId : undefined;
      const teamId = task?.teamId || session?.teamId || (origin ? state.sessions[origin]?.teamId : undefined);
      const agentId = task?.assigneeAgentId || (origin ? state.sessions[origin]?.agentId : undefined) || session?.agentId;
      if (teamId && agentId) unknownByMember.add(memberKey(teamId, agentId));
    }
  }
  for (const session of Object.values(state.sessions)) push(sessionsByMember, memberKey(session.teamId || "", session.agentId), session);
  for (const task of Object.values(state.tasks)) if (entryTask(task)) push(tasksByMember, memberKey(task.teamId, task.assigneeAgentId), task);
  for (const d of Object.values(state.delegations || {})) {
    push(delegationsByMember, memberKey(d.teamId, d.assigneeAgentId), d);
    if (d.originSessionId && !d.parentDelegationId) push(delegationsByOriginSession, d.originSessionId, d);
    if (d.taskId && !d.parentDelegationId) push(delegationsByTask, d.taskId, d);
  }
  return { state, connected, live, runsBySession, sessionsByMember, tasksByMember, delegationsByMember, delegationsByOriginSession, delegationsByTask, unknownByMember, reservedWorkspaces };
}

// Open: at least one window shows the conversation. Shared conversations are
// counted by the Runtime that hosts them; a private one by its own window.
function isOpen(index: ProjectionIndex, session: Session) {
  const live = index.live.get(session.runtimeSessionId);
  return live ? live.watchers > 0 : !session.shared && index.connected.has(session.id);
}

// Waiting for delegated work: a task blocked on children, an interactive
// session whose delegated work has not returned yet, or a delivery queued
// to resume this session.
function waitingOnDelegation(index: ProjectionIndex, sessionId: string, taskId?: string) {
  const session = index.state.sessions[sessionId];
  const task = taskId ? index.state.tasks[taskId] : undefined;
  if (task?.status === "blocked" && task.blockedOn?.responder === "children") return true;
  if (session?.delegationId && index.state.delegations[session.delegationId]?.status === "waiting") return true;
  if (index.state.deliveries[sessionId]?.texts.length) return true;
  return (index.delegationsByOriginSession.get(sessionId) || []).some(d => !d.returned && d.status !== "cancelled");
}

export function memberStatus(index: ProjectionIndex, agentId: string, teamId: string) {
  const key = memberKey(teamId, agentId);
  const sessions = index.sessionsByMember.get(key) || [];
  const runs = sessions.flatMap(s => index.runsBySession.get(s.id) || []);
  const lives = sessions.map(s => index.live.get(s.runtimeSessionId));
  const turns = lives.map(live => live?.turn);
  if (turns.includes("question") || runs.some(r => r.status === "running" && r.needsInput)) return "Needs input";
  if (turns.includes("running")) return "Working";
  if (lives.some(runningJob)) return "Running job";
  if (runs.some(r => ["starting", "running"].includes(r.status))) return "Working";
  if (index.unknownByMember.has(key)) return "Unconfirmed";
  const tasks = index.tasksByMember.get(key) || [];
  const delegations = index.delegationsByMember.get(key) || [];
  if (tasks.some(t => t.status === "needs_attention" || (t.status === "blocked" && t.blockedOn?.responder === "user"))) return "Needs input";
  if (tasks.some(t => t.status === "blocked" && t.blockedOn?.responder === "children") || delegations.some(d => d.status === "waiting") || sessions.some(s => { const last = (index.runsBySession.get(s.id) || []).at(-1); return waitingOnDelegation(index, s.id, !last?.delegationId ? last?.taskId : undefined); })) return "Delegated";
  if (tasks.some(t => t.status === "queued" && t.dispatch) || delegations.some(d => d.status === "queued" && d.dispatch)) return "Queued";
  return sessions.some(s => isOpen(index, s)) ? "Open" : "Idle";
}

export function queuedReason(index: ProjectionIndex, task: Task) {
  if (task.status !== "queued") return undefined;
  if (!task.dispatch) return "Ready to start";
  const reserved = index.reservedWorkspaces.get(index.state.agents[task.assigneeAgentId]?.canonicalWorkspace);
  return reserved?.status === "unknown" ? "Workspace reserved by an unconfirmed run" : reserved ? "Waiting for this workspace to become free" : "Waiting for dispatch";
}

export const priorityRank = (task: Task) => ({ high: 0, normal: 1, low: 2 }[task.priority || "normal"]);

export function teamBriefing(tasks: Task[], agents: State["agents"]) {
  const item = (task: Task) => ({ taskId: task.id, owner: agents[task.assigneeAgentId]?.name || "Removed member", brief: task.brief, status: task.status,
    summary: task.report?.summary || task.blockedOn?.action || task.error || task.status,
    ...(task.blockedOn ? { responder: agents[task.blockedOn.responder]?.name || task.blockedOn.responder } : {}),
    ...(task.report?.artifacts.length ? { artifacts: task.report.artifacts } : {}) });
  return {
    needsAttention: tasks.filter(t => t.status === "needs_attention" || (t.status === "blocked" && t.blockedOn?.responder === "user")).map(item),
    inProgress: tasks.filter(t => ["running", "queued"].includes(t.status)).map(item),
    waiting: tasks.filter(t => t.status === "blocked" && t.blockedOn?.responder !== "user").map(item),
    delivered: tasks.filter(t => t.status === "done").slice(-10).reverse().map(item),
  };
}

export function sessionStatus(index: ProjectionIndex, sessionId: string) {
  const session = index.state.sessions[sessionId];
  const runs = index.runsBySession.get(sessionId) || [];
  const active = runs.find(r => activeRun(r));
  const last = active || runs.at(-1);
  const ownDelegationId = last?.delegationId || session?.delegationId;
  const ownTaskId = !ownDelegationId ? last?.taskId : undefined;
  const live = session && index.live.get(session.runtimeSessionId);
  const status = live?.turn === "question" || active?.needsInput ? "Needs input"
    : live?.turn === "running" ? "Working"
    : runningJob(live) ? "Running job"
    : active?.status === "unknown" && !active.delegationId ? "Unconfirmed"
    : active && active.status !== "unknown" ? "Working"
    : (ownDelegationId && index.state.delegations[ownDelegationId]?.status === "waiting") || waitingOnDelegation(index, sessionId, ownTaskId) ? "Delegated"
    : session && isOpen(index, session) ? "Open" : "Idle";
  const lastActivity = [last?.lastObservedAt, live?.updatedAt].filter(Boolean).sort().at(-1);
  const owned = [
    ...(index.delegationsByOriginSession.get(sessionId) || []),
    ...(ownTaskId ? index.delegationsByTask.get(ownTaskId) || [] : []),
    ...(ownDelegationId ? Object.values(index.state.delegations).filter(d => d.parentDelegationId === ownDelegationId) : []),
  ];
  const pending = [...new Map(owned.filter(d => !d.returned && d.status !== "cancelled").map(d => [d.id, d])).values()]
    .map(d => ({ taskId: d.id, assignee: index.state.agents[d.assigneeAgentId]?.name || d.assigneeAgentId }));
  return {
    status,
    ...(lastActivity ? { lastActivity } : {}),
    ...(ownTaskId ? { taskId: ownTaskId } : {}),
    ...(live ? { watchers: live.watchers } : {}),
    ...(pending.length ? { pendingDelegations: pending } : {}),
  };
}

// The organization as the user and the Manager read it (the service's snapshot).
export interface OrganizationView {
  teams: Team[]; memberships: (Membership & { status: string })[]; tasks: (Task & { queueReason?: string })[];
  sessions: { id: string; agentId: string }[]; runs: Run[]; approvals: Approval[];
}

const RECENT_DELIVERIES = 5;
const PREVIEW_LENGTH = 200;
const preview = (text: string) => text.length > PREVIEW_LENGTH ? text.slice(0, PREVIEW_LENGTH) + "…" : text;

// The Manager's snapshot: who is on each team, open work, the latest deliveries, active runs and approvals.
// Everything else (all tasks, notes, artifacts) is read with getTeam, getTask and readArtifact.
export function managerOverview(view: OrganizationView, agents: State["agents"]) {
  const open = view.tasks.filter(t => t.status !== "done" && t.status !== "cancelled");
  const delivered = view.tasks.filter(t => t.status === "done")
    .sort((a, b) => (b.deliveredAt || "").localeCompare(a.deliveredAt || "")).slice(0, RECENT_DELIVERIES);
  const agentOf = new Map(view.sessions.map(s => [s.id, s.agentId]));
  return {
    teams: view.teams.map(team => ({
      id: team.id, name: team.name, ...(team.leaderAgentId ? { leaderAgentId: team.leaderAgentId } : {}),
      members: view.memberships.filter(m => m.teamId === team.id).map(m => ({
        agentId: m.agentId, name: agents[m.agentId]?.name || m.agentId, workspace: agents[m.agentId]?.canonicalWorkspace, status: m.status,
        ...(m.position ? { position: m.position } : {}), ...(m.responsibility ? { responsibility: m.responsibility } : {}),
        ...(m.reportsToAgentId ? { reportsToAgentId: m.reportsToAgentId } : {}),
      })),
    })),
    tasks: [...open, ...delivered].map(task => ({
      id: task.id, teamId: task.teamId, assigneeAgentId: task.assigneeAgentId, status: task.status, brief: preview(task.brief),
      ...(task.priority ? { priority: task.priority } : {}), ...(task.queueReason ? { queueReason: task.queueReason } : {}),
      ...(task.blockedOn ? { blockedOn: task.blockedOn } : {}), ...(task.error ? { error: preview(task.error) } : {}),
      ...(task.report ? { outcome: task.report.outcome } : {}),
    })),
    omittedTasks: view.tasks.length - open.length - delivered.length,
    runs: view.runs.filter(activeRun).map(r => ({ id: r.id, agentId: agentOf.get(r.sessionId), status: r.status, ...(r.taskId ? { taskId: r.taskId } : {}) })),
    approvals: view.approvals,
  };
}
