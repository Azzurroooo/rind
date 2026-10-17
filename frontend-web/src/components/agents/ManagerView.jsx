import { useState } from "react";
import {
  Archive,
  Crown,
  ListChecks,
  MessageSquare,
  Network,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";

export function ManagerView({
  mode = "manager", // "manager" | "archive"
  managerSummary,
  teamSummaries = [],
  archiveList = [],
  busy = false,
  onOpenManagerChat,
  onRenameSession,
  onDeleteSession,
  onOpenTeam,
  onCreateTeam,
  onSwitchMode,
}) {
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamRoot, setNewTeamRoot] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");

  const sessions = Array.isArray(managerSummary?.sessions) ? managerSummary.sessions : [];

  async function handleCreateTeam(event) {
    event.preventDefault();
    const name = newTeamName.trim();
    if (!name || !onCreateTeam) return;
    await onCreateTeam(name, newTeamRoot.trim() || undefined);
    setNewTeamName("");
    setNewTeamRoot("");
    setNewTeamOpen(false);
  }

  if (mode === "archive") {
    return (
      <div className="agents-surface">
        <div className="agents-surface-header">
          <div className="agents-surface-title-block">
            <div className="agents-surface-title-row">
              <h2 className="agents-surface-title">Archived Teams</h2>
              <span className="agents-header-meta">{archiveList.length} archived team(s)</span>
            </div>
            <div className="agents-surface-subtitle">
              Completed teams that were deleted after delivering tasks retain their task history and reports here.
            </div>
          </div>
          <div className="agents-surface-actions">
            <button
              type="button"
              className="agent-btn secondary sm"
              onClick={() => onSwitchMode?.("manager")}
            >
              <Sparkles size={13} aria-hidden="true" />
              <span>Manager Overview</span>
            </button>
          </div>
        </div>

        <div className="agents-surface-main panel-scroll">
          {archiveList.length === 0 ? (
            <div className="agents-empty-hero">
              <Archive size={28} aria-hidden="true" />
              <h3>No archived teams</h3>
              <p>Teams deleted after completing tasks are preserved here with their delivery reports.</p>
            </div>
          ) : (
            <div className="bg-grid">
              {archiveList.map((archived) => {
                const tasks = Array.isArray(archived.tasks) ? archived.tasks : [];
                return (
                  <section key={archived.id} className="bg-card">
                    <div className="bg-card-head">
                      <Archive size={15} aria-hidden="true" />
                      <h3>{archived.name || archived.id}</h3>
                      {archived.archivedAt && (
                        <span className="agents-header-meta">
                          Archived {String(archived.archivedAt).slice(0, 10)}
                        </span>
                      )}
                    </div>
                    {tasks.length === 0 ? (
                      <p className="bg-empty-note">Archived team summary ({archived.taskCount || 0} task(s)).</p>
                    ) : (
                      <div className="task-list-table">
                        {tasks.map((task) => (
                          <div key={task.id} className="task-list-row">
                            <div className="task-list-main">
                              <div className="task-list-title-line">
                                <span className="agent-status-pill tone-completed">
                                  {task.status || "done"}
                                </span>
                                <strong className="task-list-brief">{task.brief}</strong>
                              </div>
                              {task.report?.summary && (
                                <div className="task-list-callout report">
                                  {task.report.outcome ? `${task.report.outcome}: ` : ""}
                                  {task.report.summary}
                                </div>
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
      </div>
    );
  }

  return (
    <div className="agents-surface">
      <div className="agents-surface-header">
        <div className="agents-surface-title-block">
          <div className="agents-surface-title-row">
            <h2 className="agents-surface-title">Manager · Coordinator</h2>
            <span className={`agent-status-pill tone-${managerSummary?.tone || "idle"}`}>
              <span className="agent-status-dot" />
              <span>{managerSummary?.status || "Idle"}</span>
            </span>
            <span className="agents-header-meta">
              {sessions.length} {sessions.length === 1 ? "conversation" : "conversations"} ·{" "}
              {teamSummaries.length} {teamSummaries.length === 1 ? "team" : "teams"}
            </span>
          </div>
          <div className="agents-surface-subtitle">
            The Manager coordinates teams, creates specialist workspaces or git worktrees, assigns tasks, and reviews organization structure.
          </div>
        </div>

        <div className="agents-surface-actions">
          {sessions.length > 0 && (
            <button
              type="button"
              className="agent-btn secondary"
              disabled={busy}
              onClick={() =>
                onOpenManagerChat?.({
                  runtimeSessionId: sessions[0].runtimeSessionId,
                  resumeLatest: true,
                })
              }
            >
              <MessageSquare size={14} aria-hidden="true" />
              <span>Open Latest Conversation</span>
            </button>
          )}
          <button
            type="button"
            className="agent-btn primary"
            disabled={busy}
            onClick={() => onOpenManagerChat?.({ forceNew: true })}
          >
            <Plus size={14} aria-hidden="true" />
            <span>New Conversation with Manager</span>
          </button>
        </div>
      </div>

      <div className="agents-surface-main panel-scroll">
        <div className="bg-grid">
          <section className="bg-card" aria-label="Manager conversations">
            <div className="bg-card-head">
              <MessageSquare size={15} aria-hidden="true" />
              <h3>Manager Conversations ({sessions.length})</h3>
              <button
                type="button"
                className="agent-btn ghost xs"
                disabled={busy}
                onClick={() => onOpenManagerChat?.({ forceNew: true })}
              >
                <Plus size={12} aria-hidden="true" />
                <span>New conversation</span>
              </button>
            </div>

            {sessions.length === 0 ? (
              <div className="org-member-session-empty">
                <span>
                  No conversations with the Manager yet. Start a conversation to design a team, add members, or coordinate work across workspaces.
                </span>
                <button
                  type="button"
                  className="agent-btn primary sm"
                  disabled={busy}
                  onClick={() => onOpenManagerChat?.({ forceNew: true })}
                >
                  <Sparkles size={13} aria-hidden="true" />
                  <span>Start Manager Conversation</span>
                </button>
              </div>
            ) : (
              <div className="org-member-session-list">
                {sessions.map((sess) => (
                  <div key={sess.runtimeSessionId} className="org-member-session-row">
                    {renamingId === sess.runtimeSessionId ? (
                      <form
                        className="org-session-rename-form"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          await onRenameSession?.(sess.runtimeSessionId, renameDraft);
                          setRenamingId("");
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
                          onClick={() => setRenamingId("")}
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
                            onOpenManagerChat?.({ runtimeSessionId: sess.runtimeSessionId })
                          }
                        >
                          <span className={`agent-status-dot tone-${sess.tone}`} />
                          <span className="org-member-session-title">{sess.title}</span>
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
                              setRenamingId(sess.runtimeSessionId);
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
                            onClick={() => onDeleteSession?.(sess.runtimeSessionId)}
                          >
                            <Trash2 size={11} aria-hidden="true" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="bg-card" aria-label="Teams overview">
            <div className="bg-card-head">
              <Users size={15} aria-hidden="true" />
              <h3>Active Teams ({teamSummaries.length})</h3>
              <button
                type="button"
                className="agent-btn secondary xs"
                onClick={() => setNewTeamOpen((prev) => !prev)}
              >
                <Plus size={12} aria-hidden="true" />
                <span>Create Team</span>
              </button>
            </div>

            {newTeamOpen && (
              <form className="org-member-edit-form" onSubmit={handleCreateTeam}>
                <div className="org-form-grid">
                  <label>
                    <span>Team Name</span>
                    <input
                      type="text"
                      required
                      value={newTeamName}
                      onChange={(e) => setNewTeamName(e.target.value)}
                      placeholder="e.g. core-platform"
                      autoFocus
                    />
                  </label>
                  <label>
                    <span>Default Workspace Root (Optional)</span>
                    <input
                      type="text"
                      value={newTeamRoot}
                      onChange={(e) => setNewTeamRoot(e.target.value)}
                      placeholder="Directory for new member folders"
                    />
                  </label>
                </div>
                <div className="org-form-actions">
                  <button
                    type="button"
                    className="agent-btn ghost sm"
                    onClick={() => setNewTeamOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="agent-btn primary sm"
                    disabled={busy || !newTeamName.trim()}
                  >
                    Create Team
                  </button>
                </div>
              </form>
            )}

            {teamSummaries.length === 0 ? (
              <p className="bg-empty-note">
                No teams created yet. Click &ldquo;Create Team&rdquo; above or ask the Manager to set one up.
              </p>
            ) : (
              <div className="bg-run-list">
                {teamSummaries.map(({ team, leader, counts }) => (
                  <div key={team.id} className="bg-run-row">
                    <div className="bg-run-info">
                      <div className="bg-run-top">
                        <span className={`agent-status-pill tone-${team.tone || "idle"}`}>
                          <span className="agent-status-dot" />
                          <span>{team.status || "Idle"}</span>
                        </span>
                        <strong>{team.name}</strong>
                        {leader && (
                          <span className="agents-header-badge">
                            <Crown size={11} aria-hidden="true" />
                            <span>{leader.name}</span>
                          </span>
                        )}
                      </div>
                      <div className="bg-run-meta">
                        <span>{counts.members} member(s)</span>
                        <span>{counts.sessions || 0} conversation(s)</span>
                        <span>{counts.tasksTotal} task(s)</span>
                      </div>
                    </div>
                    <div className="bg-run-actions">
                      <button
                        type="button"
                        className="agent-btn secondary sm"
                        onClick={() => onOpenTeam?.(team.id, "organization")}
                      >
                        <Network size={13} aria-hidden="true" />
                        <span>Organization</span>
                      </button>
                      <button
                        type="button"
                        className="agent-btn ghost sm"
                        onClick={() => onOpenTeam?.(team.id, "tasks")}
                      >
                        <ListChecks size={13} aria-hidden="true" />
                        <span>Tasks ({counts.tasksTotal})</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
