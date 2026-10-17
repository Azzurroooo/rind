import { useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  ChevronDown,
  ChevronRight,
  Crown,
  History,
  Inbox,
  Kanban,
  LoaderCircle,
  Network,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Users,
  X,
} from "lucide-react";
import { ConfirmDialog } from "../overlays/ConfirmDialog.jsx";
import { ProjectSelector } from "./ProjectSelector.jsx";
import { SessionRow } from "./SessionRow.jsx";
import { buildTeamSummary } from "../../lib/agentsModel.js";
import { interactionTime } from "../../lib/sessionActivity.js";
import { sessionIdOf } from "../../methods.js";

// Sidebar (spec section 3), after Jan's left panel, LobeHub's topic list, and
// Paperclip/Orca's native multi-agent workspace navigation:
// Inbox/Manager/Background, Teams & member tree, project selector, New session,
// title search, recent 32px session rows, "Load more", and footer.
export function Sidebar({
  sessions,
  activeId,
  unreadIds,
  runningIds,
  hasMore,
  project,
  agents,
  canFork,
  canExport,
  notificationPermission,
  onNew,
  onSelect,
  onFork,
  onExport,
  onDelete,
  onLoadMore,
  onEnableNotifications,
  onOpenSettings,
  onOpenUsage,
  panelAttrs = {},
  panelRef,
  style,
}) {
  const { className: panelClassName = "", ...restPanelAttrs } = panelAttrs;
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(null); // { id, title, busy, error }
  const [loadingMore, setLoadingMore] = useState(false);
  const [collapsedTeams, setCollapsedTeams] = useState({});
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");

  const recent = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? sessions.filter((session) => String(session.title || session.preview || sessionIdOf(session)).toLowerCase().includes(needle))
      : sessions;
    return [...list].sort((a, b) => interactionTime(b) - interactionTime(a));
  }, [sessions, search]);

  const teamSummaries = useMemo(() => {
    if (!agents?.snapshot?.teams?.length) return [];
    return agents.snapshot.teams
      .map((t) => buildTeamSummary(agents.snapshot, t.id))
      .filter(Boolean);
  }, [agents?.snapshot]);

  async function confirmDelete() {
    if (!pending) return;
    setPending({ ...pending, busy: true, error: "" });
    try {
      await onDelete?.(pending.id);
      setPending(null);
    } catch (error) {
      setPending((current) => current && { ...current, busy: false, error: error instanceof Error ? error.message : String(error || "Delete failed") });
    }
  }

  async function handleCreateTeam(event) {
    event.preventDefault();
    const name = newTeamName.trim();
    if (!name || !agents?.onCreateTeam) return;
    await agents.onCreateTeam(name);
    setNewTeamName("");
    setNewTeamOpen(false);
  }

  return (
    <aside ref={panelRef} id="sidebar-panel" className={`sidebar ${panelClassName}`.trim()} tabIndex={-1} style={style} aria-label="Sessions sidebar" {...restPanelAttrs}>
      {agents && (
        <div className="sidebar-agents" aria-label="Multi-agent navigation">
          <div className="sidebar-nav-rail">
            <button
              type="button"
              className={`sidebar-nav-item ${agents.surface?.kind === "inbox" ? "active" : ""}`}
              onClick={agents.onOpenInbox}
            >
              <Inbox size={15} aria-hidden="true" />
              <span>Inbox</span>
              {agents.inboxCount > 0 && (
                <span className="sidebar-nav-badge attention">{agents.inboxCount}</span>
              )}
            </button>
            <button
              type="button"
              className={`sidebar-nav-item ${
                agents.surface?.kind === "chat" && agents.activeSessionContext?.kind === "manager" ? "active" : ""
              }`}
              onClick={agents.onOpenManager}
            >
              <Sparkles size={15} aria-hidden="true" />
              <span>Manager</span>
              <span className="sidebar-nav-hint">Coordinator</span>
            </button>
            <button
              type="button"
              className={`sidebar-nav-item ${agents.surface?.kind === "background" ? "active" : ""}`}
              onClick={agents.onOpenBackground}
            >
              <Activity size={15} aria-hidden="true" />
              <span>Background</span>
              {agents.bgCount > 0 && <span className="sidebar-nav-badge working">{agents.bgCount}</span>}
            </button>
          </div>

          <div className="sidebar-teams-section">
            <div className="sidebar-section-head">
              <span className="sidebar-section-label">Teams</span>
              <button
                type="button"
                className="icon-button small"
                aria-label="New team"
                title="Create a new agent team"
                onClick={() => setNewTeamOpen((prev) => !prev)}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            </div>

            {newTeamOpen && (
              <form className="sidebar-new-team-form" onSubmit={handleCreateTeam}>
                <input
                  type="text"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="Team name (e.g. core-ui)"
                  aria-label="New team name"
                  autoFocus
                />
                <button type="submit" className="agent-btn primary xs" disabled={!newTeamName.trim() || agents.busy}>
                  Create
                </button>
              </form>
            )}

            {teamSummaries.length === 0 ? (
              <button
                type="button"
                className="sidebar-teams-empty"
                onClick={() => setNewTeamOpen(true)}
              >
                <Users size={13} aria-hidden="true" />
                <span>Create or ask Manager for a team</span>
              </button>
            ) : (
              <div className="sidebar-team-list">
                {teamSummaries.map((summary) => {
                  const { team, members, counts } = summary;
                  const collapsed = Boolean(collapsedTeams[team.id]);
                  const isTeamSelected =
                    agents.surface?.kind === "team" && agents.surface?.teamId === team.id;
                  return (
                    <div key={team.id} className="sidebar-team-group" data-team-id={team.id}>
                      <div className={`sidebar-team-row ${isTeamSelected ? "active" : ""}`}>
                        <button
                          type="button"
                          className="sidebar-team-chevron"
                          aria-label={collapsed ? `Expand ${team.name}` : `Collapse ${team.name}`}
                          onClick={() =>
                            setCollapsedTeams((prev) => ({ ...prev, [team.id]: !prev[team.id] }))
                          }
                        >
                          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        </button>
                        <button
                          type="button"
                          className="sidebar-team-main"
                          onClick={() => agents.onOpenTeam?.(team.id, "organization")}
                        >
                          <span className="sidebar-team-name">{team.name}</span>
                          {counts.working > 0 && <span className="agent-status-dot tone-working" title={`${counts.working} working`} />}
                          {counts.attention > 0 && <span className="agent-status-dot tone-attention" title={`${counts.attention} need input`} />}
                        </button>
                        <div className="sidebar-team-pills">
                          <button
                            type="button"
                            className={`sidebar-team-pill ${
                              isTeamSelected && agents.surface?.tab === "organization" ? "active" : ""
                            }`}
                            title="Team organization chart"
                            onClick={() => agents.onOpenTeam?.(team.id, "organization")}
                          >
                            <Network size={11} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={`sidebar-team-pill ${
                              isTeamSelected && agents.surface?.tab === "tasks" ? "active" : ""
                            }`}
                            title="Team tasks board"
                            onClick={() => agents.onOpenTeam?.(team.id, "tasks")}
                          >
                            <Kanban size={11} aria-hidden="true" />
                            {counts.tasksTotal > 0 && <span>{counts.tasksTotal}</span>}
                          </button>
                        </div>
                      </div>
                      {!collapsed && members.length > 0 && (
                        <div className="sidebar-member-list" role="group" aria-label={`${team.name} members`}>
                          {members.map((member) => {
                            const isMemberChat =
                              agents.surface?.kind === "chat" &&
                              agents.activeSessionContext?.kind === "member" &&
                              agents.activeSessionContext?.agentId === member.agentId;
                            return (
                              <button
                                key={member.agentId}
                                type="button"
                                className={`sidebar-member-row ${isMemberChat ? "active" : ""}`}
                                data-member-id={member.agentId}
                                onClick={() =>
                                  agents.onOpenMemberChat?.({
                                    teamId: team.id,
                                    agentId: member.agentId,
                                    runtimeSessionId: member.latestRuntimeSessionId,
                                  })
                                }
                              >
                                <span className={`agent-status-dot tone-${member.tone}`} />
                                <span className="sidebar-member-name">{member.name}</span>
                                {member.isLeader && (
                                  <Crown size={11} className="sidebar-leader-icon" aria-hidden="true" />
                                )}
                                <span className="sidebar-member-role">{member.position}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="sidebar-head">
        <span className="sidebar-section-label">Projects</span>
        <ProjectSelector {...project} />
        <button type="button" className="sidebar-new" title={project?.workspace ? `New session in ${project.workspace}` : undefined} onClick={onNew} disabled={!project?.workspace}>
          <SquarePen size={16} aria-hidden="true" />
          <span>New session</span>
        </button>
      </div>
      <div className="sidebar-search">
        <Search size={14} aria-hidden="true" />
        <input
          id="sidebar-search-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && search) { event.stopPropagation(); setSearch(""); } }}
          placeholder="Search sessions"
          aria-label="Search sessions"
        />
        {search && (
          <button type="button" className="sidebar-search-clear" aria-label="Clear search" onClick={() => setSearch("")}>
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <nav className="session-list panel-scroll" aria-label="Sessions">
        <h2 className="sidebar-section-label">Recent sessions</h2>
        {recent.length === 0 ? (
          <div className="sidebar-empty"><History size={15} aria-hidden="true" />{" "}{search ? "No matching sessions" : "No sessions yet"}</div>
        ) : recent.map((session) => {
          const id = sessionIdOf(session);
          const current = id === activeId;
          return (
            <SessionRow
              key={id}
              session={session}
              id={id}
              current={current}
              unread={!current && Boolean(unreadIds?.has?.(id))}
              running={Boolean(runningIds?.has?.(id))}
              canFork={canFork}
              canExport={canExport}
              onSelect={onSelect}
              onFork={onFork}
              onExport={onExport}
              onRequestDelete={(targetId, title) => setPending({ id: targetId, title, busy: false, error: "" })}
            />
          );
        })}
        {hasMore && !search && (
          <button type="button" className="sidebar-load-more" disabled={loadingMore} aria-busy={loadingMore} onClick={async () => {
            setLoadingMore(true);
            try { await onLoadMore?.(); } finally { setLoadingMore(false); }
          }}>
            {loadingMore && <LoaderCircle size={12} className="sidebar-load-more-spinner spin" aria-hidden="true" />}
            <span>{loadingMore ? "Loading…" : "Load more"}</span>
          </button>
        )}
      </nav>
      <div className="sidebar-footer">
        {onOpenUsage && <button type="button" className="sidebar-footer-button" onClick={onOpenUsage}><BarChart3 size={15} aria-hidden="true" /><span>Usage</span></button>}
        {notificationPermission === "default" && onEnableNotifications && (
          <button type="button" className="sidebar-footer-button sidebar-notifications" aria-label="Enable desktop notifications" title="Enable desktop notifications while this page is hidden" onClick={onEnableNotifications}>
            <Bell size={15} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="sidebar-footer-button" aria-label="Open settings" onClick={onOpenSettings}>
          <Settings size={15} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
      <ConfirmDialog
        open={Boolean(pending)}
        title="Delete session?"
        message={pending ? `"${pending.title}" and its history will be removed from the Rind computer.` : ""}
        confirmLabel={pending?.busy ? "Deleting…" : "Delete"}
        danger
        busy={pending?.busy}
        error={pending?.error}
        onConfirm={confirmDelete}
        onCancel={() => setPending(null)}
      />
    </aside>
  );
}
