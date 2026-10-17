import { Crown, ExternalLink, Kanban, MessageSquare, Network, Sparkles } from "lucide-react";

export function TeamTab({
  agentContext,
  teamSummary,
  teamTasks,
  onOpenTeam,
  onSelectTask,
  onOpenChat,
  onOpenManager,
}) {
  const team = teamSummary?.team;
  const members = teamSummary?.members || [];
  const activeTasks = (teamTasks?.all || []).filter((t) => t.column !== "completed").slice(0, 8);

  if (!team && agentContext?.kind !== "manager") {
    return (
      <div className="inspector-body">
        <div className="activity-empty">
          <Network className="activity-empty-icon" aria-hidden="true" />
          <h3>No team context</h3>
          <p>Select a team in the sidebar or talk with the Manager to create and coordinate multi-agent teams.</p>
          {onOpenManager && (
            <button type="button" className="agent-btn primary sm" onClick={onOpenManager}>
              <Sparkles size={13} aria-hidden="true" />
              <span>Chat with Manager</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="inspector-body">
      {agentContext?.kind === "manager" && (
        <section className="inspector-section">
          <div className="inspector-section-head">
            <span className="inspector-section-title">Active Agent</span>
            <span className="agent-status-pill tone-working">Coordinator</span>
          </div>
          <div className="inspector-team-card">
            <strong>Manager</strong>
            <p className="section-hint">
              Coordinates teams, structures reporting hierarchies, assigns briefs, and reviews specialist deliveries.
            </p>
          </div>
        </section>
      )}

      {agentContext?.kind === "member" && (
        <section className="inspector-section">
          <div className="inspector-section-head">
            <span className="inspector-section-title">Active Member</span>
            <span className="agent-status-pill tone-working">{agentContext.status || "Active"}</span>
          </div>
          <div className="inspector-team-card">
            <div className="inspector-team-card-top">
              <strong>{agentContext.agentName}</strong>
              <span className="org-role-pill">{agentContext.roleLabel}</span>
            </div>
            <p className="section-hint">Team: {agentContext.teamName}</p>
          </div>
        </section>
      )}

      {team && (
        <>
          <section className="inspector-section">
            <div className="inspector-section-head">
              <span className="inspector-section-title">Team · {team.name}</span>
              <div className="inspector-team-links">
                <button
                  type="button"
                  className="agent-btn ghost xs"
                  onClick={() => onOpenTeam?.(team.id, "organization")}
                >
                  <Network size={12} aria-hidden="true" />
                  <span>Org</span>
                </button>
                <button
                  type="button"
                  className="agent-btn ghost xs"
                  onClick={() => onOpenTeam?.(team.id, "tasks")}
                >
                  <Kanban size={12} aria-hidden="true" />
                  <span>Tasks</span>
                </button>
              </div>
            </div>
            <dl className="stat-list">
              <div className="stat-row">
                <dt>Leader</dt>
                <dd>{teamSummary.leader ? teamSummary.leader.name : "Unassigned"}</dd>
              </div>
              <div className="stat-row">
                <dt>Members</dt>
                <dd>{teamSummary.counts.members}</dd>
              </div>
              <div className="stat-row">
                <dt>Active / Queued Tasks</dt>
                <dd>{teamSummary.counts.tasksInProgress + teamSummary.counts.tasksQueued}</dd>
              </div>
              <div className="stat-row">
                <dt>Awaiting Review / Input</dt>
                <dd>{teamSummary.counts.tasksAttention}</dd>
              </div>
            </dl>
          </section>

          <section className="inspector-section">
            <div className="inspector-section-head">
              <span className="inspector-section-title">Roster ({members.length})</span>
            </div>
            <ul className="inspector-roster-list">
              {members.map((member) => (
                <li key={member.agentId} className="inspector-roster-row">
                  <div className="inspector-roster-main">
                    <span className={`agent-status-dot tone-${member.tone}`} />
                    <span className="inspector-roster-name">{member.name}</span>
                    {member.isLeader && <Crown size={11} className="inspector-leader-icon" aria-hidden="true" />}
                    <span className="inspector-roster-role">{member.position}</span>
                  </div>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`Chat with ${member.name}`}
                    title={`Chat with ${member.name}`}
                    onClick={() =>
                      onOpenChat?.({
                        teamId: team.id,
                        agentId: member.agentId,
                        runtimeSessionId: member.latestRuntimeSessionId,
                      })
                    }
                  >
                    <MessageSquare size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="inspector-section">
            <div className="inspector-section-head">
              <span className="inspector-section-title">Open Team Tasks ({activeTasks.length})</span>
            </div>
            {activeTasks.length === 0 ? (
              <p className="section-hint">No open tasks in this team.</p>
            ) : (
              <ul className="inspector-task-mini-list">
                {activeTasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="inspector-task-mini-btn"
                      onClick={() => onSelectTask?.(team.id, task.id)}
                    >
                      <span className={`agent-status-pill tone-${task.tone}`}>{task.statusLabel}</span>
                      <span className="inspector-task-mini-brief">{task.brief}</span>
                      <ExternalLink size={11} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
