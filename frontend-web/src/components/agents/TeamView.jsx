import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Crown,
  FolderGit2,
  GitBranch,
  Kanban,
  List,
  MessageSquare,
  Network,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  UserPlus,
} from "lucide-react";
import { KANBAN_COLUMNS } from "../../lib/agentsModel.js";
import { TaskReportDrawer } from "./TaskReportDrawer.jsx";

function OrgMemberNode({
  node,
  allMembers,
  depth = 0,
  busy,
  onOpenChat,
  onQuickAssign,
  onSelectTask,
  onSetLeader,
  onSetSupervisor,
  onUpdateMember,
  onRemoveMember,
}) {
  const [editing, setEditing] = useState(false);
  const [position, setPosition] = useState(node.position || "");
  const [responsibility, setResponsibility] = useState(node.responsibility || "");
  const [reportsTo, setReportsTo] = useState(node.reportsToAgentId || "");

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

        <div className="org-member-footer">
          <div className="org-member-stats">
            <span>{node.taskCounts.active} active</span>
            {node.taskCounts.attention > 0 && (
              <span className="org-stat-attention">{node.taskCounts.attention} need review</span>
            )}
            <span>{node.taskCounts.done} completed</span>
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
                })
              }
            >
              <MessageSquare size={13} aria-hidden="true" />
              <span>Chat</span>
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
              onQuickAssign={onQuickAssign}
              onSelectTask={onSelectTask}
              onSetLeader={onSetLeader}
              onSetSupervisor={onSetSupervisor}
              onUpdateMember={onUpdateMember}
              onRemoveMember={onRemoveMember}
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
  onOpenManager,
  onCreateMember,
  onUpdateMember,
  onRemoveMember,
  onSetLeader,
  onSetSupervisor,
  onAssignTask,
  onStartTask,
  onCancelTask,
  onSetPriority,
  onReviewTask,
  onPostNote,
  onReadArtifact,
  onDeleteTeam,
}) {
  const [taskLayout, setTaskLayout] = useState("board"); // "board" | "list"
  const [assigneeFilter, setAssigneeFilter] = useState("");
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
    tasksTotal: 0,
    tasksQueued: 0,
    tasksInProgress: 0,
    tasksAttention: 0,
    tasksCompleted: 0,
  };

  const selectedTask = useMemo(
    () => (selectedTaskId ? teamTasks?.all?.find((t) => t.id === selectedTaskId) || null : null),
    [selectedTaskId, teamTasks],
  );

  const filteredTasks = useMemo(() => {
    const all = teamTasks?.all || [];
    if (!assigneeFilter) return teamTasks;
    const filteredAll = all.filter((t) => t.assigneeAgentId === assigneeFilter);
    const columns = { queued: [], in_progress: [], needs_attention: [], completed: [] };
    for (const item of filteredAll) {
      columns[item.column]?.push(item);
    }
    return { all: filteredAll, columns };
  }, [teamTasks, assigneeFilter]);

  if (!team) {
    return (
      <div className="agents-surface panel-scroll">
        <div className="agents-empty-hero">
          <Network size={28} aria-hidden="true" />
          <h2>No team selected</h2>
          <p>Select a team from the sidebar or talk with the Manager to spin up an agent team.</p>
          <button type="button" className="agent-btn primary" onClick={onOpenManager}>
            <Sparkles size={14} aria-hidden="true" />
            <span>Open Manager Chat</span>
          </button>
        </div>
      </div>
    );
  }

  function handleQuickAssign(agentId) {
    setAssignAgentId(agentId || teamSummary?.leader?.agentId || members[0]?.agentId || "");
    setAssignOpen(true);
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
              {counts.members} {counts.members === 1 ? "member" : "members"} · {counts.tasksTotal}{" "}
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
              <Kanban size={14} aria-hidden="true" />
              <span>Tasks</span>
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
                      onQuickAssign={handleQuickAssign}
                      onSelectTask={onSelectTask}
                      onSetLeader={onSetLeader}
                      onSetSupervisor={onSetSupervisor}
                      onUpdateMember={onUpdateMember}
                      onRemoveMember={onRemoveMember}
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
                <div className="agents-segmented" role="group" aria-label="Tasks layout">
                  <button
                    type="button"
                    className={`agents-seg-btn ${taskLayout === "board" ? "active" : ""}`}
                    onClick={() => setTaskLayout("board")}
                  >
                    <Kanban size={13} aria-hidden="true" />
                    <span>Board</span>
                  </button>
                  <button
                    type="button"
                    className={`agents-seg-btn ${taskLayout === "list" ? "active" : ""}`}
                    onClick={() => setTaskLayout("list")}
                  >
                    <List size={13} aria-hidden="true" />
                    <span>List</span>
                  </button>
                </div>
              </div>

              {taskLayout === "board" ? (
                <div className="kanban-board" role="region" aria-label="Team tasks Kanban board">
                  {KANBAN_COLUMNS.map((col) => {
                    const colTasks = filteredTasks?.columns?.[col.id] || [];
                    return (
                      <div key={col.id} className="kanban-column" data-column={col.id}>
                        <div className="kanban-column-head">
                          <span className="kanban-column-title">{col.label}</span>
                          <span className="kanban-column-count">{colTasks.length}</span>
                        </div>
                        <div className="kanban-column-cards">
                          {colTasks.length === 0 ? (
                            <div className="kanban-empty">{col.emptyText}</div>
                          ) : (
                            colTasks.map((task) => (
                              <div
                                key={task.id}
                                role="button"
                                tabIndex={0}
                                className={`kanban-card ${selectedTask?.id === task.id ? "selected" : ""}`}
                                onClick={() => onSelectTask?.(team.id, task.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSelectTask?.(team.id, task.id);
                                  }
                                }}
                              >
                                <div className="kanban-card-top">
                                  <span className={`agent-status-pill tone-${task.tone}`}>{task.statusLabel}</span>
                                  {task.priority !== "normal" && (
                                    <span className={`task-priority-chip ${task.priority}`}>{task.priority}</span>
                                  )}
                                </div>
                                <div className="kanban-card-brief">{task.brief}</div>
                                {task.blockedOn?.action && (
                                  <div className="kanban-card-callout attention">
                                    Blocker: {task.blockedOn.action}
                                  </div>
                                )}
                                {task.report?.summary && (
                                  <div className="kanban-card-callout report">{task.report.summary}</div>
                                )}
                                <div className="kanban-card-foot">
                                  <span className="kanban-card-assignee">{task.assigneeName}</span>
                                  <div className="kanban-card-quick" onClick={(e) => e.stopPropagation()}>
                                    {task.status === "queued" && (
                                      <button
                                        type="button"
                                        className="agent-btn ghost xs"
                                        title="Start task"
                                        onClick={() => void onStartTask?.(task.id)}
                                      >
                                        <Play size={12} aria-hidden="true" />
                                        <span>Start</span>
                                      </button>
                                    )}
                                    {task.status === "done" && task.report && !task.review && (
                                      <button
                                        type="button"
                                        className="agent-btn primary xs"
                                        title="Accept delivery"
                                        onClick={() => void onReviewTask?.(task.id, "accept")}
                                      >
                                        <CheckCircle2 size={12} aria-hidden="true" />
                                        <span>Accept</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="tasks-grouped-list">
                  {filteredTasks?.all?.length === 0 ? (
                    <div className="agents-empty-hero">
                      <p>No tasks assigned yet.</p>
                    </div>
                  ) : (
                    filteredTasks.all.map((task) => (
                      <div
                        key={task.id}
                        role="button"
                        tabIndex={0}
                        className={`task-list-row-card ${selectedTask?.id === task.id ? "selected" : ""}`}
                        onClick={() => onSelectTask?.(team.id, task.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectTask?.(team.id, task.id);
                          }
                        }}
                      >
                        <span className={`agent-status-pill tone-${task.tone}`}>{task.statusLabel}</span>
                        <span className="task-list-brief">{task.brief}</span>
                        {task.priority !== "normal" && (
                          <span className={`task-priority-chip ${task.priority}`}>{task.priority}</span>
                        )}
                        <span className="task-list-assignee">{task.assigneeName}</span>
                      </div>
                    ))
                  )}
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
