import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Archive,
  BarChart3,
  Bell,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  History,
  Inbox,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
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
import { Menu } from "../overlays/Menu.jsx";
import { ProjectSelector } from "./ProjectSelector.jsx";
import { SessionRow } from "./SessionRow.jsx";
import { buildTeamSummary } from "../../lib/agentsModel.js";
import { interactionTime } from "../../lib/sessionActivity.js";
import { sessionIdOf } from "../../methods.js";

const DEFAULT_SIDEBAR_SESSIONS_LIMIT = 5;

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
  const [sessionLimits, setSessionLimits] = useState({});
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");

  function bumpSessionLimit(key) {
    setSessionLimits((prev) => ({
      ...prev,
      [key]: (prev[key] || DEFAULT_SIDEBAR_SESSIONS_LIMIT) + DEFAULT_SIDEBAR_SESSIONS_LIMIT,
    }));
  }

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

  const totalAttention = agents?.inboxCount || 0;
  const totalWorking = agents?.bgCount || 0;

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

  function handleAgentTopNewSession() {
    if (!agents) return;
    if (agents.activeSessionContext?.kind === "member") {
      const { teamId, agentId } = agents.activeSessionContext;
      setExpandedMembers((prev) => ({ ...prev, [agentId]: true }));
      agents.onOpenMemberChat?.({ teamId, agentId, forceNew: true });
      return;
    }
    if (agents.surface?.kind === "team" && agents.surface.teamId) {
      const summary = teamSummaries.find((s) => s.team.id === agents.surface.teamId);
      const targetAgentId = summary?.team?.leaderAgentId || summary?.members?.[0]?.agentId || "";
      if (targetAgentId) {
        setExpandedMembers((prev) => ({ ...prev, [targetAgentId]: true }));
        agents.onOpenMemberChat?.({
          teamId: agents.surface.teamId,
          agentId: targetAgentId,
          forceNew: true,
        });
        return;
      }
    }
    setManagerExpanded(true);
    agents.onOpenManager?.({ forceNew: true });
  }

  const managerLimit = sessionLimits.manager || DEFAULT_SIDEBAR_SESSIONS_LIMIT;
  const visibleManagerSessions = managerSummary.sessions.slice(0, managerLimit);
  const moreManagerSessions = Math.max(0, managerSummary.sessions.length - visibleManagerSessions.length);

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
            <Users size={13} aria-hidden="true" />
            <span>Agents & Teams</span>
            {totalAttention > 0 ? (
              <span className="sidebar-nav-badge attention" title={`${totalAttention} item(s) need attention`}>
                !{totalAttention}
              </span>
            ) : totalWorking > 0 ? (
              <span className="sidebar-nav-badge working" title={`${totalWorking} active run(s)`}>
                ●{totalWorking}
              </span>
            ) : null}
          </button>
        </div>
      )}

      {mode === "agents" && agents ? (
        <>
          <div className="sidebar-head">
            <button
              type="button"
              className="sidebar-new"
              title="Start a new agent session"
              onClick={handleAgentTopNewSession}
            >
              <SquarePen size={16} aria-hidden="true" />
              <span>New session</span>
            </button>
          </div>
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

              <div className="sidebar-manager-group">
                <div
                  className={`sidebar-team-row ${
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
                    className="sidebar-team-main"
                    aria-expanded={managerExpanded}
                    onClick={() => {
                      const isShowingManager = agents.surface?.kind === "manager";
                      if (!managerExpanded) {
                        setManagerExpanded(true);
                        agents.onOpenManagerView?.();
                      } else if (!isShowingManager) {
                        agents.onOpenManagerView?.();
                      } else {
                        setManagerExpanded(false);
                      }
                    }}
                  >
                    <Sparkles size={13} aria-hidden="true" />
                    <span className="sidebar-team-name">Manager</span>
                    {managerSummary.tone !== "idle" && (
                      <span className={`agent-status-dot tone-${managerSummary.tone}`} />
                    )}
                  </button>
                  <Menu
                    label="Manager actions"
                    items={[
                      {
                        id: "mgr-new",
                        label: "New session",
                        icon: <Plus size={14} />,
                        onSelect: () => {
                          setManagerExpanded(true);
                          agents.onOpenManager?.({ forceNew: true });
                        },
                      },
                      ...(agents.onOpenManagerView
                        ? [
                            {
                              id: "mgr-panel",
                              label: "Open Manager panel",
                              icon: <Sparkles size={14} />,
                              onSelect: () => agents.onOpenManagerView?.(),
                            },
                          ]
                        : []),
                    ]}
                    trigger={(props) => (
                      <button
                        type="button"
                        className="session-more"
                        aria-label="Manager actions"
                        {...props}
                      >
                        <MoreHorizontal size={15} aria-hidden="true" />
                      </button>
                    )}
                  />
                </div>
                <div
                  className={`sidebar-collapse-wrap ${managerExpanded ? "is-open" : ""}`}
                  aria-hidden={!managerExpanded}
                   inert={!managerExpanded ? "" : undefined}
                >
                  <div className="sidebar-collapse-inner">
                    <div className="sidebar-member-sessions" role="group" aria-label="Manager conversations">
                      {visibleManagerSessions.map((sess) => {
                        const isCurrent =
                          agents.surface?.kind === "chat" && sess.runtimeSessionId === activeId;
                        return (
                          <SessionRow
                            key={sess.runtimeSessionId}
                            session={{
                              title: sess.title,
                              updated_at: sess.updatedAt,
                            }}
                            id={sess.runtimeSessionId}
                            current={isCurrent}
                            running={
                              sess.tone === "working" ||
                              Boolean(runningIds?.has?.(sess.runtimeSessionId))
                            }
                            unread={
                              !isCurrent &&
                              (sess.tone === "attention" ||
                                Boolean(unreadIds?.has?.(sess.runtimeSessionId)))
                            }
                            canFork={canFork}
                            canExport={canExport}
                            onSelect={() =>
                              agents.onOpenManager?.({ runtimeSessionId: sess.runtimeSessionId })
                            }
                            onFork={onFork}
                            onExport={onExport}
                            onRequestDelete={(targetId, title) =>
                              setPending({
                                id: targetId,
                                title,
                                busy: false,
                                error: "",
                                isAgentSession: true,
                                teamId: "",
                              })
                            }
                          />
                        );
                      })}
                      {moreManagerSessions > 0 && (
                        <button
                          type="button"
                          className="sidebar-load-more"
                          onClick={() => bumpSessionLimit("manager")}
                        >
                          <span>View more sessions</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="sidebar-subsession-empty"
                        onClick={() => agents.onOpenManager?.({ forceNew: true })}
                      >
                        <Plus size={12} aria-hidden="true" />
                        <span>New session</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

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

                    const teamMenuItems = [
                      {
                        id: "team-org",
                        label: "Organization",
                        icon: <Network size={14} />,
                        onSelect: () => {
                          setCollapsedTeams((prev) => ({ ...prev, [team.id]: false }));
                          agents.onOpenTeam?.(team.id, "organization");
                        },
                      },
                      {
                        id: "team-tasks",
                        label: counts.tasksTotal > 0 ? `Tasks (${counts.tasksTotal})` : "Tasks",
                        icon: <ListChecks size={14} />,
                        onSelect: () => {
                          setCollapsedTeams((prev) => ({ ...prev, [team.id]: false }));
                          agents.onOpenTeam?.(team.id, "tasks");
                        },
                      },
                      ...(team.leaderAgentId
                        ? [
                            { separator: true },
                            {
                              id: "team-lead-chat",
                              label: "New session with leader",
                              icon: <Plus size={14} />,
                              onSelect: () => {
                                setCollapsedTeams((prev) => ({ ...prev, [team.id]: false }));
                                setExpandedMembers((prev) => ({
                                  ...prev,
                                  [team.leaderAgentId]: true,
                                }));
                                agents.onOpenMemberChat?.({
                                  teamId: team.id,
                                  agentId: team.leaderAgentId,
                                  forceNew: true,
                                });
                              },
                            },
                          ]
                        : []),
                    ];

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
                            aria-expanded={!collapsed}
                            onClick={() => {
                              if (collapsed) {
                                setCollapsedTeams((prev) => ({ ...prev, [team.id]: false }));
                                agents.onOpenTeam?.(team.id, "organization");
                              } else if (!isTeamSelected) {
                                agents.onOpenTeam?.(team.id, "organization");
                              } else {
                                setCollapsedTeams((prev) => ({ ...prev, [team.id]: true }));
                              }
                            }}
                          >
                            <span className="sidebar-team-title-col">
                              <span className="sidebar-team-title-line">
                                <span className={`agent-status-dot tone-${team.tone || "idle"}`} />
                                <span className="sidebar-team-name">{team.name}</span>
                              </span>
                              <span
                                className={`sidebar-team-meta-wrap ${!collapsed ? "is-open" : ""}`}
                                aria-hidden={collapsed}
                              >
                                <span className="sidebar-team-meta">
                                  {counts.members} {counts.members === 1 ? "member" : "members"}
                                </span>
                              </span>
                            </span>
                          </button>
                          <Menu
                            label={`Actions for ${team.name}`}
                            items={teamMenuItems}
                            trigger={(props) => (
                              <button
                                type="button"
                                className="session-more"
                                aria-label={`Actions for ${team.name}`}
                                {...props}
                              >
                                <MoreHorizontal size={15} aria-hidden="true" />
                              </button>
                            )}
                          />
                        </div>

                        {orderedMembers.length > 0 && (
                          <div
                            className={`sidebar-collapse-wrap ${!collapsed ? "is-open" : ""}`}
                            aria-hidden={collapsed}
                            inert={collapsed ? "" : undefined}
                          >
                            <div className="sidebar-collapse-inner">
                              <div className="sidebar-member-list" role="group" aria-label={`${team.name} members`}>
                                {orderedMembers.map((member) => {
                                  const memberSessions = Array.isArray(member.sessions) ? member.sessions : [];
                                  const isMemberActive =
                                    agents.surface?.kind === "chat" &&
                                    agents.activeSessionContext?.kind === "member" &&
                                    agents.activeSessionContext?.agentId === member.agentId;
                                  const isExpanded = Boolean(expandedMembers[member.agentId]);
                                  const memberLimitKey = `${team.id}:${member.agentId}`;
                                  const memberLimit =
                                    sessionLimits[memberLimitKey] || DEFAULT_SIDEBAR_SESSIONS_LIMIT;
                                  const visibleMemberSessions = memberSessions.slice(0, memberLimit);
                                  const moreMemberSessions = Math.max(
                                    0,
                                    memberSessions.length - visibleMemberSessions.length,
                                  );

                                  const memberMenuItems = [
                                    {
                                      id: "member-new",
                                      label: "New session",
                                      icon: <Plus size={14} />,
                                      onSelect: () => {
                                        setExpandedMembers((prev) => ({
                                          ...prev,
                                          [member.agentId]: true,
                                        }));
                                        agents.onOpenMemberChat?.({
                                          teamId: team.id,
                                          agentId: member.agentId,
                                          forceNew: true,
                                        });
                                      },
                                    },
                                    {
                                      id: "member-org",
                                      label: "View in Organization",
                                      icon: <Network size={14} />,
                                      onSelect: () => agents.onOpenTeam?.(team.id, "organization"),
                                    },
                                    {
                                      id: "member-tasks",
                                      label: "View team tasks",
                                      icon: <ListChecks size={14} />,
                                      onSelect: () => agents.onOpenTeam?.(team.id, "tasks"),
                                    },
                                  ];

                                  return (
                                    <div
                                      key={member.agentId}
                                      className="sidebar-member-block"
                                      style={
                                        member.depth
                                          ? { paddingLeft: `${Math.min(member.depth, 3) * 10}px` }
                                          : undefined
                                      }
                                    >
                                      <div
                                        className={`sidebar-member-row ${isMemberActive ? "active" : ""}`}
                                        data-member-id={member.agentId}
                                      >
                                        <button
                                          type="button"
                                          className="sidebar-team-chevron"
                                          aria-label={
                                            isExpanded
                                              ? `Collapse ${member.name} sessions`
                                              : `Expand ${member.name} sessions`
                                          }
                                          onClick={() =>
                                            setExpandedMembers((prev) => ({
                                              ...prev,
                                              [member.agentId]: !prev[member.agentId],
                                            }))
                                          }
                                        >
                                          {isExpanded ? (
                                            <ChevronDown size={12} />
                                          ) : (
                                            <ChevronRight size={12} />
                                          )}
                                        </button>
                                        <button
                                          type="button"
                                          className="sidebar-member-main"
                                          aria-expanded={isExpanded}
                                          title={member.position ? `${member.name} · ${member.position}` : member.name}
                                          onClick={() =>
                                            setExpandedMembers((prev) => ({
                                              ...prev,
                                              [member.agentId]: !prev[member.agentId],
                                            }))
                                          }
                                        >
                                          <span className={`agent-status-dot tone-${member.tone}`} />
                                          <span className="sidebar-member-name">{member.name}</span>
                                          {member.isLeader ? (
                                            <span className="sidebar-leader-tag">Lead</span>
                                          ) : (
                                            <span className="sidebar-member-role">{member.position}</span>
                                          )}
                                        </button>
                                        <Menu
                                          label={`Actions for ${member.name}`}
                                          items={memberMenuItems}
                                          trigger={(props) => (
                                            <button
                                              type="button"
                                              className="session-more"
                                              aria-label={`Actions for ${member.name}`}
                                              {...props}
                                            >
                                              <MoreHorizontal size={15} aria-hidden="true" />
                                            </button>
                                          )}
                                        />
                                      </div>

                                      <div
                                        className={`sidebar-collapse-wrap ${isExpanded ? "is-open" : ""}`}
                                        aria-hidden={!isExpanded}
                                        inert={!isExpanded ? "" : undefined}
                                      >
                                        <div className="sidebar-collapse-inner">
                                          <div
                                            className="sidebar-member-sessions"
                                            role="group"
                                            aria-label={`${member.name} conversations`}
                                          >
                                            {visibleMemberSessions.map((sess) => {
                                              const isCurrentSession =
                                                agents.surface?.kind === "chat" &&
                                                sess.runtimeSessionId === activeId;
                                              return (
                                                <SessionRow
                                                  key={sess.runtimeSessionId}
                                                  session={{
                                                    title: sess.title,
                                                    updated_at: sess.updatedAt,
                                                  }}
                                                  id={sess.runtimeSessionId}
                                                  current={isCurrentSession}
                                                  running={
                                                    sess.tone === "working" ||
                                                    Boolean(runningIds?.has?.(sess.runtimeSessionId))
                                                  }
                                                  unread={
                                                    !isCurrentSession &&
                                                    (sess.tone === "attention" ||
                                                      Boolean(unreadIds?.has?.(sess.runtimeSessionId)))
                                                  }
                                                  canFork={canFork}
                                                  canExport={canExport}
                                                  onSelect={() =>
                                                    agents.onOpenMemberChat?.({
                                                      teamId: team.id,
                                                      agentId: member.agentId,
                                                      runtimeSessionId: sess.runtimeSessionId,
                                                    })
                                                  }
                                                  onFork={onFork}
                                                  onExport={onExport}
                                                  onRequestDelete={(targetId, title) =>
                                                    setPending({
                                                      id: targetId,
                                                      title,
                                                      busy: false,
                                                      error: "",
                                                      isAgentSession: true,
                                                      teamId: team.id,
                                                    })
                                                  }
                                                />
                                              );
                                            })}
                                            {moreMemberSessions > 0 && (
                                              <button
                                                type="button"
                                                className="sidebar-load-more"
                                                onClick={() => bumpSessionLimit(memberLimitKey)}
                                              >
                                                <span>View more sessions</span>
                                              </button>
                                            )}
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
                                              <Plus size={12} aria-hidden="true" />
                                              <span>New session</span>
                                            </button>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
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
