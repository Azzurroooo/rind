import { memberKey, requireValue, type State } from "./model.js";

export function supervisor(state: State, teamId: string, agentId: string): string | undefined {
  const leader = state.teams[teamId]?.leaderAgentId;
  if (agentId === leader) return undefined;
  return state.memberships[memberKey(teamId, agentId)]?.reportsToAgentId || leader;
}

export function manages(state: State, teamId: string, managerId: string, agentId: string) {
  const visited = new Set<string>([agentId]);
  for (let id = supervisor(state, teamId, agentId); id && !visited.has(id); id = supervisor(state, teamId, id)) {
    if (id === managerId) return true;
    visited.add(id);
  }
  return false;
}

export function setSupervisor(state: State, teamId: string, agentId: string, parentId: string) {
  const member = state.memberships[memberKey(teamId, agentId)];
  requireValue(member && state.memberships[memberKey(teamId, parentId)], "NOT_TEAM_MEMBER", "Both members must belong to this team.");
  requireValue(state.teams[teamId].leaderAgentId !== agentId, "LEADER_ROOT", "The main agent has no supervisor.");
  requireValue(agentId !== parentId && !manages(state, teamId, agentId, parentId), "ORGANIZATION_CYCLE", "A member cannot report to itself or its descendants.");
  if (parentId === state.teams[teamId].leaderAgentId) delete member.reportsToAgentId;
  else member.reportsToAgentId = parentId;
  return member;
}
