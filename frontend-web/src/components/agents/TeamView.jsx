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
  Network,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  UserPlus,
} from "lucide-react";
import { TASK_SECTION_DEFS } from "../../lib/agentsModel.js";
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
  onSetLeader,
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

  const [sessionsExpanded, setSessionsExpanded] = useState(true);
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");

  const memberSessions = Array.isArray(node.sessions) ? node.sessions : [];

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

  return (
    <div className={`org-tree-branch depth-${Math.min(depth, 4)}`} data-agent-id={node.agentId}>
      <div className={`org-member-card ${node.isLeader ? "is-leader" : ""}`}>
        <div className="org-member-top">
          <div className="org-member-identity">
            <div className="org-member-name-row">
              <strong className="org-member-name">{node.name}</strong>
              {node.isLeader && (
                <span className="org-leader-badge" title="Team Leader">
                  <Crown size={12} aria-hidden="true" />
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
            </div>
            <div className="org-member-sub">
              {node.reportsToName ? (
                <span>Reports to {node.reportsToName}</span>
              ) : node.isLeader ? (
                <span>Coordinates team &amp; delegates work</span>
              ) : (
                <span>Direct team member</span>
              )}
              {node.canonicalWorkspace && (
                <code className="org-workspace-path" title={node.canonicalWorkspace}>
                  {node.canonicalWorkspace}
                </code>
              )}
            </div>
          </div>
          <span className={`agent-status-pill tone-${node.tone}`}>
            <span className="agent-status-dot" />
            <span>{node.status}</span>
          </span>
        </div>

        {node.responsibility && <p className="org-member-responsibility">{node.responsibility}</p>}

        {node.activeTask && (
          <button
            type="button"
            className="org-active-task"
            onClick={() => onSelectTask?.(node.teamId, node.activeTask.id)}
          >
            <span className="org-active-task-kicker">Current Task</span>
            <span className="org-active-task-brief">{node.activeTask.brief}</span>
          </button>
        )}

        {/* Member Conversations (Sessions) Section */}
        <div className="org-member-sessions">
          <div className="org-member-sessions-head">
            <button
              type="button"
              className="org-member-sessions-toggle"
              onClick={() => setSessionsExpanded((prev) => !prev)}
            >
              {sessionsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <MessageSquare size={12} aria-hidden="true" />
              <span>Conversations ({memberSessions.length})</span>
            </button>
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
              <span>New conversation</span>
            </button>
          </div>

          {sessionsExpanded && (
            <div className="org-member-session-list">
              {memberSessions.length === 0 ? (
                <div className="org-member-session-empty">
                  <span>No conversations yet with {node.name}.</span>
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
                    <span>Start first conversation</span>
                  </button>
                </div>
              ) : (
                memberSessions.map((sess) => (
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
                          <span className={`org-member-session-status tone-${sess.tone}`}>
                            {sess.status}
                          </span>
                          {sess.model && (
                            <span className="org-member-session-meta">{sess.model}</span>
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
                ))
              )}
            </div>
          )}
        </div>

        <div className="org-member-footer">
          <div className="org-member-stats">
            <span>{node.taskCounts.active} active task(s)</span>
            {node.taskCounts.attention > 0 && (
              <span className="org-stat-attention">{node.taskCounts.attention} need review</span>
            )}
            <span>{node.taskCounts.done} delivered</span>
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
              <span>{memberSessions.length > 0 ? "Open chat" : "New chat"}</span>
            </button>
            <button
              type="button"
              className="agent-btn secondary sm"
              disabled={busy}
              onClick={() => onQuickAssign?.(node.agentId)}
            >
              <Plus size={13} aria-hidden="true" />
              <span>Assign task</span>
            </button>
            <button
              type="button"
              className="agent-btn ghost sm"
              disabled={busy}
              title={`Add a direct report under ${node.name}`}
              onClick={() => onQuickAddReport?.(node.agentId)}
            >
              <UserPlus size={13} aria-hidden="true" />
              <span>Add report</span>
            </button>
            {!node.isLeader && (
              <button
                type="button"
                className="agent-btn ghost sm"
                disabled={busy}
                title="Promote to Team Leader"
                onClick={() => onSetLeader?.({ teamId: node.teamId, agentId: node.agentId })}
              >
                <Crown size={13} aria-hidden="true" />
                <span>Make leader</span>
              </button>
            )}
            {onGetMemberModel && (
              <button
                type="button"
                className="icon-button small"
                aria-label={`Model settings for ${node.name}`}
                title="Configure member default model & reasoning effort"
                onClick={() => void toggleModelConfig()}
              >
                <Cpu size={13} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="icon-button small"
              aria-label={`Edit ${node.name}`}
              title="Edit role & reporting line"
              onClick={() => {
                setPosition(node.position || "");
                setResponsibility(node.responsibility || "");
                setReportsTo(node.reportsToAgentId || "");
                setEditing((prev) => !prev);
              }}
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button small"
              aria-label={`Remove ${node.name}`}
              title="Remove from team"
              disabled={busy}
              onClick={() => onRemoveMember?.({ teamId: node.teamId, agentId: node.agentId })}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
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
                <select
                  value={effortInput}
                  disabled={modelLoading}
                  onChange={(e) => setEffortInput(e.target.value)}
                >
                  <option value="">Default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
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
                <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
                  <option value="">None (Top level)</option>
                  {allMembers
                    .filter((m) => m.agentId !== node.agentId)
                    .map((m) => (
                      <option key={m.agentId} value={m.agentId}>
                        {m.name} ({m.position})
                      </option>
                    ))}
                </select>
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
              onSetLeader={onSetLeader}
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
  onSetLeader,
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
      if (sectionFilter === "active") return def.id === "needs" || def.id === "working" || def.id === "queued" || def.id === "delegated";
      if (sectionFilter === "done") return def.id === "done" || def.id === "cancelled";
      return true;
    });
    return defs.map((def) => ({
      ...def,
      tasks: allTasks.filter((t) => t.group === def.id),
    }));
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
  }

  function handleQuickAddReport(supervisorAgentId) {
    setMemberSupervisor(supervisorAgentId || "");
    setAddMemberOpen(true);
    setAssignOpen(false);
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

  return (
    <div className="agents-surface">
      <div className="agents-surface-header">
        <div className="agents-surface-title-block">
          <div className="agents-surface-title-row">
            <h2 className="agents-surface-title">{team.name}</h2>
            {teamSummary.leader && (
              <span className="agents-header-badge">
                <Crown size={12} aria-hidden="true" />
                <span>Lead: {teamSummary.leader.name}</span>
              </span>
            )}
            <span className="agents-header-meta">
              {counts.members} {counts.members === 1 ? "member" : "members"} · {counts.sessions || 0}{" "}
              {counts.sessions === 1 ? "conversation" : "conversations"} · {counts.tasksTotal}{" "}
              {counts.tasksTotal === 1 ? "task" : "tasks"}
            </span>
          </div>
          {team.createRoot && (
            <div className="agents-surface-subtitle">
              <span>Workspace root:</span> <code>{team.createRoot}</code>
            </div>
          )}
        </div>

        <div className="agents-surface-actions">
          <div className="agents-segmented" role="tablist" aria-label="Team view mode">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "organization"}
              className={`agents-seg-btn ${activeTab === "organization" ? "active" : ""}`}
              onClick={() => onTabChange?.("organization")}
            >
              <Network size={14} aria-hidden="true" />
              <span>Organization</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "tasks"}
              className={`agents-seg-btn ${activeTab === "tasks" ? "active" : ""}`}
              onClick={() => onTabChange?.("tasks")}
            >
              <ListChecks size={14} aria-hidden="true" />
              <span>Tasks &amp; Deliveries</span>
              {counts.tasksTotal > 0 && <span className="agents-seg-count">{counts.tasksTotal}</span>}
            </button>
          </div>

          {teamSummary.leader && (
            <button
              type="button"
              className="agent-btn secondary"
              onClick={() =>
                onOpenChat?.({
                  teamId: team.id,
                  agentId: teamSummary.leader.agentId,
                  runtimeSessionId: teamSummary.leader.latestRuntimeSessionId,
                  resumeLatest: true,
                })
              }
            >
              <MessageSquare size={14} aria-hidden="true" />
              <span>Chat with Leader</span>
            </button>
          )}
          <button
            type="button"
            className="agent-btn secondary"
            onClick={() => {
              setMemberSupervisor(teamSummary.leader?.agentId || "");
              setAddMemberOpen((prev) => !prev);
              setAssignOpen(false);
            }}
          >
            <UserPlus size={14} aria-hidden="true" />
            <span>Add Member</span>
          </button>
          <button
            type="button"
            className="agent-btn primary"
            disabled={members.length === 0}
            onClick={() => {
              setAssignAgentId(teamSummary.leader?.agentId || members[0]?.agentId || "");
              setAssignOpen((prev) => !prev);
              setAddMemberOpen(false);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            <span>Assign Task</span>
          </button>
        </div>
      </div>

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
              <select value={memberSupervisor} onChange={(e) => setMemberSupervisor(e.target.value)}>
                <option value="">None (Top level)</option>
                {members.map((m) => (
                  <option key={m.agentId} value={m.agentId}>
                    {m.name} ({m.position})
                  </option>
                ))}
              </select>
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
              Create &amp; Join Team
            </button>
          </div>
        </form>
      )}

      {assignOpen && (
        <form className="agents-inline-panel" onSubmit={submitAssignTask} aria-label="Assign task to member">
          <div className="agents-inline-panel-head">
            <strong>Assign New Task</strong>
          </div>
          <div className="org-form-grid">
            <label>
              <span>Assignee</span>
              <select
                value={assignAgentId}
                onChange={(e) => setAssignAgentId(e.target.value)}
                aria-label="Task assignee"
              >
                {members.map((m) => (
                  <option key={m.agentId} value={m.agentId}>
                    {m.name} — {m.position} ({m.status})
                  </option>
                ))}
              </select>
            </label>
            <label className="org-checkbox-row">
              <input
                type="checkbox"
                checked={assignStartNow}
                onChange={(e) => setAssignStartNow(e.target.checked)}
              />
              <span>Start task run immediately</span>
            </label>
          </div>
          <label>
            <span>Task Brief &amp; Deliverable Expectations</span>
            <textarea
              rows={3}
              required
              value={assignBrief}
              onChange={(e) => setAssignBrief(e.target.value)}
              placeholder="Describe the objective, constraints, and expected verification evidence…"
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
                  <button type="button" className="agent-btn primary" onClick={() => setAddMemberOpen(true)}>
                    <UserPlus size={14} aria-hidden="true" />
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
                      onSetLeader={onSetLeader}
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

              <div className="team-danger-zone">
                {!deleteOpen ? (
                  <button type="button" className="agent-btn ghost sm danger-text" onClick={() => setDeleteOpen(true)}>
                    <Trash2 size={13} aria-hidden="true" />
                    <span>Archive / Delete Team…</span>
                  </button>
                ) : (
                  <form
                    className="team-delete-confirm"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (deleteConfirm.trim() !== team.name) return;
                      await onDeleteTeam?.({ teamId: team.id, confirmName: deleteConfirm.trim() });
                      setDeleteOpen(false);
                    }}
                  >
                    <span>
                      Type <strong>{team.name}</strong> to confirm deleting this team:
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
                      Delete Team
                    </button>
                    <button type="button" className="agent-btn ghost sm" onClick={() => setDeleteOpen(false)}>
                      Cancel
                    </button>
                  </form>
                )}
              </div>
            </div>
          ) : (
            <div className="tasks-view-container">
              <div className="tasks-toolbar">
                <div className="tasks-filter-group">
                  <label className="tasks-filter-select">
                    <span>Member:</span>
                    <select
                      value={assigneeFilter}
                      onChange={(e) => setAssigneeFilter(e.target.value)}
                      aria-label="Filter tasks by member"
                    >
                      <option value="">All members ({teamTasks?.all?.length || 0})</option>
                      {members.map((m) => (
                        <option key={m.agentId} value={m.agentId}>
                          {m.name} ({m.position})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
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
                    <span>Active &amp; Queued</span>
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

              {(teamTasks?.all?.length || 0) === 0 ? (
                <div className="agents-empty-hero">
                  <ListChecks size={26} aria-hidden="true" />
                  <h3>No tasks assigned in {team.name} yet</h3>
                  <p>
                    Assign a task to the team leader or a specialist member to track execution, sub-delegations, and delivery reports.
                  </p>
                  <button
                    type="button"
                    className="agent-btn primary"
                    disabled={members.length === 0}
                    onClick={() => handleQuickAssign(teamSummary.leader?.agentId)}
                  >
                    <Plus size={14} aria-hidden="true" />
                    <span>Assign First Task</span>
                  </button>
                </div>
              ) : (
                <div className="task-sections-stack" role="region" aria-label="Grouped team tasks">
                  {filteredSections.map((section) => {
                    if (section.tasks.length === 0 && sectionFilter === "all" && section.id === "cancelled") {
                      return null;
                    }
                    return (
                      <section key={section.id} className="task-group-section" data-section={section.id}>
                        <div className="task-group-head">
                          <h3 className="task-group-title">{section.label}</h3>
                          <span className="task-group-count">{section.tasks.length}</span>
                        </div>
                        {section.tasks.length === 0 ? (
                          <div className="task-group-empty">{section.emptyText}</div>
                        ) : (
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
                                  <span className="task-list-assignee">
                                    {task.assigneeName} · {task.assigneePosition}
                                  </span>
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
                                  {task.runtimeSessionId && (
                                    <button
                                      type="button"
                                      className="agent-btn ghost xs"
                                      onClick={() =>
                                        onOpenChat?.({
                                          teamId: task.teamId,
                                          agentId: task.assigneeAgentId,
                                          runtimeSessionId: task.runtimeSessionId,
                                        })
                                      }
                                    >
                                      <MessageSquare size={11} aria-hidden="true" />
                                      <span>Session</span>
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
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
