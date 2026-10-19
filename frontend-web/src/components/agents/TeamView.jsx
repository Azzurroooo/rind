import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Crown,
  FileText,
  FolderGit2,
  GitBranch,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Network,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  UserPlus,
} from "lucide-react";
import { TASK_SECTION_DEFS } from "../../lib/agentsModel.js";
import { Menu } from "../overlays/Menu.jsx";
import { SettingsSelect } from "../settings/SettingsDialog.jsx";
import { TaskReportDrawer } from "./TaskReportDrawer.jsx";

function OrgMemberNode({
  node,
  allMembers,
  depth = 0,
  busy,
  onOpenChat,
  onRenameSession,
  onDeleteSession,
  onQuickAssign,
  onQuickAddReport,
  onSelectTask,
  onSetSupervisor,
  onUpdateMember,
  onRemoveMember,
  onGetMemberModel,
  onSetMemberModel,
  onClearMemberModel,
}) {
  const [editing, setEditing] = useState(false);
  const [position, setPosition] = useState(node.position || "");
  const [responsibility, setResponsibility] = useState(node.responsibility || "");
  const [reportsTo, setReportsTo] = useState(node.reportsToAgentId || "");

  const [modelOpen, setModelOpen] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelInput, setModelInput] = useState("");
  const [providerInput, setProviderInput] = useState("");
  const [effortInput, setEffortInput] = useState("");
  const [modelSource, setModelSource] = useState("");

  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const [sessionLimit, setSessionLimit] = useState(5);
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");

  const memberSessions = Array.isArray(node.sessions) ? node.sessions : [];
  const visibleSessions = memberSessions.slice(0, sessionLimit);
  const moreSessionsCount = Math.max(0, memberSessions.length - visibleSessions.length);

  async function saveEdits(event) {
    event.preventDefault();
    await onUpdateMember?.({
      teamId: node.teamId,
      agentId: node.agentId,
      position: position.trim(),
      responsibility: responsibility.trim(),
    });
    if (reportsTo !== (node.reportsToAgentId || "")) {
      await onSetSupervisor?.({
        teamId: node.teamId,
        agentId: node.agentId,
        reportsToAgentId: reportsTo || undefined,
      });
    }
    setEditing(false);
  }

  async function toggleModelConfig() {
    if (modelOpen) {
      setModelOpen(false);
      return;
    }
    setModelOpen(true);
    if (!onGetMemberModel) return;
    setModelLoading(true);
    try {
      const info = await onGetMemberModel({ teamId: node.teamId, agentId: node.agentId });
      setModelInput(String(info?.saved?.model || info?.effective?.model || ""));
      setProviderInput(String(info?.saved?.provider || info?.effective?.provider || ""));
      setEffortInput(String(info?.saved?.reasoningEffort || info?.effective?.reasoningEffort || ""));
      setModelSource(String(info?.source?.model || "default"));
    } catch {
      // Ignore model fetch error
    } finally {
      setModelLoading(false);
    }
  }

  async function saveModelConfig(event) {
    event.preventDefault();
    if (!onSetMemberModel) return;
    if (!modelInput.trim() && onClearMemberModel) {
      await onClearMemberModel({ teamId: node.teamId, agentId: node.agentId, part: "model" });
    } else {
      await onSetMemberModel({
        teamId: node.teamId,
        agentId: node.agentId,
        ...(providerInput.trim() ? { provider: providerInput.trim() } : {}),
        ...(modelInput.trim() ? { model: modelInput.trim() } : {}),
        ...(effortInput.trim() ? { reasoningEffort: effortInput.trim() } : {}),
      });
    }
    setModelOpen(false);
  }

  const memberMenuItems = [
    {
      id: "new-chat",
      label: "New conversation",
      icon: <MessageSquare size={13} />,
      onSelect: () =>
        onOpenChat?.({
          teamId: node.teamId,
          agentId: node.agentId,
          forceNew: true,
        }),
    },
    {
      id: "assign-task",
      label: "Assign task",
      icon: <Plus size={13} />,
      onSelect: () => onQuickAssign?.(node.agentId),
    },
    {
      id: "add-report",
      label: "Add direct report",
      icon: <UserPlus size={13} />,
      onSelect: () => onQuickAddReport?.(node.agentId),
    },
    {
      id: "edit-role",
      label: "Edit role & reporting",
      icon: <Pencil size={13} />,
      onSelect: () => {
        setPosition(node.position || "");
        setResponsibility(node.responsibility || "");
        setReportsTo(node.reportsToAgentId || "");
        setEditing((prev) => !prev);
      },
    },
    ...(onGetMemberModel
      ? [
          {
            id: "model-defaults",
            label: "Model defaults",
            icon: <Cpu size={13} />,
            onSelect: () => void toggleModelConfig(),
          },
        ]
      : []),
    { separator: true },
    {
      id: "remove-member",
      label: "Remove from team",
      icon: <Trash2 size={13} />,
      danger: true,
      onSelect: () => onRemoveMember?.({ teamId: node.teamId, agentId: node.agentId }),
    },
  ];

  return (
    <div className={`org-tree-branch depth-${Math.min(depth, 4)}`} data-agent-id={node.agentId}>
      <div className={`org-member-card ${node.isLeader ? "is-leader" : ""}`}>
        <div className="org-member-top">
          <div className="org-member-identity">
            <div className="org-member-name-row">
              <span className={`agent-status-dot tone-${node.tone}`} />
              <strong className="org-member-name">{node.name}</strong>
              {node.isLeader && (
                <span className="org-leader-badge" title="Team Leader">
                  <Crown size={11} aria-hidden="true" />
                  <span>Leader</span>
                </span>
              )}
              <span className="org-role-pill">{node.position}</span>
              {node.worktreeOf && (
                <span className="org-worktree-pill" title={`Git worktree of ${node.worktreeOf}`}>
                  <GitBranch size={11} aria-hidden="true" />
                  <span>Worktree</span>
                </span>
              )}
              {node.status && node.status !== "Idle" && (
                <span className={`agent-status-pill tone-${node.tone}`}>{node.status}</span>
              )}
            </div>
            {(node.reportsToName || node.responsibility) && (
              <div className="org-member-sub">
                {node.reportsToName && <span>Reports to {node.reportsToName}</span>}
                {node.reportsToName && node.responsibility && <span>·</span>}
                {node.responsibility && <span>{node.responsibility}</span>}
              </div>
            )}
          </div>
          <div className="org-member-actions">
            <button
              type="button"
              className="agent-btn primary sm"
              disabled={busy}
              onClick={() =>
                onOpenChat?.({
                  teamId: node.teamId,
                  agentId: node.agentId,
                  runtimeSessionId: node.latestRuntimeSessionId,
                  resumeLatest: true,
                })
              }
            >
              <MessageSquare size={13} aria-hidden="true" />
              <span>Chat</span>
            </button>
            <Menu
              label={`Actions for ${node.name}`}
              items={memberMenuItems}
              trigger={(props) => (
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={`Actions for ${node.name}`}
                  title="Member actions"
                  {...props}
                >
                  <MoreHorizontal size={14} aria-hidden="true" />
                </button>
              )}
            />
          </div>
        </div>

        {node.activeTask && (
          <button
            type="button"
            className="org-active-task"
            onClick={() => onSelectTask?.(node.teamId, node.activeTask.id)}
          >
            <span className="org-active-task-kicker">Working on</span>
            <span className="org-active-task-brief">{node.activeTask.brief}</span>
          </button>
        )}

        <div className="org-member-meta-bar">
          <button
            type="button"
            className="org-member-sessions-toggle"
            aria-expanded={sessionsExpanded}
            onClick={() => setSessionsExpanded((prev) => !prev)}
          >
            {sessionsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>Conversations ({memberSessions.length})</span>
          </button>
          <div className="org-member-stats">
            {node.taskCounts.active > 0 && <span>{node.taskCounts.active} active</span>}
            {node.taskCounts.attention > 0 && (
              <span className="org-stat-attention">{node.taskCounts.attention} need review</span>
            )}
            {sessionsExpanded && (
              <button
                type="button"
                className="agent-btn ghost xs"
                disabled={busy}
                onClick={() =>
                  onOpenChat?.({
                    teamId: node.teamId,
                    agentId: node.agentId,
                    forceNew: true,
                  })
                }
              >
                <Plus size={11} aria-hidden="true" />
                <span>New</span>
              </button>
            )}
          </div>
        </div>

        <div
          className={`sidebar-collapse-wrap ${sessionsExpanded ? "is-open" : ""}`}
          aria-hidden={!sessionsExpanded}
          inert={!sessionsExpanded ? "" : undefined}
        >
          <div className="sidebar-collapse-inner">
            <div className="org-member-session-list">
              {memberSessions.length === 0 ? (
                <div className="org-member-session-empty">
                  <span>No conversations yet.</span>
                  <button
                    type="button"
                    className="agent-btn secondary xs"
                    disabled={busy}
                    onClick={() =>
                      onOpenChat?.({
                        teamId: node.teamId,
                        agentId: node.agentId,
                        forceNew: true,
                      })
                    }
                  >
                    <Plus size={11} aria-hidden="true" />
                    <span>Start conversation</span>
                  </button>
                </div>
              ) : (
                <>
                  {visibleSessions.map((sess) => (
                    <div key={sess.runtimeSessionId} className="org-member-session-row">
                      {renamingSessionId === sess.runtimeSessionId ? (
                        <form
                          className="org-session-rename-form"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            await onRenameSession?.(sess.runtimeSessionId, renameDraft, {
                              teamId: node.teamId,
                            });
                            setRenamingSessionId("");
                          }}
                        >
                          <input
                            type="text"
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            placeholder="Conversation title"
                            autoFocus
                          />
                          <button type="submit" className="agent-btn primary xs" disabled={busy}>
                            Save
                          </button>
                          <button
                            type="button"
                            className="agent-btn ghost xs"
                            onClick={() => setRenamingSessionId("")}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="org-member-session-main"
                            onClick={() =>
                              onOpenChat?.({
                                teamId: node.teamId,
                                agentId: node.agentId,
                                runtimeSessionId: sess.runtimeSessionId,
                              })
                            }
                          >
                            <span className={`agent-status-dot tone-${sess.tone}`} />
                            <span className="org-member-session-title">{sess.title}</span>
                            {sess.origin === "task" && (
                              <span className="org-member-session-badge">Task</span>
                            )}
                            {sess.status && sess.status !== "Idle" && (
                              <span className={`org-member-session-status tone-${sess.tone}`}>
                                {sess.status}
                              </span>
                            )}
                            {sess.ageText && (
                              <span className="org-member-session-age">{sess.ageText}</span>
                            )}
                          </button>
                          <div className="org-member-session-actions">
                            <button
                              type="button"
                              className="icon-button xs"
                              title="Rename conversation"
                              aria-label={`Rename ${sess.title}`}
                              onClick={() => {
                                setRenamingSessionId(sess.runtimeSessionId);
                                setRenameDraft(sess.title);
                              }}
                            >
                              <Pencil size={11} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="icon-button xs"
                              title="Delete conversation"
                              aria-label={`Delete ${sess.title}`}
                              onClick={() =>
                                onDeleteSession?.(sess.runtimeSessionId, { teamId: node.teamId })
                              }
                            >
                              <Trash2 size={11} aria-hidden="true" />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  {moreSessionsCount > 0 && (
                    <button
                      type="button"
                      className="sidebar-load-more"
                      onClick={() => setSessionLimit((prev) => prev + 5)}
                    >
                      <span>Show {moreSessionsCount} more</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {modelOpen && (
          <form className="org-member-edit-form" onSubmit={saveModelConfig}>
            <div className="org-form-grid">
              <label>
                <span>Default Model ({modelSource || "folder"})</span>
                <input
                  type="text"
                  value={modelInput}
                  disabled={modelLoading}
                  onChange={(e) => setModelInput(e.target.value)}
                  placeholder="Leave empty to inherit runtime default"
                />
              </label>
              <label>
                <span>Provider (Optional)</span>
                <input
                  type="text"
                  value={providerInput}
                  disabled={modelLoading}
                  onChange={(e) => setProviderInput(e.target.value)}
                  placeholder="e.g. openai, anthropic"
                />
              </label>
              <label>
                <span>Reasoning Effort</span>
                <SettingsSelect
                  ariaLabel="Reasoning Effort"
                  value={effortInput}
                  disabled={modelLoading}
                  onChange={(val) => setEffortInput(val)}
                  options={[
                    { value: "", label: "Default" },
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                  ]}
                />
              </label>
            </div>
            <div className="org-form-actions">
              <button type="button" className="agent-btn ghost sm" onClick={() => setModelOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="agent-btn primary sm" disabled={busy || modelLoading}>
                Save model defaults
              </button>
            </div>
          </form>
        )}

        {editing && (
          <form className="org-member-edit-form" onSubmit={saveEdits}>
            <div className="org-form-grid">
              <label>
                <span>Position / Title</span>
                <input
                  type="text"
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  placeholder="e.g. Frontend Architect, QA Lead"
                />
              </label>
              <label>
                <span>Reports To</span>
                <SettingsSelect
                  ariaLabel="Reports To"
                  value={reportsTo}
                  onChange={(val) => setReportsTo(val)}
                  options={[
                    { value: "", label: "None (Top level)" },
                    ...allMembers
                      .filter((m) => m.agentId !== node.agentId)
                      .map((m) => ({
                        value: m.agentId,
                        label: `${m.name} (${m.position})`,
                      })),
                  ]}
                />
              </label>
            </div>
            <label>
              <span>Responsibility</span>
              <input
                type="text"
                value={responsibility}
                onChange={(e) => setResponsibility(e.target.value)}
                placeholder="Scope of ownership and deliverables…"
              />
            </label>
            <div className="org-form-actions">
              <button type="button" className="agent-btn ghost sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="submit" className="agent-btn primary sm" disabled={busy}>
                Save role
              </button>
            </div>
          </form>
        )}
      </div>

      {node.children?.length > 0 && (
        <div className="org-tree-children" role="group" aria-label={`Direct reports of ${node.name}`}>
          {node.children.map((child) => (
            <OrgMemberNode
              key={child.agentId}
              node={child}
              allMembers={allMembers}
              depth={depth + 1}
              busy={busy}
              onOpenChat={onOpenChat}
              onRenameSession={onRenameSession}
              onDeleteSession={onDeleteSession}
              onQuickAssign={onQuickAssign}
              onQuickAddReport={onQuickAddReport}
              onSelectTask={onSelectTask}
              onSetSupervisor={onSetSupervisor}
              onUpdateMember={onUpdateMember}
              onRemoveMember={onRemoveMember}
              onGetMemberModel={onGetMemberModel}
              onSetMemberModel={onSetMemberModel}
              onClearMemberModel={onClearMemberModel}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TeamView({
  teamSummary,
  teamTasks,
  activeTab = "organization",
  selectedTaskId = "",
  busy = false,
  onTabChange,
  onSelectTask,
  onOpenChat,
  onRenameSession,
  onDeleteSession,
  onOpenManager,
  onCreateMember,
  onUpdateMember,
  onRemoveMember,
  onSetSupervisor,
  onGetMemberModel,
  onSetMemberModel,
  onClearMemberModel,
  onAssignTask,
  onStartTask,
  onCancelTask,
  onSetPriority,
  onReviewTask,
  onPostNote,
  onReadArtifact,
  onDeleteTeam,
}) {
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [sectionFilter, setSectionFilter] = useState("all"); // "all" | "needs" | "active" | "done"
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [memberMode, setMemberMode] = useState("workspace"); // "workspace" | "existing" | "worktree"
  const [memberName, setMemberName] = useState("");
  const [memberPath, setMemberPath] = useState("");
  const [memberBranch, setMemberBranch] = useState("");
  const [memberPosition, setMemberPosition] = useState("");
  const [memberResponsibility, setMemberResponsibility] = useState("");
  const [memberSupervisor, setMemberSupervisor] = useState("");

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignAgentId, setAssignAgentId] = useState("");
  const [assignBrief, setAssignBrief] = useState("");
  const [assignStartNow, setAssignStartNow] = useState(true);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const team = teamSummary?.team;
  const members = teamSummary?.members || [];
  const orgRoots = teamSummary?.orgRoots || [];
  const counts = teamSummary?.counts || {
    members: 0,
    working: 0,
    attention: 0,
    sessions: 0,
    tasksTotal: 0,
    tasksQueued: 0,
    tasksInProgress: 0,
    tasksAttention: 0,
    tasksCompleted: 0,
  };

  const filteredSections = useMemo(() => {
    const allTasks = (teamTasks?.all || []).filter((t) =>
      assigneeFilter ? t.assigneeAgentId === assigneeFilter : true,
    );
    const defs = TASK_SECTION_DEFS.filter((def) => {
      if (sectionFilter === "needs") return def.id === "needs";
      if (sectionFilter === "active")
        return def.id === "needs" || def.id === "working" || def.id === "queued" || def.id === "delegated";
      if (sectionFilter === "done") return def.id === "done" || def.id === "cancelled";
      return true;
    });
    return defs
      .map((def) => ({
        ...def,
        tasks: allTasks.filter((t) => t.group === def.id),
      }))
      .filter((section) => section.tasks.length > 0);
  }, [teamTasks, assigneeFilter, sectionFilter]);

  const selectedTask = useMemo(() => {
    const all = teamTasks?.all || [];
    if (selectedTaskId) {
      return all.find((t) => t.id === selectedTaskId) || null;
    }
    return null;
  }, [selectedTaskId, teamTasks]);

  if (!team) {
    return (
      <div className="agents-surface panel-scroll">
        <div className="agents-empty-hero">
          <Network size={28} aria-hidden="true" />
          <h2>No team selected</h2>
          <p>Select a team from the sidebar or talk with the Manager to spin up an agent team.</p>
          <button type="button" className="agent-btn primary" onClick={onOpenManager}>
            <Sparkles size={14} aria-hidden="true" />
            <span>Open Manager</span>
          </button>
        </div>
      </div>
    );
  }

  function handleQuickAssign(agentId) {
    setAssignAgentId(agentId || teamSummary?.leader?.agentId || members[0]?.agentId || "");
    setAssignOpen(true);
    setAddMemberOpen(false);
    setDeleteOpen(false);
  }

  function handleQuickAddReport(supervisorAgentId) {
    setMemberSupervisor(supervisorAgentId || "");
    setAddMemberOpen(true);
    setAssignOpen(false);
    setDeleteOpen(false);
  }

  async function submitNewMember(event) {
    event.preventDefault();
    const reportsToAgentId = memberSupervisor || teamSummary?.leader?.agentId || undefined;
    await onCreateMember?.({
      mode: memberMode,
      teamId: team.id,
      name: memberName.trim(),
      workspace: memberPath.trim(),
      repository: memberPath.trim(),
      branch: memberBranch.trim(),
      position: memberPosition.trim() || undefined,
      responsibility: memberResponsibility.trim() || undefined,
      reportsToAgentId,
    });
    setMemberName("");
    setMemberPath("");
    setMemberBranch("");
    setMemberPosition("");
    setMemberResponsibility("");
    setAddMemberOpen(false);
  }

  async function submitAssignTask(event) {
    event.preventDefault();
    const targetId = assignAgentId || teamSummary?.leader?.agentId || members[0]?.agentId || "";
    const brief = assignBrief.trim();
    if (!targetId || !brief) return;
    await onAssignTask?.({
      teamId: team.id,
      assigneeAgentId: targetId,
      brief,
      start: assignStartNow,
    });
    setAssignBrief("");
    setAssignOpen(false);
    onTabChange?.("tasks");
  }

  const teamHeaderMenuItems = [
    ...(teamSummary.leader
      ? [
          {
            id: "chat-leader",
            label: `Chat with Leader (${teamSummary.leader.name})`,
            icon: <MessageSquare size={13} />,
            onSelect: () =>
              onOpenChat?.({
                teamId: team.id,
                agentId: teamSummary.leader.agentId,
                runtimeSessionId: teamSummary.leader.latestRuntimeSessionId,
                resumeLatest: true,
              }),
          },
        ]
      : []),
    {
      id: "delete-team",
      label: "Delete team…",
      icon: <Trash2 size={13} />,
      danger: true,
      onSelect: () => {
        setDeleteOpen(true);
        setAddMemberOpen(false);
        setAssignOpen(false);
      },
    },
  ];

  return (
    <div className="agents-surface">
      <div className="agents-surface-header">
        <div className="agents-surface-title-row">
          <h2 className="agents-surface-title">{team.name}</h2>
          <div className="agents-segmented" role="tablist" aria-label="Team view mode">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "organization"}
              className={`agents-seg-btn ${activeTab === "organization" ? "active" : ""}`}
              onClick={() => onTabChange?.("organization")}
            >
              <span>Members</span>
              <span className="agents-seg-count">{counts.members}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "tasks"}
              className={`agents-seg-btn ${activeTab === "tasks" ? "active" : ""}`}
              onClick={() => onTabChange?.("tasks")}
            >
              <span>Tasks</span>
              <span className="agents-seg-count">{counts.tasksTotal}</span>
            </button>
          </div>
          {counts.working > 0 && (
            <span className="agent-status-pill tone-working">{counts.working} active</span>
          )}
          {counts.tasksAttention > 0 && (
            <span className="agent-status-pill tone-attention">{counts.tasksAttention} need review</span>
          )}
        </div>

        <div className="agents-surface-actions">
          <button
            type="button"
            className="agent-btn secondary sm"
            onClick={() => {
              setMemberSupervisor(teamSummary.leader?.agentId || "");
              setAddMemberOpen((prev) => !prev);
              setAssignOpen(false);
              setDeleteOpen(false);
            }}
          >
            <UserPlus size={13} aria-hidden="true" />
            <span>Add Member</span>
          </button>
          <button
            type="button"
            className="agent-btn primary sm"
            disabled={members.length === 0}
            onClick={() => {
              setAssignAgentId(teamSummary.leader?.agentId || members[0]?.agentId || "");
              setAssignOpen((prev) => !prev);
              setAddMemberOpen(false);
              setDeleteOpen(false);
            }}
          >
            <Plus size={13} aria-hidden="true" />
            <span>Assign Task</span>
          </button>
          <Menu
            label="Team actions"
            items={teamHeaderMenuItems}
            trigger={(props) => (
              <button
                type="button"
                className="icon-button small"
                aria-label="Team actions"
                title="Team actions"
                {...props}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
            )}
          />
        </div>
      </div>

      {deleteOpen && (
        <form
          className="agents-inline-panel"
          onSubmit={async (e) => {
            e.preventDefault();
            if (deleteConfirm.trim() !== team.name) return;
            await onDeleteTeam?.({ teamId: team.id, confirmName: deleteConfirm.trim() });
            setDeleteOpen(false);
          }}
        >
          <div className="team-delete-confirm">
            <span>
              Type <strong>{team.name}</strong> to archive and delete this team:
            </span>
            <input
              type="text"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={team.name}
              aria-label="Confirm team name"
            />
            <button
              type="submit"
              className="agent-btn danger sm"
              disabled={busy || deleteConfirm.trim() !== team.name}
            >
              Confirm Delete
            </button>
            <button type="button" className="agent-btn ghost sm" onClick={() => setDeleteOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {addMemberOpen && (
        <form className="agents-inline-panel" onSubmit={submitNewMember} aria-label="Add team member">
          <div className="agents-inline-panel-head">
            <strong>Add Team Member</strong>
            <div className="agents-mode-pills">
              <button
                type="button"
                className={`agent-mode-pill ${memberMode === "workspace" ? "active" : ""}`}
                onClick={() => setMemberMode("workspace")}
              >
                New Workspace
              </button>
              <button
                type="button"
                className={`agent-mode-pill ${memberMode === "existing" ? "active" : ""}`}
                onClick={() => setMemberMode("existing")}
              >
                Existing Folder
              </button>
              <button
                type="button"
                className={`agent-mode-pill ${memberMode === "worktree" ? "active" : ""}`}
                onClick={() => setMemberMode("worktree")}
              >
                Git Worktree
              </button>
            </div>
          </div>
          <div className="org-form-grid">
            <label>
              <span>Agent Name</span>
              <input
                type="text"
                required={memberMode !== "existing"}
                value={memberName}
                onChange={(e) => setMemberName(e.target.value)}
                placeholder="e.g. frontend-specialist"
              />
            </label>
            <label>
              <span>Position / Role</span>
              <input
                type="text"
                value={memberPosition}
                onChange={(e) => setMemberPosition(e.target.value)}
                placeholder="e.g. UI Engineer, Verification Specialist"
              />
            </label>
            {memberMode !== "workspace" && (
              <label>
                <span>{memberMode === "worktree" ? "Git Repository Path" : "Workspace Folder Path"}</span>
                <input
                  type="text"
                  required
                  value={memberPath}
                  onChange={(e) => setMemberPath(e.target.value)}
                  placeholder="E:/projects/my-repo"
                />
              </label>
            )}
            {memberMode === "worktree" && (
              <label>
                <span>Worktree Branch</span>
                <input
                  type="text"
                  required
                  value={memberBranch}
                  onChange={(e) => setMemberBranch(e.target.value)}
                  placeholder="feat/agent-branch"
                />
              </label>
            )}
            <label>
              <span>Reports To</span>
              <SettingsSelect
                ariaLabel="Reports To"
                value={memberSupervisor}
                onChange={(val) => setMemberSupervisor(val)}
                options={[
                  { value: "", label: "None (Top level)" },
                  ...members.map((m) => ({
                    value: m.agentId,
                    label: `${m.name} (${m.position})`,
                  })),
                ]}
              />
            </label>
            <label>
              <span>Responsibility</span>
              <input
                type="text"
                value={memberResponsibility}
                onChange={(e) => setMemberResponsibility(e.target.value)}
                placeholder="What this member owns and delivers…"
              />
            </label>
          </div>
          <div className="org-form-actions">
            <button type="button" className="agent-btn ghost sm" onClick={() => setAddMemberOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="agent-btn primary sm" disabled={busy}>
              Add Member
            </button>
          </div>
        </form>
      )}

      {assignOpen && (
        <form className="agents-inline-panel" onSubmit={submitAssignTask} aria-label="Assign task to member">
          <div className="agents-inline-panel-head">
            <strong>Assign Task</strong>
          </div>
          <div className="org-form-grid">
            <label>
              <span>Assignee</span>
              <SettingsSelect
                ariaLabel="Task assignee"
                value={assignAgentId}
                onChange={(val) => setAssignAgentId(val)}
                options={members.map((m) => ({
                  value: m.agentId,
                  label: `${m.name} — ${m.position}`,
                }))}
              />
            </label>
            <label className="org-checkbox-row">
              <input
                type="checkbox"
                checked={assignStartNow}
                onChange={(e) => setAssignStartNow(e.target.checked)}
              />
              <span>Start immediately</span>
            </label>
          </div>
          <label>
            <span>Task Brief</span>
            <textarea
              rows={3}
              required
              value={assignBrief}
              onChange={(e) => setAssignBrief(e.target.value)}
              placeholder="Describe the objective and expected deliverables…"
              aria-label="Task brief"
            />
          </label>
          <div className="org-form-actions">
            <button type="button" className="agent-btn ghost sm" onClick={() => setAssignOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="agent-btn primary sm" disabled={busy || !assignBrief.trim()}>
              {assignStartNow ? "Assign & Start" : "Queue Task"}
            </button>
          </div>
        </form>
      )}

      <div className="agents-surface-split">
        <div className="agents-surface-main panel-scroll">
          {activeTab === "organization" ? (
            <div className="org-view-container">
              {orgRoots.length === 0 ? (
                <div className="agents-empty-hero">
                  <FolderGit2 size={26} aria-hidden="true" />
                  <h3>No members in {team.name} yet</h3>
                  <p>
                    Add a specialist workspace or git worktree to build this team&apos;s reporting structure.
                  </p>
                  <button type="button" className="agent-btn primary sm" onClick={() => setAddMemberOpen(true)}>
                    <UserPlus size={13} aria-hidden="true" />
                    <span>Add First Member</span>
                  </button>
                </div>
              ) : (
                <div className="org-chart-tree" role="tree" aria-label={`${team.name} organization hierarchy`}>
                  {orgRoots.map((rootNode) => (
                    <OrgMemberNode
                      key={rootNode.agentId}
                      node={rootNode}
                      allMembers={members}
                      busy={busy}
                      onOpenChat={onOpenChat}
                      onRenameSession={onRenameSession}
                      onDeleteSession={onDeleteSession}
                      onQuickAssign={handleQuickAssign}
                      onQuickAddReport={handleQuickAddReport}
                      onSelectTask={onSelectTask}
                      onSetSupervisor={onSetSupervisor}
                      onUpdateMember={onUpdateMember}
                      onRemoveMember={onRemoveMember}
                      onGetMemberModel={onGetMemberModel}
                      onSetMemberModel={onSetMemberModel}
                      onClearMemberModel={onClearMemberModel}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="tasks-view-container">
              {(teamTasks?.all?.length || 0) > 0 && (
                <div className="tasks-toolbar">
                  {members.length > 1 && (
                    <div className="tasks-filter-select">
                      <span>Member:</span>
                      <SettingsSelect
                        className="sm"
                        ariaLabel="Filter tasks by member"
                        value={assigneeFilter}
                        onChange={(val) => setAssigneeFilter(val)}
                        options={[
                          { value: "", label: `All (${teamTasks?.all?.length || 0})` },
                          ...members.map((m) => ({
                            value: m.agentId,
                            label: m.name,
                          })),
                        ]}
                      />
                    </div>
                  )}
                  <div className="agents-segmented" role="group" aria-label="Filter tasks by stage">
                    <button
                      type="button"
                      className={`agents-seg-btn ${sectionFilter === "all" ? "active" : ""}`}
                      onClick={() => setSectionFilter("all")}
                    >
                      <span>All</span>
                    </button>
                    <button
                      type="button"
                      className={`agents-seg-btn ${sectionFilter === "needs" ? "active" : ""}`}
                      onClick={() => setSectionFilter("needs")}
                    >
                      <span>Needs You</span>
                    </button>
                    <button
                      type="button"
                      className={`agents-seg-btn ${sectionFilter === "active" ? "active" : ""}`}
                      onClick={() => setSectionFilter("active")}
                    >
                      <span>Active</span>
                    </button>
                    <button
                      type="button"
                      className={`agents-seg-btn ${sectionFilter === "done" ? "active" : ""}`}
                      onClick={() => setSectionFilter("done")}
                    >
                      <span>Delivered</span>
                    </button>
                  </div>
                </div>
              )}

              {filteredSections.length === 0 ? (
                <div className="agents-empty-hero">
                  <ListChecks size={26} aria-hidden="true" />
                  <h3>No tasks found</h3>
                  <p>Assign a task to the team leader or any specialist member.</p>
                  <button
                    type="button"
                    className="agent-btn primary sm"
                    disabled={members.length === 0}
                    onClick={() => handleQuickAssign(teamSummary.leader?.agentId)}
                  >
                    <Plus size={13} aria-hidden="true" />
                    <span>Assign Task</span>
                  </button>
                </div>
              ) : (
                <div className="task-sections-stack" role="region" aria-label="Grouped team tasks">
                  {filteredSections.map((section) => (
                    <section key={section.id} className="task-group-section" data-section={section.id}>
                      <div className="task-group-head">
                        <h3 className="task-group-title">{section.label}</h3>
                        <span className="task-group-count">{section.tasks.length}</span>
                      </div>
                      <div className="task-list-table" role="list">
                        {section.tasks.map((task) => (
                          <div
                            key={task.id}
                            role="listitem"
                            tabIndex={0}
                            className={`task-list-row ${selectedTask?.id === task.id ? "selected" : ""}`}
                            onClick={() => onSelectTask?.(team.id, task.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onSelectTask?.(team.id, task.id);
                              }
                            }}
                          >
                            <div className="task-list-main">
                              <div className="task-list-title-line">
                                <span className={`agent-status-pill tone-${task.tone}`}>
                                  {task.statusLabel}
                                </span>
                                {task.priority !== "normal" && (
                                  <span className={`task-priority-chip ${task.priority}`}>
                                    {task.priority}
                                  </span>
                                )}
                                <strong className="task-list-brief">{task.brief}</strong>
                              </div>

                              {task.blockedSummary && (
                                <div className="task-list-callout attention">
                                  {task.blockedSummary}
                                </div>
                              )}

                              {task.report?.summary && (
                                <div className="task-list-callout report">
                                  {task.report.outcome && (
                                    <span className="task-outcome-inline">{task.report.outcome}: </span>
                                  )}
                                  {task.report.summary}
                                </div>
                              )}
                            </div>

                            <div className="task-list-meta" onClick={(e) => e.stopPropagation()}>
                              <span className="task-list-assignee">{task.assigneeName}</span>
                              {task.artifactRecords?.length > 0 && (
                                <span className="task-list-badge" title="Published artifacts">
                                  <FileText size={11} aria-hidden="true" />
                                  <span>{task.artifactRecords.length}</span>
                                </span>
                              )}
                              {task.ageText && <span className="task-list-age">{task.ageText}</span>}
                              {task.status === "queued" && (
                                <button
                                  type="button"
                                  className="agent-btn ghost xs"
                                  disabled={busy}
                                  onClick={() => void onStartTask?.(task.id)}
                                >
                                  <Play size={11} aria-hidden="true" />
                                  <span>Start</span>
                                </button>
                              )}
                              {task.unreviewed && (
                                <button
                                  type="button"
                                  className="agent-btn primary xs"
                                  disabled={busy}
                                  onClick={() => void onReviewTask?.(task.id, "accept")}
                                >
                                  <CheckCircle2 size={11} aria-hidden="true" />
                                  <span>Accept</span>
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {selectedTask && (
          <TaskReportDrawer
            task={selectedTask}
            busy={busy}
            onClose={() => onSelectTask?.(team.id, "")}
            onStartTask={onStartTask}
            onCancelTask={onCancelTask}
            onSetPriority={onSetPriority}
            onReviewTask={onReviewTask}
            onPostNote={onPostNote}
            onReadArtifact={onReadArtifact}
            onOpenChat={onOpenChat}
          />
        )}
      </div>
    </div>
  );
}

