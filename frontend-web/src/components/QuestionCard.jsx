import { useEffect, useMemo, useRef, useState } from "react";
import { Check, MessageCircleQuestion, Send } from "lucide-react";

// Question card in the stream (web-ui.md §2.3):
//   pending → (choose) → answered | (TTL reached) → expired | (turn ended) → cancelled
// Answered buttons freeze as selected and the card STAYS in the stream;
// expired shows the Expired tag; cancelled reads "Ended with the turn".
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
        setError("The answer failed to send. Try again.");
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
        {status === "expired" && <span className="question-tag expired">Expired</span>}
        {status === "cancelled" && <span className="question-tag cancelled">Ended with the turn</span>}
        {answered && <span className="question-tag answered">Answered</span>}
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
              placeholder="Type a custom answer and press Enter"
              aria-label="Custom answer"
              disabled={submitting}
            />
            {customOpen && (
              <button type="button" className="question-send" onClick={() => answer(custom)} disabled={!custom.trim() || submitting}>
                <Send size={14} /> Send
              </button>
            )}
          </div>
        )}
      </div>
      {answered && <div className="question-answer-note">Selected: {selected}</div>}
      {error && <div className="question-card-error" role="alert">{error}</div>}
      {closed && status !== "answered" && <div className="question-closed-note">Question closed; answer not submitted.</div>}
    </article>
  );
}

function questionKeyOf(entry) {
  return `${entry?.sessionId || ""}:${entry?.toolCallId || ""}`;
}
