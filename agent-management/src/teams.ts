import { activeRun, memberKey, type Session, type State, type Task } from "./model.js";

const unfinished = (task: Task) => !["done", "cancelled"].includes(task.status);

// A conversation's history stays in its folder; dropping the registration only
// turns it back into a plain session outside every team. One that a window
// still shows keeps a teamless registration, so its next turn and its detach
// still work; the detach then releases it (see releaseSession).
export function unbindSessions(state: State, release: (session: Session) => boolean, isOpen: (session: Session) => boolean) {
  const agents = new Set<string>();
  for (const session of Object.values(state.sessions).filter(release)) {
    agents.add(session.agentId);
    if (isOpen(session)) { delete session.teamId; session.released = true; continue; }
    dropSession(state, session.id);
  }
  return agents;
}
export function dropSession(state: State, sessionId: string) {
  delete state.sessions[sessionId];
  for (const run of Object.values(state.runs)) if (run.sessionId === sessionId) delete state.runs[run.id];
}

// An agent is a folder bound to a team. A folder this operation released is
// unregistered once nothing live refers to it, unless it carries its own
// instructions or skills, which would otherwise be lost. Other registrations
// (one made for an addMember that follows, or older ones) are never touched.
export function pruneAgents(state: State, candidates: Iterable<string>) {
  const used = new Set<string>();
  for (const membership of Object.values(state.memberships)) used.add(membership.agentId);
  for (const session of Object.values(state.sessions)) used.add(session.agentId);
  for (const task of Object.values(state.tasks)) {
    if (state.teams[task.teamId]?.archive) continue;
    used.add(task.assigneeAgentId);
    used.add(task.createdBy);
  }
  for (const id of candidates) {
    const agent = state.agents[id];
    if (agent && !used.has(id) && !agent.hint && !agent.skillRefs?.length) delete state.agents[id];
  }
}

// A request the user has not decided yet disappears once it no longer applies,
// and so does a notice about a team or member that is gone.
export function expireApprovals(state: State) {
  for (const approval of Object.values(state.approvals)) {
    const team = state.teams[approval.teamId];
    const run = approval.runId ? state.runs[approval.runId] : undefined;
    if (!team || team.archive || (approval.kind === "cancelRun" && !(run && activeRun(run)))) delete state.approvals[approval.id];
  }
  for (const notice of Object.values(state.notices)) {
    if (!state.teams[notice.teamId] || state.teams[notice.teamId].archive || !state.memberships[memberKey(notice.teamId, notice.agentId)]) delete state.notices[notice.id];
  }
}

// Deleting a team cancels work that has not finished, dissolves its
// memberships and conversations, and keeps what it delivered as a read-only
// archive (with the owners' names, since the agents may be unregistered).
// A team that never had a task leaves nothing behind. Folders are never touched.
export function dissolveTeam(state: State, teamId: string, note: (taskId: string, text: string) => void, isOpen: (session: Session) => boolean) {
  const team = state.teams[teamId];
  const tasks = Object.values(state.tasks).filter(task => task.teamId === teamId);
  for (const task of tasks.filter(unfinished)) {
    task.status = "cancelled"; delete task.dispatch; delete task.blockedOn;
    note(task.id, "Team deleted.");
  }
  const memberIds = Object.values(state.memberships).filter(m => m.teamId === teamId).map(m => m.agentId);
  const owners = new Set([...tasks.map(task => task.assigneeAgentId), ...memberIds]);
  const members = Object.fromEntries([...owners].filter(id => state.agents[id]).map(id => [id, state.agents[id].name]));
  for (const agentId of memberIds) delete state.memberships[memberKey(teamId, agentId)];
  const released = unbindSessions(state, session => session.teamId === teamId, isOpen);
  if (tasks.length) state.teams[teamId] = { ...team, archive: { at: new Date().toISOString(), members } };
  else delete state.teams[teamId];
  pruneAgents(state, new Set([...memberIds, ...released]));
  return { archived: tasks.length > 0 };
}
