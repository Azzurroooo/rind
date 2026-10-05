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
