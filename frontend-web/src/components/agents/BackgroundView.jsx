import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  FileCode2,
  MessageSquare,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  Square,
  Terminal,
} from "lucide-react";
import { buildBackgroundModel } from "../../lib/agentsModel.js";

export function BackgroundView({
  snapshot,
  backgroundModel,
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

  const model = useMemo(
    () => backgroundModel || buildBackgroundModel(snapshot, service),
    [backgroundModel, snapshot, service],
  );
  const runningNow = model.runningNow || [];
  const unconfirmedRuns = model.unconfirmedRuns || [];

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
            Running agent turns, managed task &amp; delegation runs, background shell commands, and Shared Runtime status.
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
          <section className="bg-card" aria-label="Running now">
            <div className="bg-card-head">
              <Activity size={15} aria-hidden="true" />
              <h3>Running Now ({runningNow.length})</h3>
            </div>
            {runningNow.length === 0 ? (
              <p className="bg-empty-note">
                Nothing running in the background right now. Active agent turns, delegated tasks, and background bash commands will appear here.
              </p>
            ) : (
              <div className="bg-run-list">
                {runningNow.map((item) => (
                  <div key={item.id} className="bg-run-row">
                    <div className="bg-run-info">
                      <div className="bg-run-top">
                        <span className={`agent-status-pill tone-${item.tone}`}>
                          <span className="agent-status-dot" />
                          <span>{item.status}</span>
                        </span>
                        <strong>{item.title}</strong>
                        <span className="bg-run-scope">{item.scopeLabel}</span>
                      </div>
                      <div className="bg-run-meta">
                        {item.jobSummary && <span>{item.jobSummary}</span>}
                        {item.ageText && <span>{item.ageText}</span>}
                      </div>
                    </div>
                    <div className="bg-run-actions">
                      {item.runtimeSessionId && (
                        <button
                          type="button"
                          className="agent-btn secondary sm"
                          onClick={() => onOpenSession?.(item.runtimeSessionId, item)}
                        >
                          <MessageSquare size={13} aria-hidden="true" />
                          <span>Open Conversation</span>
                        </button>
                      )}
                      {item.teamId && item.taskId && (
                        <button
                          type="button"
                          className="agent-btn ghost sm"
                          onClick={() => onOpenTask?.(item.teamId, item.taskId)}
                        >
                          <span>Inspect Task</span>
                        </button>
                      )}
                      {item.runId && (
                        <button
                          type="button"
                          className="agent-btn danger sm"
                          disabled={busy}
                          onClick={() => void onCancelRun?.(item.runId)}
                        >
                          <Square size={13} aria-hidden="true" />
                          <span>Stop Run</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {unconfirmedRuns.length > 0 && (
            <section className="bg-card" aria-label="Unconfirmed runs">
              <div className="bg-card-head">
                <AlertTriangle size={15} aria-hidden="true" />
                <h3>Unconfirmed Runs ({unconfirmedRuns.length})</h3>
              </div>
              <p className="bg-empty-note">
                These runs were active before the management service lost contact with the host. Confirm whether they have stopped to unblock their member queues.
              </p>
              <div className="bg-run-list">
                {unconfirmedRuns.map((run) => (
                  <div key={run.id} className="bg-run-row">
                    <div className="bg-run-info">
                      <div className="bg-run-top">
                        <span className="agent-status-pill tone-attention">Unconfirmed</span>
                        <strong>{run.title}</strong>
                        <span className="bg-run-scope">{run.scopeLabel}</span>
                      </div>
                      <div className="bg-run-meta">
                        {run.ageText && <span>Started {run.ageText}</span>}
                      </div>
                    </div>
                    <div className="bg-run-actions">
                      {run.teamId && run.taskId && (
                        <button
                          type="button"
                          className="agent-btn ghost sm"
                          onClick={() => onOpenTask?.(run.teamId, run.taskId)}
                        >
                          Inspect Task
                        </button>
                      )}
                      <button
                        type="button"
                        className="agent-btn primary sm"
                        disabled={busy}
                        onClick={() => void onResolveRun?.(run.runId)}
                      >
                        <Check size={13} aria-hidden="true" />
                        <span>Confirm Stopped</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="bg-card" aria-label="Services">
            <div className="bg-card-head">
              <Server size={15} aria-hidden="true" />
              <h3>Services</h3>
            </div>
            <dl className="bg-stat-grid">
              <div>
                <dt>Management Service</dt>
                <dd>
                  {connection === "connected"
                    ? `Running${service?.pid ? ` · pid ${service.pid}` : ""}`
                    : connection}
                </dd>
              </div>
              <div>
                <dt>Shared Runtime</dt>
                <dd>
                  {service?.runtime?.status === "running"
                    ? `Running${service.runtime.pid ? ` · pid ${service.runtime.pid}` : ""}`
                    : service?.runtime?.status || (connection === "connected" ? "Ready on demand" : "Stopped")}
                </dd>
              </div>
              <div>
                <dt>Working Agents</dt>
                <dd>{service?.working ?? runningNow.length}</dd>
              </div>
              <div>
                <dt>Active Tasks / Sessions</dt>
                <dd>
                  {service?.tasks ?? 0} task(s) · {service?.conversations ?? 0} attached session(s)
                </dd>
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
        </div>
      </div>
    </div>
  );
}
