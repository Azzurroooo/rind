import { useEffect, useMemo, useRef, useState } from "react";
import { Check, MessageCircleQuestion, Send } from "lucide-react";

// Question card in the stream (web-ui.md §2.3):
//   pending →（选择）→ answered ｜（TTL 到）→ expired ｜（turn 终止）→ cancelled
// Answered buttons freeze as selected and the card STAYS in the stream;
// expired shows the 已超时 tag; cancelled reads 已随回合结束.
// Countdown is silent: one thin depleting bar, no ticking numbers.
export function QuestionCard({ entry, onAnswer, onExpire }) {
  const options = Array.isArray(entry?.options) ? entry.options : [];
  const status = entry?.status || "pending";
  const answered = status === "answered";
  const closed = status !== "pending";
  const [selected, setSelected] = useState(answered ? entry?.selectedAnswer || "" : "");
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState(answered ? entry?.selectedAnswer || "" : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submittingRef = useRef(false);

  const ttl = Math.max(0, Number(entry?.ttlMs) || 0);
  const deadline = useMemo(() => {
    const requested = Number(entry?.requestedAt) || 0;
    return requested > 0 ? requested + ttl : Date.now() + ttl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.requestedAt, ttl]);
  const remaining = Math.max(0, deadline - Date.now());

  useEffect(() => {
    if (closed || !onExpire || remaining <= 0) return undefined;
    const timer = window.setTimeout(() => onExpire(questionKeyOf(entry)), remaining + 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed, remaining, onExpire]);

  async function answer(value) {
    const text = String(value || "").trim();
    if (!text || submittingRef.current || closed) return;
    setError("");
    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (await onAnswer?.(entry, text)) {
        setSelected(text);
      } else {
        setError("答案未发送成功，请重试。");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <article className={`question-card ${status}`} data-status={status}>
      <header className="question-card-heading">
        <MessageCircleQuestion size={15} />
        <strong>{entry?.question || "The worker needs an answer"}</strong>
        {status === "expired" && <span className="question-tag expired">已超时</span>}
        {status === "cancelled" && <span className="question-tag cancelled">已随回合结束</span>}
        {answered && <span className="question-tag answered">已回答</span>}
      </header>
      {status === "pending" && ttl > 0 && (
        <div className="question-timer" aria-hidden="true">
          <span className="question-timer-bar" style={{ animationDuration: `${Math.max(1, remaining)}ms` }} />
        </div>
      )}
      <div className="question-card-options">
        {options.map((option, index) => {
          const value = String(option?.value || option?.label || "");
          const active = selected === value;
          return (
            <button
              type="button"
              key={`${value}-${index}`}
              className={`question-option ${active ? "selected" : ""}`}
              disabled={closed || submitting}
              onClick={() => answer(value)}
            >
              <span>
                <strong>{option?.label || value}</strong>
                {option?.description && <small>{option.description}</small>}
              </span>
              {active && <Check size={15} />}
            </button>
          );
        })}
        {!closed && (
          <div className="question-custom">
            <input
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onFocus={() => setCustomOpen(true)}
              onKeyDown={(event) => event.key === "Enter" && answer(custom)}
              placeholder="输入自定义答案后回车"
              aria-label="自定义答案"
              disabled={submitting}
            />
            {customOpen && (
              <button type="button" className="question-send" onClick={() => answer(custom)} disabled={!custom.trim() || submitting}>
                <Send size={14} /> 发送
              </button>
            )}
          </div>
        )}
      </div>
      {answered && <div className="question-answer-note">已选择：{selected}</div>}
      {error && <div className="question-card-error" role="alert">{error}</div>}
      {closed && status !== "answered" && <div className="question-closed-note">问题已关闭，回答未提交。</div>}
    </article>
  );
}

function questionKeyOf(entry) {
  return `${entry?.sessionId || ""}:${entry?.toolCallId || ""}`;
}
