import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Archive,
  BarChart3,
  Bell,
  ChevronDown,
  ChevronRight,
  Crown,
  FolderGit2,
  History,
  Inbox,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  Network,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { ConfirmDialog } from "../overlays/ConfirmDialog.jsx";
import { ProjectSelector } from "./ProjectSelector.jsx";
import { SessionRow } from "./SessionRow.jsx";
import { buildTeamSummary } from "../../lib/agentsModel.js";
import { interactionTime } from "../../lib/sessionActivity.js";
import { sessionIdOf } from "../../methods.js";

// Flatten org tree into depth-annotated list so reporting hierarchy is visible in sidebar
function flattenOrgTree(nodes, depth = 0, out = []) {
  for (const node of nodes || []) {
    out.push({ ...node, depth });
    if (node.children?.length) {
      flattenOrgTree(node.children, depth + 1, out);
    }
  }
  return out;
}

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
  const [mode, setMode] = useState("workspaces"); // "workspaces" | "agents"
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(null); // { id, title, busy, error, isAgentSession, teamId }
  const [loadingMore, setLoadingMore] = useState(false);
  const [collapsedTeams, setCollapsedTeams] = useState({});
  const [expandedMembers, setExpandedMembers] = useState({});
  const [managerExpanded, setManagerExpanded] = useState(false);
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");

  // Automatically switch sidebar mode when user navigates to an agent surface or member/manager chat
  const surfaceKind = agents?.surface?.kind || "chat";
  const agentCtxKind = agents?.activeSessionContext?.kind || "independent";
  useEffect(() => {
    if (surfaceKind !== "chat" || agentCtxKind === "member" || agentCtxKind === "manager") {
      setMode("agents");
    }
  }, [surfaceKind, agentCtxKind]);

  // Auto-expand the active member in the sidebar when chatting with them
  const activeMemberId = agents?.activeSessionContext?.agentId || "";
  useEffect(() => {
    if (activeMemberId) {
      setExpandedMembers((prev) => (prev[activeMemberId] ? prev : { ...prev, [activeMemberId]: true }));
    }
  }, [activeMemberId]);

  const recent = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? sessions.filter((session) =>
          String(session.title || session.preview || sessionIdOf(session))
            .toLowerCase()
            .includes(needle),
        )
      : sessions;
    return [...list].sort((a, b) => interactionTime(b) - interactionTime(a));
  }, [sessions, search]);

  const teamSummaries = useMemo(() => {
    if (Array.isArray(agents?.teamSummaries) && agents.teamSummaries.length > 0) {
      return agents.teamSummaries;
    }
    if (!agents?.snapshot?.teams?.length) return [];
    return agents.snapshot.teams
      .map((t) => buildTeamSummary(agents.snapshot, t.id))
      .filter(Boolean);
  }, [agents?.teamSummaries, agents?.snapshot]);

  const managerSummary = agents?.managerSummary || {
    status: "Idle",
    tone: "idle",
    glyph: "·",
    sessionCount: 0,
    sessions: [],
  };

  const archiveCount = Array.isArray(agents?.snapshot?.archivedTeams)
    ? agents.snapshot.archivedTeams.length
    : 0;

  const totalAttention = (agents?.inboxCount || 0);
  const totalWorking = (agents?.bgCount || 0);

  async function confirmDelete() {
    if (!pending) return;
    setPending({ ...pending, busy: true, error: "" });
    try {
      if (pending.isAgentSession && agents?.onDeleteAgentSession) {
        await agents.onDeleteAgentSession(pending.id, { teamId: pending.teamId || "" });
      } else {
        await onDelete?.(pending.id);
      }
      setPending(null);
    } catch (error) {
      setPending(
        (current) =>
          current && {
            ...current,
            busy: false,
            error: error instanceof Error ? error.message : String(error || "Delete failed"),
          },
      );
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
    <aside
      ref={panelRef}
      id="sidebar-panel"
      className={`sidebar ${panelClassName}`.trim()}
      tabIndex={-1}
      style={style}
      aria-label="Workspace and Agents navigation"
      {...restPanelAttrs}
    >
      {agents && (
        <div className="sidebar-mode-switcher" role="tablist" aria-label="Navigation mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "workspaces"}
            className={`sidebar-mode-tab ${mode === "workspaces" ? "active" : ""}`}
            onClick={() => setMode("workspaces")}
          >
            <FolderGit2 size={14} aria-hidden="true" />
            <span>Workspaces</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "agents"}
            className={`sidebar-mode-tab ${mode === "agents" ? "active" : ""}`}
            onClick={() => setMode("agents")}
          >
            <Users size={14} aria-hidden="true" />
            <span>Agents & Teams</span>
            {totalAttention > 0 ? (
              <span className="sidebar-nav-badge attention" title={`${totalAttention} item(s) need attention`}>
                ! {totalAttention}
              </span>
            ) : totalWorking > 0 ? (
              <span className="sidebar-nav-badge working" title={`${totalWorking} active run(s)`}>
                ● {totalWorking}
              </span>
            ) : null}
          </button>
        </div>
      )}

      {mode === "agents" && agents ? (
        <div className="sidebar-agents panel-scroll" aria-label="Multi-agent navigation">
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

            <div className="sidebar-manager-group">
              <div
                className={`sidebar-nav-item sidebar-manager-row ${
                  agents.surface?.kind === "manager" ||
                  (agents.surface?.kind === "chat" && agents.activeSessionContext?.kind === "manager")
                    ? "active"
                    : ""
                }`}
              >
                <button
                  type="button"
                  className="sidebar-team-chevron"
                  aria-label={managerExpanded ? "Collapse Manager sessions" : "Expand Manager sessions"}
                  onClick={() => setManagerExpanded((prev) => !prev)}
                >
                  {managerExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <button
                  type="button"
                  className="sidebar-manager-main"
                  onClick={() =>
                    agents.onOpenManagerView
                      ? agents.onOpenManagerView()
                      : agents.onOpenManager?.({ resumeLatest: true })
                  }
                >
                  <Sparkles size={14} aria-hidden="true" />
                  <span>Manager</span>
                  <span className={`agent-status-dot tone-${managerSummary.tone}`} />
                  {managerSummary.sessionCount > 0 && (
                    <span className="sidebar-nav-hint">{managerSummary.sessionCount}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="icon-button xs"
                  title="New conversation with Manager"
                  aria-label="New conversation with Manager"
                  onClick={() => agents.onOpenManager?.({ forceNew: true })}
                >
                  <Plus size={12} aria-hidden="true" />
                </button>
              </div>
              {managerExpanded && (
                <div className="sidebar-member-sessions" role="group" aria-label="Manager conversations">
                  {managerSummary.sessions.length === 0 ? (
                    <button
                      type="button"
                      className="sidebar-subsession-empty"
                      onClick={() => agents.onOpenManager?.({ forceNew: true })}
                    >
                      <Plus size={11} aria-hidden="true" />
                      <span>Start conversation with Manager</span>
                    </button>
                  ) : (
                    managerSummary.sessions.map((sess) => {
                      const isCurrent =
                        agents.surface?.kind === "chat" && sess.runtimeSessionId === activeId;
                      return (
                        <div
                          key={sess.runtimeSessionId}
                          className={`sidebar-subsession-row ${isCurrent ? "active" : ""}`}
                        >
                          <button
                            type="button"
                            className="sidebar-subsession-main"
                            onClick={() =>
                              agents.onOpenManager?.({ runtimeSessionId: sess.runtimeSessionId })
                            }
                            title={`${sess.title} · ${sess.status}`}
                          >
                            <span className={`agent-status-dot tone-${sess.tone}`} />
                            <span className="sidebar-subsession-title">{sess.title}</span>
                            {sess.ageText && (
                              <span className="sidebar-subsession-age">{sess.ageText}</span>
                            )}
                          </button>
                          <button
                            type="button"
                            className="sidebar-subsession-delete"
                            title="Delete conversation"
                            aria-label={`Delete ${sess.title}`}
                            onClick={() =>
                              setPending({
                                id: sess.runtimeSessionId,
                                title: sess.title,
                                busy: false,
                                error: "",
                                isAgentSession: true,
                                teamId: "",
                              })
                            }
                          >
                            <Trash2 size={11} aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              className={`sidebar-nav-item ${agents.surface?.kind === "background" ? "active" : ""}`}
              onClick={agents.onOpenBackground}
            >
              <Activity size={15} aria-hidden="true" />
              <span>Background</span>
              {agents.bgCount > 0 && (
                <span className="sidebar-nav-badge working">{agents.bgCount}</span>
              )}
            </button>

            {archiveCount > 0 && (
              <button
                type="button"
                className={`sidebar-nav-item ${agents.surface?.kind === "archive" ? "active" : ""}`}
                onClick={agents.onOpenArchive}
              >
                <Archive size={15} aria-hidden="true" />
                <span>Archive</span>
                <span className="sidebar-nav-hint">{archiveCount}</span>
              </button>
            )}
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
                <button
                  type="submit"
                  className="agent-btn primary xs"
                  disabled={!newTeamName.trim() || agents.busy}
                >
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
                <span>Create a team or ask Manager</span>
              </button>
            ) : (
              <div className="sidebar-team-list">
                {teamSummaries.map((summary) => {
                  const { team, orgRoots, members, counts } = summary;
                  const orderedMembers = orgRoots?.length ? flattenOrgTree(orgRoots) : members;
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
                          <span className={`agent-status-dot tone-${team.tone || "idle"}`} />
                          <span className="sidebar-team-name">{team.name}</span>
                        </button>
                        <div className="sidebar-team-pills">
                          <button
                            type="button"
                            className={`sidebar-team-pill ${
                              isTeamSelected && agents.surface?.tab === "organization" ? "active" : ""
                            }`}
                            title="Team organization & members"
                            onClick={() => agents.onOpenTeam?.(team.id, "organization")}
                          >
                            <Network size={11} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={`sidebar-team-pill ${
                              isTeamSelected && agents.surface?.tab === "tasks" ? "active" : ""
                            }`}
                            title="Team tasks & deliveries"
                            onClick={() => agents.onOpenTeam?.(team.id, "tasks")}
                          >
                            <ListChecks size={11} aria-hidden="true" />
                            {counts.tasksTotal > 0 && <span>{counts.tasksTotal}</span>}
                          </button>
                        </div>
                      </div>

                      {!collapsed && orderedMembers.length > 0 && (
                        <div className="sidebar-member-list" role="group" aria-label={`${team.name} members`}>
                          {orderedMembers.map((member) => {
                            const memberSessions = Array.isArray(member.sessions) ? member.sessions : [];
                            const isMemberActive =
                              agents.surface?.kind === "chat" &&
                              agents.activeSessionContext?.kind === "member" &&
                              agents.activeSessionContext?.agentId === member.agentId;
                            const isExpanded = Boolean(expandedMembers[member.agentId]);

                            return (
                              <div
                                key={member.agentId}
                                className="sidebar-member-block"
                                style={member.depth ? { paddingLeft: `${Math.min(member.depth, 3) * 10}px` } : undefined}
                              >
                                <div className={`sidebar-member-row ${isMemberActive ? "active" : ""}`} data-member-id={member.agentId}>
                                  <button
                                    type="button"
                                    className="sidebar-team-chevron"
                                    aria-label={isExpanded ? `Collapse ${member.name} sessions` : `Expand ${member.name} sessions`}
                                    onClick={() =>
                                      setExpandedMembers((prev) => ({
                                        ...prev,
                                        [member.agentId]: !prev[member.agentId],
                                      }))
                                    }
                                  >
                                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                  </button>
                                  <button
                                    type="button"
                                    className="sidebar-member-main"
                                    onClick={() => {
                                      setExpandedMembers((prev) => ({ ...prev, [member.agentId]: true }));
                                      agents.onOpenMemberChat?.({
                                        teamId: team.id,
                                        agentId: member.agentId,
                                        runtimeSessionId: member.latestRuntimeSessionId,
                                        resumeLatest: true,
                                      });
                                    }}
                                  >
                                    <span className={`agent-status-dot tone-${member.tone}`} />
                                    <span className="sidebar-member-name">{member.name}</span>
                                    {member.isLeader && (
                                      <Crown size={11} className="sidebar-leader-icon" aria-hidden="true" />
                                    )}
                                    <span className="sidebar-member-role">{member.position}</span>
                                  </button>
                                  <div className="sidebar-member-actions">
                                    {memberSessions.length > 0 && (
                                      <button
                                        type="button"
                                        className="sidebar-member-session-count"
                                        title={`${memberSessions.length} conversation(s)`}
                                        onClick={() =>
                                          setExpandedMembers((prev) => ({
                                            ...prev,
                                            [member.agentId]: !prev[member.agentId],
                                          }))
                                        }
                                      >
                                        <MessageSquare size={10} aria-hidden="true" />
                                        <span>{memberSessions.length}</span>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className="icon-button xs"
                                      title={`New conversation with ${member.name}`}
                                      aria-label={`New conversation with ${member.name}`}
                                      onClick={() => {
                                        setExpandedMembers((prev) => ({ ...prev, [member.agentId]: true }));
                                        agents.onOpenMemberChat?.({
                                          teamId: team.id,
                                          agentId: member.agentId,
                                          forceNew: true,
                                        });
                                      }}
                                    >
                                      <Plus size={11} aria-hidden="true" />
                                    </button>
                                  </div>
                                </div>

                                {isExpanded && (
                                  <div
                                    className="sidebar-member-sessions"
                                    role="group"
                                    aria-label={`${member.name} conversations`}
                                  >
                                    {memberSessions.length === 0 ? (
                                      <button
                                        type="button"
                                        className="sidebar-subsession-empty"
                                        onClick={() =>
                                          agents.onOpenMemberChat?.({
                                            teamId: team.id,
                                            agentId: member.agentId,
                                            forceNew: true,
                                          })
                                        }
                                      >
                                        <Plus size={11} aria-hidden="true" />
                                        <span>New conversation</span>
                                      </button>
                                    ) : (
                                      memberSessions.map((sess) => {
                                        const isCurrentSession =
                                          agents.surface?.kind === "chat" &&
                                          sess.runtimeSessionId === activeId;
                                        return (
                                          <div
                                            key={sess.runtimeSessionId}
                                            className={`sidebar-subsession-row ${isCurrentSession ? "active" : ""}`}
                                          >
                                            <button
                                              type="button"
                                              className="sidebar-subsession-main"
                                              onClick={() =>
                                                agents.onOpenMemberChat?.({
                                                  teamId: team.id,
                                                  agentId: member.agentId,
                                                  runtimeSessionId: sess.runtimeSessionId,
                                                })
                                              }
                                              title={`${sess.title} · ${sess.status}`}
                                            >
                                              <span className={`agent-status-dot tone-${sess.tone}`} />
                                              <span className="sidebar-subsession-title">{sess.title}</span>
                                              {sess.origin === "task" && (
                                                <span className="sidebar-subsession-tag">Task</span>
                                              )}
                                              {sess.ageText && (
                                                <span className="sidebar-subsession-age">{sess.ageText}</span>
                                              )}
                                            </button>
                                            <button
                                              type="button"
                                              className="sidebar-subsession-delete"
                                              title="Delete conversation"
                                              aria-label={`Delete ${sess.title}`}
                                              onClick={() =>
                                                setPending({
                                                  id: sess.runtimeSessionId,
                                                  title: sess.title,
                                                  busy: false,
                                                  error: "",
                                                  isAgentSession: true,
                                                  teamId: team.id,
                                                })
                                              }
                                            >
                                              <Trash2 size={11} aria-hidden="true" />
                                            </button>
                                          </div>
                                        );
                                      })
                                    )}
                                  </div>
                                )}
                              </div>
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
      ) : (
        <>
          <div className="sidebar-head">
            <span className="sidebar-section-label">Workspace folder</span>
            <ProjectSelector {...project} />
            <button
              type="button"
              className="sidebar-new"
              title={project?.workspace ? `New session in ${project.workspace}` : undefined}
              onClick={onNew}
              disabled={!project?.workspace}
            >
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
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) {
                  event.stopPropagation();
                  setSearch("");
                }
              }}
              placeholder="Search sessions"
              aria-label="Search sessions"
            />
            {search && (
              <button
                type="button"
                className="sidebar-search-clear"
                aria-label="Clear search"
                onClick={() => setSearch("")}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          <nav className="session-list panel-scroll" aria-label="Sessions">
            <h2 className="sidebar-section-label">Recent sessions</h2>
            {recent.length === 0 ? (
              <div className="sidebar-empty">
                <History size={15} aria-hidden="true" />{" "}
                {search ? "No matching sessions" : "No sessions yet"}
              </div>
            ) : (
              recent.map((session) => {
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
                    onRequestDelete={(targetId, title) =>
                      setPending({ id: targetId, title, busy: false, error: "", isAgentSession: false })
                    }
                  />
                );
              })
            )}
            {hasMore && !search && (
              <button
                type="button"
                className="sidebar-load-more"
                disabled={loadingMore}
                aria-busy={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  try {
                    await onLoadMore?.();
                  } finally {
                    setLoadingMore(false);
                  }
                }}
              >
                {loadingMore && (
                  <LoaderCircle size={12} className="sidebar-load-more-spinner spin" aria-hidden="true" />
                )}
                <span>{loadingMore ? "Loading…" : "Load more"}</span>
              </button>
            )}
          </nav>
        </>
      )}

      <div className="sidebar-footer">
        {onOpenUsage && (
          <button type="button" className="sidebar-footer-button" onClick={onOpenUsage}>
            <BarChart3 size={15} aria-hidden="true" />
            <span>Usage</span>
          </button>
        )}
        {notificationPermission === "default" && onEnableNotifications && (
          <button
            type="button"
            className="sidebar-footer-button sidebar-notifications"
            aria-label="Enable desktop notifications"
            title="Enable desktop notifications while this page is hidden"
            onClick={onEnableNotifications}
          >
            <Bell size={15} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="sidebar-footer-button"
          aria-label="Open settings"
          onClick={onOpenSettings}
        >
          <Settings size={15} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
      <ConfirmDialog
        open={Boolean(pending)}
        title="Delete session?"
        message={
          pending
            ? `"${pending.title}" and its history will be removed from the Rind computer.`
            : ""
        }
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
