import { activeRun, type State, type Task } from "./model.js";

export function memberStatus(state: State, agentId: string, teamId: string | undefined, connected: Set<string>) {
  const sessions = Object.values(state.sessions).filter(s => s.agentId === agentId && s.teamId === teamId);
  const sessionIds = new Set(sessions.map(s => s.id));
  const runs = Object.values(state.runs).filter(r => sessionIds.has(r.sessionId));
  if (runs.some(r => r.status === "unknown")) return "Unconfirmed";
  if (runs.some(r => r.status === "running" && r.needsInput)) return "Needs input";
  if (runs.some(r => ["starting", "running"].includes(r.status))) return "Working";
  const tasks = Object.values(state.tasks).filter(t => t.teamId === teamId && t.assigneeAgentId === agentId);
  if (tasks.some(t => t.status === "needs_attention" || (t.status === "blocked" && t.blockedOn?.responder !== "children"))) return "Needs input";
  if (tasks.some(t => t.status === "blocked" && t.blockedOn?.responder === "children")) return "Waiting";
  if (tasks.some(t => t.status === "queued" && t.dispatch)) return "Queued";
  return sessions.some(s => connected.has(s.id)) ? "Ready" : "Inactive";
}

export function queuedReason(state: State, task: Task) {
  if (task.status !== "queued") return undefined;
  if (!task.dispatch) return "Ready to start";
  const workspace = state.agents[task.assigneeAgentId]?.canonicalWorkspace;
  const reserved = Object.values(state.runs).find(run => activeRun(run) && state.agents[state.sessions[run.sessionId]?.agentId]?.canonicalWorkspace === workspace);
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

export function sessionStatus(state: State, sessionId: string, connected: Set<string>) {
  const runs = Object.values(state.runs).filter(r => r.sessionId === sessionId);
  const active = runs.find(r => activeRun(r));
  const last = active || runs.at(-1);
  return { status: active?.status === "unknown" ? "Unconfirmed" : active?.needsInput ? "Needs input" : active ? "Working" : connected.has(sessionId) ? "Ready" : "Inactive",
    ...(last ? { lastActivity: last.lastObservedAt, ...(last.taskId ? { taskId: last.taskId } : {}) } : {}) };
}
