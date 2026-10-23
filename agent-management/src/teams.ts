import { activeRun, awaitingDelegation, memberKey, type Session, type State } from "./model.js";

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
    if (!state.teams[task.teamId]) continue;
    used.add(task.assigneeAgentId);
  }
  for (const d of Object.values(state.delegations || {})) {
    if (awaitingDelegation(d)) { used.add(d.assigneeAgentId); used.add(d.fromAgentId); }
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
    if (!team || (approval.kind === "cancelRun" && !(run && activeRun(run)))) delete state.approvals[approval.id];
  }
  for (const notice of Object.values(state.notices)) {
    if (!state.teams[notice.teamId] || !state.memberships[memberKey(notice.teamId, notice.agentId)]) delete state.notices[notice.id];
  }
}

// Deleting a team removes its tasks, notes, artifacts, delegations and
// memberships, and releases its conversations. Folders are never touched.
export function dissolveTeam(state: State, teamId: string, isOpen: (session: Session) => boolean) {
  const tasks = Object.values(state.tasks).filter(task => task.teamId === teamId);
  const taskIds = new Set(tasks.map(task => task.id));
  for (const id of taskIds) delete state.tasks[id];
  for (const [noteId, note] of Object.entries(state.notes)) if (taskIds.has(note.taskId)) delete state.notes[noteId];
  for (const [artId, art] of Object.entries(state.artifacts)) if (taskIds.has(art.taskId)) delete state.artifacts[artId];
  for (const [runId, run] of Object.entries(state.runs)) if (run.taskId && taskIds.has(run.taskId) && !activeRun(run)) delete state.runs[runId];
  for (const d of Object.values(state.delegations || {})) {
    if (d.teamId !== teamId) continue;
    delete state.delegations[d.id];
    for (const [runId, run] of Object.entries(state.runs)) if (run.delegationId === d.id && !activeRun(run)) delete state.runs[runId];
  }
  const memberIds = Object.values(state.memberships).filter(m => m.teamId === teamId).map(m => m.agentId);
  const owners = new Set([...tasks.map(task => task.assigneeAgentId), ...memberIds]);
  for (const agentId of memberIds) delete state.memberships[memberKey(teamId, agentId)];
  const released = unbindSessions(state, session => session.teamId === teamId, isOpen);
  delete state.teams[teamId];
  pruneAgents(state, new Set([...owners, ...released]));
  return { deleted: true };
}
