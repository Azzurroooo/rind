import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ExternalLink,
  Inbox,
  MessageSquare,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  X,
} from "lucide-react";

export function InboxView({
  items = [],
  busy = false,
  onResolveApproval,
  onAnswerBlocker,
  onStartTask,
  onReviewTask,
  onResolveRun,
  onDismissNotice,
  onOpenTask,
  onOpenTeam,
  onOpenChat,
}) {
  const [filter, setFilter] = useState("all"); // "all" | "action" | "deliveries" | "notices"
  const [answers, setAnswers] = useState({});
  const [reworkOpenId, setReworkOpenId] = useState("");
  const [reworkFeedback, setReworkFeedback] = useState("");

  const filtered = useMemo(() => {
    if (filter === "action") {
      return items.filter(
        (i) => i.kind === "approval" || i.kind === "blocker" || i.kind === "attention" || i.kind === "unconfirmed_run",
      );
    }
    if (filter === "deliveries") {
      return items.filter((i) => i.kind === "delivery");
    }
    if (filter === "notices") {
      return items.filter((i) => i.kind === "notice");
    }
    return items;
  }, [items, filter]);

  return (
    <div className="agents-surface">
      <div className="agents-surface-header">
        <div className="agents-surface-title-block">
          <div className="agents-surface-title-row">
            <h2 className="agents-surface-title">Inbox &amp; Triage</h2>
            <span className="agents-header-meta">
              {items.length === 0
                ? "All caught up"
                : `${items.length} ${items.length === 1 ? "item requires" : "items require"} your attention`}
            </span>
          </div>
          <div className="agents-surface-subtitle">
            Approvals, blockers waiting on your decision, and completed task deliveries ready for acceptance.
          </div>
        </div>

        <div className="agents-surface-actions">
          <div className="agents-segmented" role="tablist" aria-label="Inbox filter">
            <button
              type="button"
              role="tab"
              aria-selected={filter === "all"}
              className={`agents-seg-btn ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              <span>All</span>
              {items.length > 0 && <span className="agents-seg-count">{items.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === "action"}
              className={`agents-seg-btn ${filter === "action" ? "active" : ""}`}
              onClick={() => setFilter("action")}
            >
              <span>Blockers &amp; Approvals</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === "deliveries"}
              className={`agents-seg-btn ${filter === "deliveries" ? "active" : ""}`}
              onClick={() => setFilter("deliveries")}
            >
              <span>Deliveries</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === "notices"}
              className={`agents-seg-btn ${filter === "notices" ? "active" : ""}`}
              onClick={() => setFilter("notices")}
            >
              <span>Notices</span>
            </button>
          </div>
        </div>
      </div>

      <div className="agents-surface-main panel-scroll">
        {filtered.length === 0 ? (
          <div className="agents-empty-hero">
            <Inbox size={28} aria-hidden="true" />
            <h3>Inbox zero</h3>
            <p>No pending approvals, blocked agents, or unreviewed task deliveries right now.</p>
          </div>
        ) : (
          <div className="inbox-card-list" role="list">
            {filtered.map((item) => (
              <div key={item.id} className={`inbox-card kind-${item.kind}`} role="listitem">
                <div className="inbox-card-top">
                  <span className={`agent-status-pill tone-${item.tone}`}>
                    {item.kind === "approval" && <ShieldAlert size={12} aria-hidden="true" />}
                    {(item.kind === "blocker" || item.kind === "attention" || item.kind === "unconfirmed_run") && (
                      <AlertTriangle size={12} aria-hidden="true" />
                    )}
                    {item.kind === "delivery" && <CheckCircle2 size={12} aria-hidden="true" />}
                    {item.kind === "notice" && <Bell size={12} aria-hidden="true" />}
                    <span>{item.badge}</span>
                  </span>
                  {item.subtitle && <span className="inbox-card-subtitle">{item.subtitle}</span>}
                </div>

                <h3 className="inbox-card-title">{item.title}</h3>
                {item.detail && <p className="inbox-card-detail">{item.detail}</p>}

                {item.kind === "approval" && (
                  <div className="inbox-card-actions">
                    <button
                      type="button"
                      className="agent-btn primary sm"
                      disabled={busy}
                      onClick={() => void onResolveApproval?.(item.approvalId, true)}
                    >
                      <Check size={13} aria-hidden="true" />
                      <span>Approve</span>
                    </button>
                    <button
                      type="button"
                      className="agent-btn secondary sm"
                      disabled={busy}
                      onClick={() => void onResolveApproval?.(item.approvalId, false)}
                    >
                      <X size={13} aria-hidden="true" />
                      <span>Decline</span>
                    </button>
                  </div>
                )}

                {item.kind === "blocker" && (
                  <form
                    className="task-inline-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const text = (answers[item.taskId] || "").trim();
                      if (!text) return;
                      await onAnswerBlocker?.(item.taskId, text);
                      setAnswers((prev) => ({ ...prev, [item.taskId]: "" }));
                    }}
                  >
                    <input
                      type="text"
                      value={answers[item.taskId] || ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [item.taskId]: e.target.value }))}
                      placeholder="Reply to unblock this agent and resume work…"
                      aria-label={`Answer blocker for ${item.title}`}
                    />
                    <button
                      type="submit"
                      className="agent-btn primary sm"
                      disabled={busy || !(answers[item.taskId] || "").trim()}
                    >
                      <Send size={13} aria-hidden="true" />
                      <span>Answer &amp; Resume</span>
                    </button>
                    <button
                      type="button"
                      className="agent-btn ghost sm"
                      onClick={() => onOpenTask?.(item.teamId, item.taskId)}
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      <span>Inspect Task</span>
                    </button>
                  </form>
                )}

                {item.kind === "attention" && (
                  <div className="inbox-card-actions">
                    <button
                      type="button"
                      className="agent-btn primary sm"
                      disabled={busy}
                      onClick={() => void onStartTask?.(item.taskId)}
                    >
                      <Play size={13} aria-hidden="true" />
                      <span>Resume Task</span>
                    </button>
                    <button
                      type="button"
                      className="agent-btn secondary sm"
                      onClick={() => onOpenTask?.(item.teamId, item.taskId)}
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      <span>Inspect Task</span>
                    </button>
                    {item.agentId && (
                      <button
                        type="button"
                        className="agent-btn ghost sm"
                        onClick={() => onOpenChat?.({ teamId: item.teamId, agentId: item.agentId })}
                      >
                        <MessageSquare size={13} aria-hidden="true" />
                        <span>Chat with Agent</span>
                      </button>
                    )}
                  </div>
                )}

                {item.kind === "delivery" && (
                  <div className="inbox-delivery-block">
                    <div className="inbox-card-actions">
                      <button
                        type="button"
                        className="agent-btn primary sm"
                        disabled={busy}
                        onClick={() => void onReviewTask?.(item.taskId, "accept")}
                      >
                        <CheckCircle2 size={13} aria-hidden="true" />
                        <span>Accept Delivery</span>
                      </button>
                      <button
                        type="button"
                        className="agent-btn secondary sm"
                        disabled={busy}
                        onClick={() =>
                          setReworkOpenId((prev) => (prev === item.taskId ? "" : item.taskId))
                        }
                      >
                        <RotateCcw size={13} aria-hidden="true" />
                        <span>Request Rework</span>
                      </button>
                      <button
                        type="button"
                        className="agent-btn ghost sm"
                        onClick={() => onOpenTask?.(item.teamId, item.taskId)}
                      >
                        <ExternalLink size={13} aria-hidden="true" />
                        <span>Full Report</span>
                      </button>
                    </div>
                    {reworkOpenId === item.taskId && (
                      <form
                        className="task-inline-form"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const feedback = reworkFeedback.trim();
                          if (!feedback) return;
                          await onReviewTask?.(item.taskId, "rework", feedback);
                          setReworkFeedback("");
                          setReworkOpenId("");
                        }}
                      >
                        <input
                          type="text"
                          value={reworkFeedback}
                          onChange={(e) => setReworkFeedback(e.target.value)}
                          placeholder="Describe what should be reworked…"
                          aria-label="Rework feedback"
                        />
                        <button
                          type="submit"
                          className="agent-btn primary sm"
                          disabled={busy || !reworkFeedback.trim()}
                        >
                          <span>Send for Rework</span>
                        </button>
                      </form>
                    )}
                  </div>
                )}

                {item.kind === "unconfirmed_run" && (
                  <div className="inbox-card-actions">
                    <button
                      type="button"
                      className="agent-btn primary sm"
                      disabled={busy}
                      onClick={() => void onResolveRun?.(item.runId)}
                    >
                      <Check size={13} aria-hidden="true" />
                      <span>Confirm Stopped</span>
                    </button>
                    {item.teamId && item.taskId && (
                      <button
                        type="button"
                        className="agent-btn ghost sm"
                        onClick={() => onOpenTask?.(item.teamId, item.taskId)}
                      >
                        <ExternalLink size={13} aria-hidden="true" />
                        <span>Inspect Task</span>
                      </button>
                    )}
                  </div>
                )}

                {item.kind === "notice" && (
                  <div className="inbox-card-actions">
                    {item.teamId && (
                      <button
                        type="button"
                        className="agent-btn secondary sm"
                        onClick={() => onOpenTeam?.(item.teamId)}
                      >
                        <ExternalLink size={13} aria-hidden="true" />
                        <span>View Team</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="agent-btn ghost sm"
                      disabled={busy}
                      onClick={() => void onDismissNotice?.(item.noticeId)}
                    >
                      <X size={13} aria-hidden="true" />
                      <span>Dismiss</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
