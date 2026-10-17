import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  FileText,
  MessageSquare,
  Play,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react";

export function TaskReportDrawer({
  task,
  onClose,
  onStartTask,
  onCancelTask,
  onCancelRun,
  onResolveRun,
  onSetPriority,
  onReviewTask,
  onPostNote,
  onReadArtifact,
  onOpenChat,
  busy = false,
}) {
  const [blockerAnswer, setBlockerAnswer] = useState("");
  const [noteText, setNoteText] = useState("");
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkFeedback, setReworkFeedback] = useState("");
  const [artifactPreview, setArtifactPreview] = useState(null); // { id, name, content, path, loading, error }

  if (!task) return null;

  const isUserBlocked = task.status === "blocked" && task.blockedOn?.responder === "user";
  const canReview = task.status === "done" && Boolean(task.report) && !task.review;
  const canStart = task.status === "queued" || task.status === "needs_attention";
  const activeRun =
    task.activeRun &&
    (task.activeRun.status === "starting" ||
      task.activeRun.status === "running" ||
      task.activeRun.status === "unknown")
      ? task.activeRun
      : null;
  const canCancelTask = !activeRun && (task.status === "queued" || task.status === "blocked" || task.status === "needs_attention");

  async function handlePreviewArtifact(artifact) {
    if (artifactPreview?.id === artifact.id) {
      setArtifactPreview(null);
      return;
    }
    setArtifactPreview({ id: artifact.id, name: artifact.name, loading: true });
    try {
      const result = await onReadArtifact?.(artifact.id);
      setArtifactPreview({
        id: artifact.id,
        name: artifact.name || result?.name || "Artifact",
        path: result?.path || artifact.file || "",
        content: result?.content ?? (result?.binary ? "[Binary artifact]" : ""),
        truncated: Boolean(result?.truncated),
        loading: false,
      });
    } catch (error) {
      setArtifactPreview({
        id: artifact.id,
        name: artifact.name,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <aside className="task-drawer" aria-label="Task details">
      <div className="task-drawer-head">
        <div className="task-drawer-title-group">
          <span className={`agent-status-pill tone-${task.tone}`}>{task.statusLabel}</span>
          <span className="task-drawer-meta">
            {task.teamName ? `${task.teamName} › ` : ""}
            {task.assigneeName} ({task.assigneePosition})
          </span>
        </div>
        <button type="button" className="icon-button" aria-label="Close task details" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="task-drawer-body panel-scroll">
        <div className="task-drawer-section">
          <h3 className="task-drawer-brief">{task.brief}</h3>
          <div className="task-drawer-controls">
            {task.status === "queued" ? (
              <label className="task-priority-label">
                <span>Priority</span>
                <select
                  value={task.priority || "normal"}
                  disabled={busy}
                  aria-label="Task priority"
                  onChange={(e) => void onSetPriority?.(task.id, e.target.value)}
                >
                  <option value="high">High</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                </select>
              </label>
            ) : (
              <span className={`task-priority-chip ${task.priority || "normal"}`}>
                Priority: {task.priority || "normal"}
              </span>
            )}
            <div className="task-drawer-action-row">
              {canStart && (
                <button
                  type="button"
                  className="agent-btn primary sm"
                  disabled={busy}
                  onClick={() => void onStartTask?.(task.id)}
                >
                  <Play size={13} aria-hidden="true" />
                  <span>{task.status === "needs_attention" ? "Retry / Resume" : "Start now"}</span>
                </button>
              )}
              {activeRun?.status === "unknown" && onResolveRun && (
                <button
                  type="button"
                  className="agent-btn primary sm"
                  disabled={busy}
                  onClick={() => void onResolveRun(activeRun.id)}
                >
                  <Check size={13} aria-hidden="true" />
                  <span>Confirm stopped</span>
                </button>
              )}
              {(activeRun?.status === "starting" || activeRun?.status === "running") && onCancelRun && (
                <button
                  type="button"
                  className="agent-btn danger sm"
                  disabled={busy}
                  onClick={() => void onCancelRun(activeRun.id)}
                >
                  <Square size={13} aria-hidden="true" />
                  <span>Stop run</span>
                </button>
              )}
              {canCancelTask && (
                <button
                  type="button"
                  className="agent-btn danger sm"
                  disabled={busy}
                  onClick={() => void onCancelTask?.(task.id)}
                >
                  <Square size={13} aria-hidden="true" />
                  <span>Cancel task</span>
                </button>
              )}
              <button
                type="button"
                className="agent-btn secondary sm"
                disabled={busy}
                onClick={() =>
                  void onOpenChat?.({
                    teamId: task.teamId,
                    agentId: task.assigneeAgentId,
                    runtimeSessionId: task.runtimeSessionId,
                    resumeLatest: !task.runtimeSessionId,
                  })
                }
              >
                <MessageSquare size={13} aria-hidden="true" />
                <span>{task.runtimeSessionId ? "Open task session" : `Chat with ${task.assigneeName}`}</span>
              </button>
            </div>
          </div>
        </div>

        {isUserBlocked && (
          <div className="task-blocker-card" role="region" aria-label="Blocker requiring your input">
            <div className="task-blocker-head">
              <AlertTriangle size={15} aria-hidden="true" />
              <strong>Waiting on your answer</strong>
            </div>
            <p className="task-blocker-prompt">{task.blockedOn?.action}</p>
            <form
              className="task-inline-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const text = blockerAnswer.trim();
                if (!text) return;
                await onPostNote?.(task.id, text, true);
                setBlockerAnswer("");
              }}
            >
              <input
                type="text"
                value={blockerAnswer}
                onChange={(e) => setBlockerAnswer(e.target.value)}
                placeholder="Write your decision or answer to unblock this agent…"
                aria-label="Blocker answer"
              />
              <button type="submit" className="agent-btn primary sm" disabled={busy || !blockerAnswer.trim()}>
                <Send size={13} aria-hidden="true" />
                <span>Answer &amp; Resume</span>
              </button>
            </form>
          </div>
        )}

        {task.status === "blocked" && task.blockedOn?.responder !== "user" && task.blockedSummary && (
          <div className="task-error-banner">
            <strong>Sub-delegation in progress:</strong> {task.blockedSummary}
          </div>
        )}

        {task.error && (
          <div className="task-error-banner">
            <strong>Run issue:</strong> {task.error}
          </div>
        )}

        {task.report && (
          <div className="task-report-card" role="region" aria-label="Task delivery report">
            <div className="task-report-header">
              <span className="task-section-kicker">Delivery Report</span>
              {task.report.outcome && <span className="task-outcome-pill">{task.report.outcome}</span>}
            </div>
            <p className="task-report-summary">{task.report.summary}</p>

            {Array.isArray(task.report.evidence) && task.report.evidence.length > 0 && (
              <div className="task-report-block">
                <h4>Evidence &amp; Verification</h4>
                <ul className="task-evidence-list">
                  {task.report.evidence.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {(task.artifactRecords?.length > 0 || task.report.artifacts?.length > 0) && (
              <div className="task-report-block">
                <h4>Published Files &amp; Artifacts</h4>
                <div className="task-artifact-list">
                  {(task.artifactRecords?.length > 0
                    ? task.artifactRecords
                    : (task.report.artifacts || []).map((name, idx) => ({ id: `${task.id}-${idx}`, name, file: name }))
                  ).map((artifact) => (
                    <div key={artifact.id} className="task-artifact-item">
                      <button
                        type="button"
                        className="task-artifact-btn"
                        onClick={() => void handlePreviewArtifact(artifact)}
                      >
                        <FileText size={13} aria-hidden="true" />
                        <span className="task-artifact-name">{artifact.name}</span>
                        {artifact.size != null && (
                          <span className="task-artifact-size">
                            {Math.max(1, Math.round(Number(artifact.size) / 1024))} KB
                          </span>
                        )}
                      </button>
                      {artifactPreview?.id === artifact.id && (
                        <div className="task-artifact-preview">
                          {artifactPreview.loading ? (
                            <div className="task-artifact-status">Loading artifact preview…</div>
                          ) : artifactPreview.error ? (
                            <div className="task-artifact-status error">{artifactPreview.error}</div>
                          ) : (
                            <>
                              {artifactPreview.path && (
                                <div className="task-artifact-path">{artifactPreview.path}</div>
                              )}
                              <pre className="task-artifact-code">
                                {artifactPreview.content || "(Empty file)"}
                              </pre>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {task.report.nextAction && (
              <div className="task-report-block">
                <h4>Recommended Next Step</h4>
                <p className="task-report-next">{task.report.nextAction}</p>
              </div>
            )}

            {canReview && (
              <div className="task-review-bar">
                <div className="task-review-buttons">
                  <button
                    type="button"
                    className="agent-btn primary"
                    disabled={busy}
                    onClick={() => void onReviewTask?.(task.id, "accept")}
                  >
                    <CheckCircle2 size={14} aria-hidden="true" />
                    <span>Accept delivery</span>
                  </button>
                  <button
                    type="button"
                    className="agent-btn secondary"
                    disabled={busy}
                    onClick={() => setReworkOpen((prev) => !prev)}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    <span>Send for rework</span>
                  </button>
                </div>
                {reworkOpen && (
                  <form
                    className="task-rework-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const feedback = reworkFeedback.trim();
                      if (!feedback) return;
                      await onReviewTask?.(task.id, "rework", feedback);
                      setReworkFeedback("");
                      setReworkOpen(false);
                    }}
                  >
                    <textarea
                      rows={3}
                      value={reworkFeedback}
                      onChange={(e) => setReworkFeedback(e.target.value)}
                      placeholder="Explain what needs to be revised…"
                      aria-label="Rework feedback"
                    />
                    <div className="task-rework-actions">
                      <button type="button" className="agent-btn ghost sm" onClick={() => setReworkOpen(false)}>
                        Cancel
                      </button>
                      <button type="submit" className="agent-btn primary sm" disabled={busy || !reworkFeedback.trim()}>
                        Confirm rework
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {task.review && (
              <div className={`task-reviewed-banner ${task.review.decision}`}>
                <strong>
                  {task.review.decision === "accepted" ? "Delivery accepted" : "Sent back for rework"}
                </strong>
                {task.review.feedback && <p>{task.review.feedback}</p>}
              </div>
            )}
          </div>
        )}

        <div className="task-drawer-section">
          <span className="task-section-kicker">Notes &amp; Guidance ({task.notes?.length || 0})</span>
          {task.notes?.length > 0 ? (
            <ul className="task-notes-list">
              {task.notes.map((note) => (
                <li key={note.id} className="task-note-item">
                  <div className="task-note-meta">
                    <strong>{note.author || "user"}</strong>
                    {note.createdAt && <span>{String(note.createdAt).slice(0, 19).replace("T", " ")}</span>}
                  </div>
                  <p className="task-note-text">{note.text}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="task-notes-empty">No task notes yet.</p>
          )}
          <form
            className="task-inline-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const text = noteText.trim();
              if (!text) return;
              await onPostNote?.(task.id, text, false);
              setNoteText("");
            }}
          >
            <input
              type="text"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add a note or guidance to this task…"
              aria-label="Add task note"
            />
            <button type="submit" className="agent-btn secondary sm" disabled={busy || !noteText.trim()}>
              <Send size={13} aria-hidden="true" />
              <span>Post note</span>
            </button>
          </form>
        </div>

        {Array.isArray(task.runs) && task.runs.length > 0 && (
          <div className="task-drawer-section">
            <span className="task-section-kicker">
              <Activity size={11} aria-hidden="true" /> Runs ({task.runs.length})
            </span>
            <ul className="task-notes-list">
              {task.runs.map((run) => (
                <li key={run.id} className="task-note-item">
                  <div className="task-note-meta">
                    <strong>{run.status}</strong>
                    {run.startedAt && <span>{String(run.startedAt).slice(0, 19).replace("T", " ")}</span>}
                  </div>
                  {run.error && <p className="task-note-text">{run.error}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
