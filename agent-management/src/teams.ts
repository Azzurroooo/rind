import { memberKey, type Session, type State, type Task } from "./model.js";

const unfinished = (task: Task) => !["done", "cancelled"].includes(task.status);

// A conversation's history stays in its folder; dropping the registration only
// turns it back into a plain session outside every team.
export function unbindSessions(state: State, release: (session: Session) => boolean) {
  const released = new Set(Object.values(state.sessions).filter(release).map(session => session.id));
  for (const id of released) delete state.sessions[id];
  for (const run of Object.values(state.runs)) if (released.has(run.sessionId)) delete state.runs[run.id];
}

// An agent is a folder bound to a team. Once nothing live refers to it (no
// team, no conversation, no task outside the archive), it is unregistered.
export function pruneAgents(state: State) {
  const used = new Set<string>();
  for (const membership of Object.values(state.memberships)) used.add(membership.agentId);
  for (const session of Object.values(state.sessions)) used.add(session.agentId);
  for (const task of Object.values(state.tasks)) {
    if (state.teams[task.teamId]?.archive) continue;
    used.add(task.assigneeAgentId);
    used.add(task.createdBy);
  }
  for (const id of Object.keys(state.agents)) if (!used.has(id)) delete state.agents[id];
}

// Deleting a team cancels work that has not finished, dissolves its
// memberships and conversations, and keeps what it delivered as a read-only
// archive (with the owners' names, since the agents may be unregistered).
// A team that never had a task leaves nothing behind. Folders are never touched.
export function dissolveTeam(state: State, teamId: string, note: (taskId: string, text: string) => void) {
  const team = state.teams[teamId];
  const tasks = Object.values(state.tasks).filter(task => task.teamId === teamId);
  for (const task of tasks.filter(unfinished)) {
    task.status = "cancelled"; delete task.dispatch; delete task.blockedOn;
    note(task.id, "Team deleted.");
  }
  const owners = new Set([...tasks.map(task => task.assigneeAgentId), ...Object.values(state.memberships).filter(m => m.teamId === teamId).map(m => m.agentId)]);
  const members = Object.fromEntries([...owners].filter(id => state.agents[id]).map(id => [id, state.agents[id].name]));
  for (const membership of Object.values(state.memberships)) if (membership.teamId === teamId) delete state.memberships[memberKey(teamId, membership.agentId)];
  unbindSessions(state, session => session.teamId === teamId);
  for (const approval of Object.values(state.approvals)) if (approval.teamId === teamId) delete state.approvals[approval.id];
  if (tasks.length) state.teams[teamId] = { ...team, archive: { at: new Date().toISOString(), members } };
  else delete state.teams[teamId];
  pruneAgents(state);
  return { archived: tasks.length > 0 };
}
