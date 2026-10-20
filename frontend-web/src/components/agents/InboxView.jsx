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
  sections,
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
  const [filter, setFilter] = useState("all"); // "all" | "needs" | "notices" | "delivered"
  const [answers, setAnswers] = useState({});
  const [reworkOpenId, setReworkOpenId] = useState("");
  const [reworkFeedback, setReworkFeedback] = useState("");

  const normalizedSections = useMemo(() => {
    if (sections && typeof sections === "object") {
      return {
        needsYou: Array.isArray(sections.needsYou) ? sections.needsYou : [],
        notices: Array.isArray(sections.notices) ? sections.notices : [],
        delivered: Array.isArray(sections.delivered) ? sections.delivered : [],
      };
    }
    return {
      needsYou: items.filter(
        (i) =>
          i.kind === "approval" ||
          i.kind === "blocker" ||
          i.kind === "attention" ||
          i.kind === "unconfirmed_run" ||
          i.kind === "session_input",
      ),
      notices: items.filter((i) => i.kind === "notice"),
      delivered: items.filter((i) => i.kind === "delivery"),
    };
  }, [sections, items]);

  const unreviewedCount = useMemo(
    () => normalizedSections.delivered.filter((d) => d.unreviewed !== false).length,
    [normalizedSections.delivered],
  );
  const actionableCount =
    normalizedSections.needsYou.length + normalizedSections.notices.length + unreviewedCount;

  const visibleGroups = useMemo(() => {
    const groups = [
      {
        id: "needs",
        title: "Needs You",
        items: normalizedSections.needsYou,
      },
      {
        id: "notices",
        title: "Updates",
        items: normalizedSections.notices,
      },
      {
        id: "delivered",
        title: "Delivered",
        items: normalizedSections.delivered,
      },
    ];
    if (filter === "all") return groups.filter((g) => g.items.length > 0);
    return groups.filter((g) => g.id === filter);
  }, [normalizedSections, filter]);

  function renderInboxCard(item) {
    return (
      <div key={item.id} className={`inbox-card kind-${item.kind}`} role="listitem">
        <div className="inbox-card-top">
          <span className={`agent-status-pill tone-${item.tone}`}>
            {item.kind === "approval" && <ShieldAlert size={12} aria-hidden="true" />}
            {(item.kind === "blocker" ||
              item.kind === "attention" ||
              item.kind === "unconfirmed_run" ||
              item.kind === "session_input") && <AlertTriangle size={12} aria-hidden="true" />}
            {item.kind === "delivery" && <CheckCircle2 size={12} aria-hidden="true" />}
            {item.kind === "notice" && <Bell size={12} aria-hidden="true" />}
            <span>{item.badge}</span>
          </span>
          {item.subtitle && <span className="inbox-card-subtitle">{item.subtitle}</span>}
          {item.ageText && <span className="inbox-card-age">{item.ageText}</span>}
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
              placeholder="Reply to unblock this agent…"
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
              <span>Inspect</span>
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
              <span>Resume</span>
            </button>
            <button
              type="button"
              className="agent-btn secondary sm"
              onClick={() => onOpenTask?.(item.teamId, item.taskId)}
            >
              <ExternalLink size={13} aria-hidden="true" />
              <span>Inspect</span>
            </button>
            {item.agentId && (
              <button
                type="button"
                className="agent-btn ghost sm"
                onClick={() =>
                  onOpenChat?.({ teamId: item.teamId, agentId: item.agentId, resumeLatest: true })
                }
              >
                <MessageSquare size={13} aria-hidden="true" />
                <span>Chat</span>
              </button>
            )}
          </div>
        )}

        {item.kind === "session_input" && (
          <div className="inbox-card-actions">
            <button
              type="button"
              className="agent-btn primary sm"
              disabled={busy}
              onClick={() =>
                onOpenChat?.({
                  teamId: item.teamId,
                  agentId: item.agentId,
                  runtimeSessionId: item.runtimeSessionId,
                })
              }
            >
              <MessageSquare size={13} aria-hidden="true" />
              <span>Open Conversation</span>
            </button>
          </div>
        )}

        {item.kind === "delivery" && (
          <div className="inbox-delivery-block">
            <div className="inbox-card-actions">
              {item.unreviewed !== false && (
                <>
                  <button
                    type="button"
                    className="agent-btn primary sm"
                    disabled={busy}
                    onClick={() => void onReviewTask?.(item.taskId, "accept")}
                  >
                    <CheckCircle2 size={13} aria-hidden="true" />
                    <span>Accept</span>
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
                    <span>Rework</span>
                  </button>
                </>
              )}
              <button
                type="button"
                className="agent-btn ghost sm"
                onClick={() => onOpenTask?.(item.teamId, item.taskId)}
              >
                <ExternalLink size={13} aria-hidden="true" />
                <span>Report</span>
              </button>
              {item.agentId && (
                <button
                  type="button"
                  className="agent-btn ghost sm"
                  onClick={() =>
                    onOpenChat?.({
                      teamId: item.teamId,
                      agentId: item.agentId,
                      runtimeSessionId: item.raw?.runtimeSessionId || "",
                      resumeLatest: true,
                    })
                  }
                >
                  <MessageSquare size={13} aria-hidden="true" />
                  <span>Chat</span>
                </button>
              )}
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
                <span>Inspect</span>
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
    );
  }

  return (
    <div className="agents-surface">
      <div className="agents-surface-header">
        <div className="agents-surface-title-block">
          <div className="agents-surface-title-row">
            <h2 className="agents-surface-title">Inbox</h2>
            <span className="agents-header-meta">
              {actionableCount === 0
                ? "All caught up"
                : `${actionableCount} ${actionableCount === 1 ? "item" : "items"} pending`}
            </span>
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
              {actionableCount > 0 && <span className="agents-seg-count">{actionableCount}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === "needs"}
              className={`agents-seg-btn ${filter === "needs" ? "active" : ""}`}
              onClick={() => setFilter("needs")}
            >
              <span>Needs You</span>
              {normalizedSections.needsYou.length > 0 && (
                <span className="agents-seg-count">{normalizedSections.needsYou.length}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === "notices"}
              className={`agents-seg-btn ${filter === "notices" ? "active" : ""}`}
              onClick={() => setFilter("notices")}
            >
              <span>Updates</span>
              {normalizedSections.notices.length > 0 && (
                <span className="agents-seg-count">{normalizedSections.notices.length}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === "delivered"}
              className={`agents-seg-btn ${filter === "delivered" ? "active" : ""}`}
              onClick={() => setFilter("delivered")}
            >
              <span>Delivered</span>
              {normalizedSections.delivered.length > 0 && (
                <span className="agents-seg-count">{normalizedSections.delivered.length}</span>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="agents-surface-main panel-scroll">
        {visibleGroups.length === 0 || visibleGroups.every((g) => g.items.length === 0) ? (
          <div className="agents-empty-hero">
            <Inbox size={28} aria-hidden="true" />
            <h3>Nothing waiting on you</h3>
            <p>No pending approvals, blocked tasks, or unreviewed deliveries right now.</p>
          </div>
        ) : (
          <div className="task-sections-stack">
            {visibleGroups.map((group) => (
              <section key={group.id} className="task-group-section">
                <div className="task-group-head">
                  <h3 className="task-group-title">{group.title}</h3>
                  <span className="task-group-count">{group.items.length}</span>
                </div>
                {group.items.length === 0 ? (
                  <div className="task-group-empty">No items in {group.title.toLowerCase()}.</div>
                ) : (
                  <div className="inbox-card-list" role="list">
                    {group.items.map((item) => renderInboxCard(item))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
