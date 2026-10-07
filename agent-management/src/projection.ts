import { activeRun, memberKey, type Run, type Session, type State, type Task } from "./model.js";

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
  reservedWorkspaces: Map<string, Run>;
}

const push = <T>(map: Map<string, T[]>, key: string, value: T) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };

export function projectionIndex(state: State, connected: Set<string>, live: Map<string, LiveSession> = new Map()): ProjectionIndex {
  const runsBySession = new Map<string, Run[]>(), sessionsByMember = new Map<string, Session[]>(), tasksByMember = new Map<string, Task[]>(), reservedWorkspaces = new Map<string, Run>();
  for (const run of Object.values(state.runs)) {
    push(runsBySession, run.sessionId, run);
    const workspace = activeRun(run) && state.agents[state.sessions[run.sessionId]?.agentId]?.canonicalWorkspace;
    if (workspace && (!reservedWorkspaces.has(workspace) || run.status === "unknown")) reservedWorkspaces.set(workspace, run);
  }
  for (const session of Object.values(state.sessions)) push(sessionsByMember, memberKey(session.teamId || "", session.agentId), session);
  for (const task of Object.values(state.tasks)) push(tasksByMember, memberKey(task.teamId, task.assigneeAgentId), task);
  return { state, connected, live, runsBySession, sessionsByMember, tasksByMember, reservedWorkspaces };
}

// Open: at least one window shows the conversation. Shared conversations are
// counted by the Runtime that hosts them; a private one by its own window.
function isOpen(index: ProjectionIndex, session: Session) {
  const live = index.live.get(session.runtimeSessionId);
  return live ? live.watchers > 0 : !session.shared && index.connected.has(session.id);
}

export function memberStatus(index: ProjectionIndex, agentId: string, teamId: string) {
  const sessions = index.sessionsByMember.get(memberKey(teamId, agentId)) || [];
  const runs = sessions.flatMap(s => index.runsBySession.get(s.id) || []);
  const lives = sessions.map(s => index.live.get(s.runtimeSessionId));
  const turns = lives.map(live => live?.turn);
  if (runs.some(r => r.status === "unknown")) return "Unconfirmed";
  if (turns.includes("question") || runs.some(r => r.status === "running" && r.needsInput)) return "Needs input";
  if (turns.includes("running")) return "Working";
  if (lives.some(runningJob)) return "Running job";
  if (runs.some(r => ["starting", "running"].includes(r.status))) return "Working";
  const tasks = index.tasksByMember.get(memberKey(teamId, agentId)) || [];
  if (tasks.some(t => t.status === "needs_attention" || (t.status === "blocked" && t.blockedOn?.responder !== "children"))) return "Needs input";
  if (tasks.some(t => t.status === "blocked" && t.blockedOn?.responder === "children")) return "Delegated";
  if (tasks.some(t => t.status === "queued" && t.dispatch)) return "Queued";
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
  const live = session && index.live.get(session.runtimeSessionId);
  const status = active?.status === "unknown" ? "Unconfirmed"
    : live?.turn === "question" || active?.needsInput ? "Needs input"
    : live?.turn === "running" ? "Working"
    : runningJob(live) ? "Running job"
    : active ? "Working"
    : session && isOpen(index, session) ? "Open" : "Idle";
  const lastActivity = [last?.lastObservedAt, live?.updatedAt].filter(Boolean).sort().at(-1);
  return { status, ...(lastActivity ? { lastActivity } : {}), ...(last?.taskId ? { taskId: last.taskId } : {}), ...(live ? { watchers: live.watchers } : {}) };
}
