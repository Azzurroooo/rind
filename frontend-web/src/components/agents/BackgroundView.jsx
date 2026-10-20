import { useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  MessageSquare,
  MoreHorizontal,
  Power,
  RefreshCw,
  RotateCw,
  Square,
} from "lucide-react";
import { Menu } from "../overlays/Menu.jsx";
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
  onOpenTask,
  onOpenSession,
}) {
  const model = useMemo(
    () => backgroundModel || buildBackgroundModel(snapshot, service),
    [backgroundModel, snapshot, service],
  );
  const runningNow = model.runningNow || [];
  const unconfirmedRuns = model.unconfirmedRuns || [];

  return (
    <div className="agents-surface">
      <div className="agents-surface-header">
        <div className="agents-surface-title-block">
          <div className="agents-surface-title-row">
            <h2 className="agents-surface-title">Background</h2>
            <span className={`agent-status-pill tone-${connection === "connected" ? "completed" : "attention"}`}>
              <span className="agent-status-dot" />
              <span>{connection}</span>
            </span>
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
          <Menu
            label="Service actions"
            items={[
              {
                id: "bg-restart",
                label: "Restart Service",
                icon: <RotateCw size={14} />,
                onSelect: () => void onRestartService?.(),
              },
              {
                id: "bg-stop",
                label: "Stop Background",
                icon: <Power size={14} />,
                danger: true,
                disabled: busy || connection === "stopped",
                onSelect: () => void onStopServices?.(true),
              },
            ]}
            trigger={(props) => (
              <button
                type="button"
                className="icon-button"
                aria-label="Service actions"
                title="Service actions"
                disabled={busy}
                {...props}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
            )}
          />
        </div>
      </div>

      <div className="agents-surface-main panel-scroll">
        <div className="bg-grid">
          <div className="bg-health-strip" role="region" aria-label="Services">
            <div className="bg-health-item">
              <span className={`agent-status-dot tone-${connection === "connected" ? "completed" : "attention"}`} />
              <strong>Management Service</strong>
              <span className="agents-header-meta">
                {connection === "connected"
                  ? `Running${service?.pid ? ` · pid ${service.pid}` : ""}`
                  : connection}
              </span>
            </div>
            <div className="bg-health-item">
              <span className={`agent-status-dot tone-${service?.runtime?.status === "running" ? "completed" : "idle"}`} />
              <strong>Shared Runtime</strong>
              <span className="agents-header-meta">
                {service?.runtime?.status === "running"
                  ? `Running${service.runtime.pid ? ` · pid ${service.runtime.pid}` : ""}`
                  : service?.runtime?.status || (connection === "connected" ? "Ready on demand" : "Stopped")}
              </span>
            </div>
            <div className="bg-health-item">
              <span className="agents-header-meta">
                {service?.working ?? runningNow.length} working · {service?.tasks ?? 0} tasks · {service?.conversations ?? 0} sessions
              </span>
            </div>
          </div>

          <section className="bg-card" aria-label="Running now">
            <div className="bg-card-head">
              <Activity size={15} aria-hidden="true" />
              <h3>Running Now ({runningNow.length})</h3>
            </div>
            {runningNow.length === 0 ? (
              <p className="bg-empty-note">Nothing running in the background right now.</p>
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
                          <span>Chat</span>
                        </button>
                      )}
                      {item.teamId && item.taskId && (
                        <button
                          type="button"
                          className="agent-btn ghost sm"
                          onClick={() => onOpenTask?.(item.teamId, item.taskId)}
                        >
                          <span>Inspect</span>
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
                          <span>Stop</span>
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
                          Inspect
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
        </div>
      </div>
    </div>
  );
}
