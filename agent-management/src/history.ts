import { memberKey, requireValue, type Session, type State } from "./model.js";

// What a conversation runs on, as its saved history reports it.
export interface Selection { provider?: string; model?: string; reasoningEffort?: string; selectionSource?: Record<string, string>; connectionReady?: boolean }
export interface HistoryEntry extends Selection { runtimeSessionId: string; agentId: string; teamId?: string; title: string; updatedAt?: string; messageCount?: number }
export interface HistoryScope { agentId?: string; teamId?: string }
type ListWorkspace = (workspace: string) => Promise<Array<Record<string, unknown>>>;

const string = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
// "Untitled" is what older versions stored for a conversation without a first message.
const shownTitle = (raw: Record<string, unknown>) => { const title = string(raw.title); return title === "Untitled" ? undefined : title; };
const selectionOf = (raw: Record<string, unknown>): Selection => ({
  ...(string(raw.provider) ? { provider: string(raw.provider) } : {}),
  ...(string(raw.model) ? { model: string(raw.model) } : {}),
  ...(string(raw.reasoning_effort) ? { reasoningEffort: string(raw.reasoning_effort) } : {}),
  ...(raw.selection_source && typeof raw.selection_source === "object" ? { selectionSource: raw.selection_source as Record<string, string> } : {}),
  ...(typeof raw.connection_ready === "boolean" ? { connectionReady: raw.connection_ready } : {}),
});

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
      // History reports what to show: the name, otherwise the first message.
      const title = shownTitle(raw) || runtimeSessionId;
      entries.push({ runtimeSessionId, agentId, ...(owner?.teamId ? { teamId: owner.teamId } : {}), title,
        ...(string(raw.updated_at) ? { updatedAt: string(raw.updated_at) } : {}),
        ...(Number.isInteger(raw.message_count) ? { messageCount: raw.message_count as number } : {}), ...selectionOf(raw) });
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

export interface WorkspaceSession extends Selection { runtimeSessionId: string; title: string; updatedAt?: string; sessionId?: string }
export interface WorkspaceGroup { workspace: string; agentId?: string; name: string; teams: string[]; sessions: WorkspaceSession[]; total?: number }
type ListQuery = { workspace_root?: string; limit?: number; exclude_workspace_roots?: string[]; exclude_session_ids?: string[]; per_workspace_limit?: number };
type ListPage = { sessions?: Array<Record<string, unknown>>; totals?: Array<{ workspace_root?: unknown; count?: unknown }> };
type ListAll = (query: ListQuery) => Promise<ListPage>;

const workspaceKey = (value: string) => {
  const normal = value.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normal.replace(/\//g, "\\").toLowerCase() : normal;
};

const workspaceOf = (raw: Record<string, unknown>) => string(raw.workspace_root) || "";
const sessionOf = (raw: Record<string, unknown>, owner: Session | undefined): WorkspaceSession | null => {
  const runtimeSessionId = string(raw.id) || string(raw.session_id);
  if (!runtimeSessionId) return null;
  return {
    runtimeSessionId,
    title: shownTitle(raw) || runtimeSessionId,
    ...(string(raw.updated_at) ? { updatedAt: string(raw.updated_at) } : {}),
    ...(owner ? { sessionId: owner.id } : {}),
    ...selectionOf(raw),
  };
};

// Conversations outside every team, grouped by folder. One query returns the
// newest few per folder plus each folder's count, so a busy folder cannot crowd
// others out and nothing is fetched per folder; team conversations are excluded
// by id (they are known here) and the Manager's folder by path. The folder is
// named after its agent when it is registered, otherwise after its basename.
export async function independentHistory(state: State, managerWorkspace: string, list: ListAll): Promise<WorkspaceGroup[]> {
  const registered = new Map(Object.values(state.sessions).filter(s => s.runtimeSessionId).map(s => [s.runtimeSessionId, s]));
  const agents = new Map(Object.values(state.agents).map(a => [workspaceKey(a.canonicalWorkspace), a]));
  const manager = workspaceKey(managerWorkspace);
  const groups = new Map<string, WorkspaceGroup>();
  const page = await list({
    per_workspace_limit: 3,
    limit: 500,
    exclude_workspace_roots: [managerWorkspace],
    exclude_session_ids: teamSessionIds(state),
  });
  const totals = new Map((page.totals || []).map(item => [String(item.workspace_root || ""), Number(item.count) || 0]));
  // The preview cap may contain no conversations from an older folder. Its
  // total still makes that folder discoverable and opens its own bounded page.
  const ensureGroup = (workspace: string) => {
    const key = workspaceKey(workspace);
    if (!workspace || key === manager) return undefined;
    let group = groups.get(key);
    if (!group) {
      const agent = agents.get(key);
      const teams = agent ? Object.values(state.memberships).filter(m => m.agentId === agent.id).map(m => state.teams[m.teamId]?.name).filter((name): name is string => Boolean(name)) : [];
      group = { workspace: agent?.canonicalWorkspace || workspace, ...(agent ? { agentId: agent.id } : {}), name: agent?.name || workspace.split(/[\\/]/).filter(Boolean).at(-1) || workspace, teams, sessions: [], total: totals.get(workspace) };
      groups.set(key, group);
    }
    return group;
  };
  for (const workspace of totals.keys()) ensureGroup(workspace);
  for (const raw of page.sessions || []) {
    const workspace = workspaceOf(raw);
    const key = workspaceKey(workspace);
    if (!workspace || key === manager) continue;
    const owner = registered.get(string(raw.id) || string(raw.session_id) || "");
    if (owner?.teamId) continue;
    const session = sessionOf(raw, owner);
    if (!session) continue;
    const group = ensureGroup(workspace)!;
    if (group.sessions.some(s => s.runtimeSessionId === session.runtimeSessionId)) continue;
    group.sessions.push(session);
    const total = totals.get(workspace);
    if (total !== undefined) group.total = total;
  }
  const latest = (group: WorkspaceGroup) => group.sessions.reduce((max, s) => (s.updatedAt || "") > max ? s.updatedAt || "" : max, "");
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    group.total ??= group.sessions.length;
  }
  return [...groups.values()].sort((a, b) => latest(b).localeCompare(latest(a)));
}

// One folder's conversations, on demand for its page; the same exclusions as
// the overview, so both always agree.
export async function independentFolder(state: State, managerWorkspace: string, workspace: string, list: ListAll, excludeSessionIds: string[] = []): Promise<WorkspaceSession[]> {
  if (!workspace || workspaceKey(workspace) === workspaceKey(managerWorkspace)) return [];
  const registered = new Map(Object.values(state.sessions).filter(s => s.runtimeSessionId).map(s => [s.runtimeSessionId, s]));
  const page = await list({ workspace_root: workspace, limit: 100, exclude_session_ids: [...teamSessionIds(state), ...excludeSessionIds] });
  const sessions: WorkspaceSession[] = [];
  const seen = new Set<string>();
  for (const raw of page.sessions || []) {
    const owner = registered.get(string(raw.id) || string(raw.session_id) || "");
    if (owner?.teamId) continue;
    const session = sessionOf(raw, owner);
    if (!session || seen.has(session.runtimeSessionId)) continue;
    seen.add(session.runtimeSessionId);
    sessions.push(session);
  }
  return sessions;
}

const teamSessionIds = (state: State) => Object.values(state.sessions).filter(s => s.teamId && s.runtimeSessionId).map(s => s.runtimeSessionId);
