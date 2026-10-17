import { useState } from "react";
import {
  Activity,
  Check,
  FileCode2,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  Square,
  Terminal,
} from "lucide-react";

export function BackgroundView({
  snapshot,
  connection = "connected",
  service = null,
  busy = false,
  onRefresh,
  onRestartService,
  onStopServices,
  onCancelRun,
  onResolveRun,
  onReadLog,
  onOpenTask,
  onOpenSession,
}) {
  const [logView, setLogView] = useState(null); // { target, path, lines }
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const live = Array.isArray(snapshot?.live) ? snapshot.live : [];
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];

  const activeRuns = runs.filter(
    (r) => r.status === "starting" || r.status === "running" || r.status === "unknown",
  );
  const recentRuns = runs
    .filter((r) => r.status !== "starting" && r.status !== "running" && r.status !== "unknown")
    .slice(-10)
    .reverse();

  async function handleOpenLog(target) {
    if (logView?.target === target) {
      setLogView(null);
      return;
    }
    try {
      const res = await onReadLog?.(target);
      setLogView({
        target,
        path: res?.path || "",
        lines: Array.isArray(res?.lines) ? res.lines : [],
      });
    } catch (error) {
      setLogView({
        target,
        path: "",
        lines: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  return (
    <div className="agents-surface">
      <div className="agents-surface-header">
        <div className="agents-surface-title-block">
          <div className="agents-surface-title-row">
            <h2 className="agents-surface-title">Background &amp; Runtime</h2>
            <span className={`agent-status-pill tone-${connection === "connected" ? "completed" : "attention"}`}>
              <span className="agent-status-dot" />
              <span>{connection}</span>
            </span>
          </div>
          <div className="agents-surface-subtitle">
            Monitor active agent runs, shared runtime sessions, background shell jobs, and management service health.
          </div>
        </div>

        <div className="agents-surface-actions">
          <button
            type="button"
            className="agent-btn secondary sm"
            disabled={busy}
            onClick={() => void onRefresh?.()}
          >
            <RefreshCw size={13} aria-hidden="true" />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            className="agent-btn secondary sm"
            disabled={busy}
            onClick={() => void handleOpenLog("service")}
          >
            <FileCode2 size={13} aria-hidden="true" />
            <span>Service Log</span>
          </button>
          <button
            type="button"
            className="agent-btn secondary sm"
            disabled={busy}
            onClick={() => void handleOpenLog("runtime")}
          >
            <Terminal size={13} aria-hidden="true" />
            <span>Runtime Log</span>
          </button>
          <button
            type="button"
            className="agent-btn secondary sm"
            disabled={busy}
            onClick={() => void onRestartService?.()}
          >
            <RotateCw size={13} aria-hidden="true" />
            <span>Restart Service</span>
          </button>
          <button
            type="button"
            className="agent-btn danger sm"
            disabled={busy || connection === "stopped"}
            onClick={() => void onStopServices?.(true)}
          >
            <Power size={13} aria-hidden="true" />
            <span>Stop Background</span>
          </button>
        </div>
      </div>

      <div className="agents-surface-main panel-scroll">
        <div className="bg-grid">
          <section className="bg-card" aria-label="Service status">
            <div className="bg-card-head">
              <Server size={15} aria-hidden="true" />
              <h3>Management &amp; Shared Runtime</h3>
            </div>
            <dl className="bg-stat-grid">
              <div>
                <dt>Connection</dt>
                <dd>{connection}</dd>
              </div>
              <div>
                <dt>Service PID</dt>
                <dd>{service?.pid || "—"}</dd>
              </div>
              <div>
                <dt>Working Agents</dt>
                <dd>{service?.working ?? activeRuns.length}</dd>
              </div>
              <div>
                <dt>Shared Runtime PID</dt>
                <dd>{service?.runtime?.pid || "—"}</dd>
              </div>
            </dl>
          </section>

          {logView && (
            <section className="bg-card" aria-label="Diagnostic log">
              <div className="bg-card-head">
                <Terminal size={15} aria-hidden="true" />
                <h3>{logView.target === "runtime" ? "Shared Runtime Log" : "Management Service Log"}</h3>
                {logView.path && <code className="bg-log-path">{logView.path}</code>}
                <button type="button" className="agent-btn ghost xs" onClick={() => setLogView(null)}>
                  Close
                </button>
              </div>
              <pre className="bg-log-output">{logView.lines.join("\n")}</pre>
            </section>
          )}

          <section className="bg-card" aria-label="Active agent runs">
            <div className="bg-card-head">
              <Activity size={15} aria-hidden="true" />
              <h3>Active Managed Runs ({activeRuns.length})</h3>
            </div>
            {activeRuns.length === 0 ? (
              <p className="bg-empty-note">No managed task or delegation runs currently executing.</p>
            ) : (
              <div className="bg-run-list">
                {activeRuns.map((run) => {
                  const task = run.taskId ? tasks.find((t) => t.id === run.taskId) : null;
                  const assignee = task ? agents.find((a) => a.id === task.assigneeAgentId) : null;
                  return (
                    <div key={run.id} className="bg-run-row">
                      <div className="bg-run-info">
                        <div className="bg-run-top">
                          <span
                            className={`agent-status-pill tone-${
                              run.status === "unknown" ? "attention" : "working"
                            }`}
                          >
                            {run.status}
                          </span>
                          <strong>{task ? task.brief : `Delegation / Run ${run.id}`}</strong>
                        </div>
                        <div className="bg-run-meta">
                          {assignee && <span>Agent: {assignee.name}</span>}
                          {run.startedAt && <span>Started: {String(run.startedAt).slice(0, 19).replace("T", " ")}</span>}
                        </div>
                      </div>
                      <div className="bg-run-actions">
                        {task && (
                          <button
                            type="button"
                            className="agent-btn ghost sm"
                            onClick={() => onOpenTask?.(task.teamId, task.id)}
                          >
                            Inspect Task
                          </button>
                        )}
                        {run.status === "unknown" ? (
                          <button
                            type="button"
                            className="agent-btn primary sm"
                            disabled={busy}
                            onClick={() => void onResolveRun?.(run.id)}
                          >
                            <Check size={13} aria-hidden="true" />
                            <span>Confirm Stopped</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="agent-btn danger sm"
                            disabled={busy}
                            onClick={() => void onCancelRun?.(run.id)}
                          >
                            <Square size={13} aria-hidden="true" />
                            <span>Cancel Run</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="bg-card" aria-label="Live runtime sessions">
            <div className="bg-card-head">
              <Terminal size={15} aria-hidden="true" />
              <h3>Live Sessions &amp; Background Commands ({live.length})</h3>
            </div>
            {live.length === 0 ? (
              <p className="bg-empty-note">No live turns or background shell jobs running in the Shared Runtime.</p>
            ) : (
              <div className="bg-run-list">
                {live.map((session) => (
                  <div key={session.id} className="bg-run-row">
                    <div className="bg-run-info">
                      <div className="bg-run-top">
                        <span
                          className={`agent-status-pill tone-${
                            session.turn === "question"
                              ? "attention"
                              : session.turn === "running"
                                ? "working"
                                : "idle"
                          }`}
                        >
                          {session.turn}
                        </span>
                        <strong>{session.title || session.id}</strong>
                      </div>
                      <div className="bg-run-meta">
                        {session.workspace && <code>{session.workspace}</code>}
                        {session.background?.count > 0 && (
                          <span>
                            {session.background.count} background command(s):{" "}
                            {(session.background.commands || []).join(", ")}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="bg-run-actions">
                      <button
                        type="button"
                        className="agent-btn secondary sm"
                        onClick={() => onOpenSession?.(session.id)}
                      >
                        Open Conversation
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {recentRuns.length > 0 && (
            <section className="bg-card" aria-label="Recent runs">
              <div className="bg-card-head">
                <h3>Recent Completed Runs</h3>
              </div>
              <div className="bg-run-list compact">
                {recentRuns.map((run) => {
                  const task = run.taskId ? tasks.find((t) => t.id === run.taskId) : null;
                  return (
                    <div key={run.id} className="bg-run-row">
                      <div className="bg-run-info">
                        <div className="bg-run-top">
                          <span
                            className={`agent-status-pill tone-${
                              run.status === "succeeded"
                                ? "completed"
                                : run.status === "failed"
                                  ? "attention"
                                  : "idle"
                            }`}
                          >
                            {run.status}
                          </span>
                          <span>{task ? task.brief : `Run ${run.id}`}</span>
                        </div>
                      </div>
                      {task && (
                        <button
                          type="button"
                          className="agent-btn ghost xs"
                          onClick={() => onOpenTask?.(task.teamId, task.id)}
                        >
                          View Task
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
