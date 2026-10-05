import { activeRun, memberKey, type Run, type Session, type State, type Task } from "./model.js";

// Lookups shared by one snapshot. Built once, so projecting every member,
// session and queued task is linear in the state instead of quadratic.
export interface ProjectionIndex {
  state: State;
  connected: Set<string>;
  runsBySession: Map<string, Run[]>;
  sessionsByMember: Map<string, Session[]>;
  tasksByMember: Map<string, Task[]>;
  reservedWorkspaces: Map<string, Run>;
}

const push = <T>(map: Map<string, T[]>, key: string, value: T) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };

export function projectionIndex(state: State, connected: Set<string>): ProjectionIndex {
  const runsBySession = new Map<string, Run[]>(), sessionsByMember = new Map<string, Session[]>(), tasksByMember = new Map<string, Task[]>(), reservedWorkspaces = new Map<string, Run>();
  for (const run of Object.values(state.runs)) {
    push(runsBySession, run.sessionId, run);
    const workspace = activeRun(run) && state.agents[state.sessions[run.sessionId]?.agentId]?.canonicalWorkspace;
    if (workspace && (!reservedWorkspaces.has(workspace) || run.status === "unknown")) reservedWorkspaces.set(workspace, run);
  }
  for (const session of Object.values(state.sessions)) push(sessionsByMember, memberKey(session.teamId || "", session.agentId), session);
  for (const task of Object.values(state.tasks)) push(tasksByMember, memberKey(task.teamId, task.assigneeAgentId), task);
  return { state, connected, runsBySession, sessionsByMember, tasksByMember, reservedWorkspaces };
}

export function memberStatus(index: ProjectionIndex, agentId: string, teamId: string) {
  const sessions = index.sessionsByMember.get(memberKey(teamId, agentId)) || [];
  const runs = sessions.flatMap(s => index.runsBySession.get(s.id) || []);
  if (runs.some(r => r.status === "unknown")) return "Unconfirmed";
  if (runs.some(r => r.status === "running" && r.needsInput)) return "Needs input";
  if (runs.some(r => ["starting", "running"].includes(r.status))) return "Working";
  const tasks = index.tasksByMember.get(memberKey(teamId, agentId)) || [];
  if (tasks.some(t => t.status === "needs_attention" || (t.status === "blocked" && t.blockedOn?.responder !== "children"))) return "Needs input";
  if (tasks.some(t => t.status === "blocked" && t.blockedOn?.responder === "children")) return "Waiting";
  if (tasks.some(t => t.status === "queued" && t.dispatch)) return "Queued";
  return sessions.some(s => index.connected.has(s.id)) ? "Ready" : "Inactive";
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
  const runs = index.runsBySession.get(sessionId) || [];
  const active = runs.find(r => activeRun(r));
  const last = active || runs.at(-1);
  return { status: active?.status === "unknown" ? "Unconfirmed" : active?.needsInput ? "Needs input" : active ? "Working" : index.connected.has(sessionId) ? "Ready" : "Inactive",
    ...(last ? { lastActivity: last.lastObservedAt, ...(last.taskId ? { taskId: last.taskId } : {}) } : {}) };
}
