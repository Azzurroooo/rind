import { memberKey, requireValue, type State } from "./model.js";

export interface HistoryEntry { runtimeSessionId: string; agentId: string; teamId?: string; title: string; updatedAt?: string; messageCount?: number }
export interface HistoryScope { agentId?: string; teamId?: string }
type ListWorkspace = (workspace: string) => Promise<Array<Record<string, unknown>>>;

const string = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

// A team scope only returns conversations registered to that team; independent
// history in the same workspace is never surfaced through Agents management.
export async function sessionHistory(state: State, scope: HistoryScope, list: ListWorkspace): Promise<HistoryEntry[]> {
  let agentIds: string[];
  if (scope.teamId) {
    requireValue(state.teams[scope.teamId], "NOT_FOUND", "Team not found.");
    if (scope.agentId) requireValue(state.memberships[memberKey(scope.teamId, scope.agentId)], "NOT_MEMBER", "Agent is not a member of this team.");
    agentIds = scope.agentId ? [scope.agentId] : Object.values(state.memberships).filter(m => m.teamId === scope.teamId).map(m => m.agentId);
  } else {
    requireValue(scope.agentId && state.agents[scope.agentId], "NOT_FOUND", "Agent not found.");
    agentIds = [scope.agentId];
  }
  const groups = await Promise.all(agentIds.map(async agentId => {
    const registered = Object.values(state.sessions).filter(s => s.agentId === agentId && s.runtimeSessionId);
    const scoped = scope.teamId ? registered.filter(s => s.teamId === scope.teamId) : registered;
    const seen = new Set<string>();
    const entries: HistoryEntry[] = [];
    for (const raw of await list(state.agents[agentId].canonicalWorkspace)) {
      const runtimeSessionId = string(raw.id) || string(raw.session_id);
      if (!runtimeSessionId || seen.has(runtimeSessionId)) continue;
      const owner = registered.find(s => s.runtimeSessionId === runtimeSessionId);
      if (scope.teamId && owner?.teamId !== scope.teamId) continue;
      seen.add(runtimeSessionId);
      const named = string(raw.title);
      const title = (named !== "Untitled" ? named : undefined) || string(raw.first_user_message) || runtimeSessionId;
      entries.push({ runtimeSessionId, agentId, ...(owner?.teamId ? { teamId: owner.teamId } : {}), title,
        ...(string(raw.updated_at) ? { updatedAt: string(raw.updated_at) } : {}),
        ...(Number.isInteger(raw.message_count) ? { messageCount: raw.message_count as number } : {}) });
    }
    // Registered conversations that have not been written to history yet still belong to the scope.
    for (const session of scoped) if (!seen.has(session.runtimeSessionId)) {
      seen.add(session.runtimeSessionId);
      entries.push({ runtimeSessionId: session.runtimeSessionId, agentId, ...(session.teamId ? { teamId: session.teamId } : {}), title: session.runtimeSessionId });
    }
    return entries;
  }));
  return groups.flat().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export interface WorkspaceSession { runtimeSessionId: string; title: string; updatedAt?: string; sessionId?: string }
export interface WorkspaceGroup { workspace: string; agentId?: string; name: string; teams: string[]; sessions: WorkspaceSession[] }
type ListAll = () => Promise<Array<Record<string, unknown>>>;

const workspaceKey = (value: string) => {
  const normal = value.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normal.replace(/\//g, "\\").toLowerCase() : normal;
};

// Conversations outside every team, grouped by the folder they run in. Team
// and Manager conversations are excluded; the folder is named after its agent
// when it is registered, otherwise after its basename.
export async function independentHistory(state: State, managerWorkspace: string, list: ListAll): Promise<WorkspaceGroup[]> {
  const registered = new Map(Object.values(state.sessions).filter(s => s.runtimeSessionId).map(s => [s.runtimeSessionId, s]));
  const agents = new Map(Object.values(state.agents).map(a => [workspaceKey(a.canonicalWorkspace), a]));
  const manager = workspaceKey(managerWorkspace);
  const groups = new Map<string, WorkspaceGroup>();
  for (const raw of await list()) {
    const runtimeSessionId = string(raw.id) || string(raw.session_id);
    const workspace = string(raw.workspace_root);
    if (!runtimeSessionId || !workspace) continue;
    const owner = registered.get(runtimeSessionId);
    const key = workspaceKey(workspace);
    if (owner?.teamId || key === manager) continue;
    let group = groups.get(key);
    if (!group) {
      const agent = agents.get(key);
      const teams = agent ? Object.values(state.memberships).filter(m => m.agentId === agent.id).map(m => state.teams[m.teamId]?.name).filter((name): name is string => Boolean(name)) : [];
      group = { workspace, ...(agent ? { agentId: agent.id } : {}), name: agent?.name || workspace.split(/[\\/]/).filter(Boolean).at(-1) || workspace, teams, sessions: [] };
      groups.set(key, group);
    }
    if (group.sessions.some(s => s.runtimeSessionId === runtimeSessionId)) continue;
    const named = string(raw.title);
    group.sessions.push({ runtimeSessionId, title: (named !== "Untitled" ? named : undefined) || string(raw.first_user_message) || runtimeSessionId,
      ...(string(raw.updated_at) ? { updatedAt: string(raw.updated_at) } : {}), ...(owner ? { sessionId: owner.id } : {}) });
  }
  const latest = (group: WorkspaceGroup) => group.sessions.reduce((max, s) => (s.updatedAt || "") > max ? s.updatedAt || "" : max, "");
  for (const group of groups.values()) group.sessions.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return [...groups.values()].sort((a, b) => latest(b).localeCompare(latest(a)));
}
