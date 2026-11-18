import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { parseOptionLabel } from "../../../runtime/dist/protocol/runtime-protocol.js";

function initStepDrafts(questions) {
  return questions.map((q) => {
    const opts = Array.isArray(q?.options) ? q.options : [];
    const hasRecFirst = opts.length > 0 && parseOptionLabel(opts[0].label).recommended;
    return {
      picked: !q?.multiple && hasRecFirst ? [opts[0].label] : [],
      customSelected: opts.length === 0,
      customText: "",
    };
  });
}

function stepAnswersOf(question, draft) {
  if (!draft) return [];
  const custom = draft.customText.trim();
  if (question?.multiple) {
    const base = Array.isArray(draft.picked) ? draft.picked : [];
    return draft.customSelected && custom ? [...base, custom] : base;
  }
  if (draft.customSelected) {
    return custom ? [custom] : [];
  }
  return Array.isArray(draft.picked) && draft.picked.length > 0 ? [draft.picked[0]] : [];
}

export function QuestionCard({ entry, onAnswer, onExpire }) {
  const questions = useMemo(
    () => (Array.isArray(entry?.questions) ? entry.questions : []),
    [entry?.questions],
  );
  const total = questions.length;
  const status = entry?.status || "pending";
  const answered = status === "answered";
  const closed = status !== "pending";

  const [activeStep, setActiveStep] = useState(0);
  const [drafts, setDrafts] = useState(() => initStepDrafts(questions));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submittingRef = useRef(false);
  const customInputRef = useRef(null);

  useEffect(() => {
    setDrafts(initStepDrafts(questions));
    setActiveStep(0);
  }, [entry?.toolCallId, total, questions]);

  const ttl = Math.max(0, Number(entry?.ttlMs) || 0);
  const deadline = useMemo(() => {
    const requested = Number(entry?.requestedAt) || 0;
    return requested > 0 ? requested + ttl : Date.now() + ttl;
  }, [entry?.requestedAt, ttl]);
  const remaining = Math.max(0, deadline - Date.now());

  useEffect(() => {
    if (closed || !onExpire || remaining <= 0) return undefined;
    const timer = window.setTimeout(() => onExpire(questionKeyOf(entry)), remaining + 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed, remaining, onExpire]);

  const resolvedPerStep = useMemo(
    () => questions.map((q, idx) => stepAnswersOf(q, drafts[idx])),
    [questions, drafts],
  );
  const answeredCount = resolvedPerStep.filter((list) => list.length > 0).length;
  const allAnswered = total > 0 && answeredCount === total;

  const safeStep = Math.min(activeStep, Math.max(0, total - 1));
  const currentQuestion = questions[safeStep] || { question: "Clarification needed", options: null };
  const currentOptions = Array.isArray(currentQuestion.options) ? currentQuestion.options : [];
  const currentDraft = drafts[safeStep] || { picked: [], customSelected: currentOptions.length === 0, customText: "" };
  const isMultiple = Boolean(currentQuestion.multiple);
  const currentHasAnswer = (resolvedPerStep[safeStep]?.length || 0) > 0;

  async function submitPayload(answersPayload) {
    if (submittingRef.current || closed) return;
    setError("");
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const ok = await onAnswer?.(entry, answersPayload);
      if (!ok) {
        setError("Failed to send response. Please try again.");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function findNextUnanswered(fromIndex, nextDrafts) {
    for (let offset = 1; offset < total; offset += 1) {
      const idx = (fromIndex + offset) % total;
      if (stepAnswersOf(questions[idx], nextDrafts[idx]).length === 0) {
        return idx;
      }
    }
    return -1;
  }

  function handleOptionClick(label) {
    if (closed || submitting) return;
    setError("");
    const nextDrafts = drafts.map((d, idx) => {
      if (idx !== safeStep) return d;
      if (isMultiple) {
        const exists = d.picked.includes(label);
        const picked = exists ? d.picked.filter((item) => item !== label) : [...d.picked, label];
        return { ...d, picked };
      }
      return { ...d, picked: [label], customSelected: false };
    });
    setDrafts(nextDrafts);
    if (!isMultiple && total > 1) {
      const nextIdx = findNextUnanswered(safeStep, nextDrafts);
      if (nextIdx !== -1) {
        setActiveStep(nextIdx);
      } else if (safeStep < total - 1) {
        setActiveStep(safeStep + 1);
      }
    }
  }

  function handleCustomToggle() {
    if (closed || submitting) return;
    setError("");
    setDrafts((prev) =>
      prev.map((d, idx) => {
        if (idx !== safeStep) return d;
        if (isMultiple) {
          return { ...d, customSelected: !d.customSelected };
        }
        return { ...d, customSelected: true };
      }),
    );
    window.requestAnimationFrame(() => customInputRef.current?.focus());
  }

  function handleCustomChange(value) {
    setError("");
    setDrafts((prev) =>
      prev.map((d, idx) => {
        if (idx !== safeStep) return d;
        const shouldActivate = value.trim().length > 0 ? true : d.customSelected;
        return {
          ...d,
          customText: value,
          customSelected: shouldActivate,
        };
      }),
    );
  }

  function handleCustomKeyDown(event) {
    if (event.key !== "Enter" || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    if (!currentHasAnswer) return;
    if (total > 1) {
      const nextIdx = findNextUnanswered(safeStep, drafts);
      if (nextIdx !== -1) {
        setActiveStep(nextIdx);
        return;
      }
    }
    if (allAnswered) {
      void submitPayload(resolvedPerStep);
    }
  }

  if (total === 0) return null;

  const selectedAnswers = Array.isArray(entry?.selectedAnswers) ? entry.selectedAnswers : [];

  return (
    <article className={`question-card ${status}`} data-status={status}>
      <header className="question-card-heading">
        <span className="question-heading-lead">
          {answered ? <Check size={14} strokeWidth={2.25} /> : <MessageCircleQuestion size={14} strokeWidth={1.75} />}
          <span className="question-eyebrow-label">
            {answered
              ? "Answered"
              : status === "expired"
                ? "Question expired"
                : status === "cancelled"
                  ? entry?.skipped
                    ? "Question skipped"
                    : "Question closed"
                  : total > 1
                    ? "Questions"
                    : "Clarification"}
          </span>
        </span>
        {status === "pending" && total > 1 && (
          <span className="question-step-counter">
            {safeStep + 1} / {total}
          </span>
        )}
        {status === "expired" && <span className="question-tag expired">Expired</span>}
        {status === "cancelled" && (
          <span className="question-tag cancelled">{entry?.skipped ? "Skipped" : "Ended with the turn"}</span>
        )}
        {answered && <span className="question-tag answered">Answered</span>}
      </header>

      {status === "pending" && ttl > 0 && (
        <div className="question-timer" aria-hidden="true">
          <span className="question-timer-bar" style={{ animationDuration: `${Math.max(1, remaining)}ms` }} />
        </div>
      )}

      {answered ? (
        <div className="question-receipt">
          {questions.map((q, idx) => {
            const values = Array.isArray(selectedAnswers[idx]) ? selectedAnswers[idx] : [];
            return (
              <div key={`${q.question}-${idx}`} className="question-receipt-row">
                <div className="question-receipt-prompt">
                  {q.header && <span className="question-receipt-header">{q.header}</span>}
                  <span>{q.question}</span>
                </div>
                <div className="question-receipt-values">
                  {values.length > 0 ? (
                    values.map((val, vIdx) => (
                      <span key={`${val}-${vIdx}`} className="question-receipt-pill">
                        <Check size={11} strokeWidth={2.5} aria-hidden="true" />
                        <span>{parseOptionLabel(val).text}</span>
                      </span>
                    ))
                  ) : (
                    <span className="question-receipt-empty">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : closed ? (
        <div className="question-closed-summary">
          {questions.map((q, idx) => (
            <div key={`${q.question}-${idx}`} className="question-closed-item">
              {q.header && <span className="question-receipt-header">{q.header}</span>}
              <span>{q.question}</span>
            </div>
          ))}
          <div className="question-closed-note">
            {entry?.skipped ? "Skipped without a preference." : "Question closed; answer not submitted."}
          </div>
        </div>
      ) : (
        <>
          {total > 1 && (
            <div className="question-steps" role="tablist" aria-label="Question steps">
              {questions.map((q, idx) => {
                const done = resolvedPerStep[idx]?.length > 0;
                const current = idx === safeStep;
                const label = q.header || `Q${idx + 1}`;
                return (
                  <button
                    type="button"
                    role="tab"
                    key={`${label}-${idx}`}
                    aria-selected={current}
                    className={`question-step-pill ${current ? "active" : ""} ${done ? "done" : ""}`}
                    onClick={() => setActiveStep(idx)}
                    disabled={submitting}
                  >
                    <span className="question-step-num" aria-hidden="true">
                      {done ? <Check size={11} strokeWidth={2.5} /> : idx + 1}
                    </span>
                    <span className="question-step-label">{label}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="question-prompt-row">
            <strong className="question-prompt-text">{currentQuestion.question}</strong>
            {isMultiple && <span className="question-mode-pill">Select all that apply</span>}
          </div>

          <div
            className="question-card-options"
            role={currentOptions.length > 0 ? (isMultiple ? "group" : "radiogroup") : undefined}
            aria-label={currentQuestion.question}
          >
            {currentOptions.map((option, index) => {
              const rawLabel = String(option?.label || "");
              const { text: cleanLabel, recommended } = parseOptionLabel(rawLabel);
              const selected = isMultiple
                ? currentDraft.picked.includes(rawLabel)
                : !currentDraft.customSelected && currentDraft.picked[0] === rawLabel;
              return (
                <button
                  type="button"
                  role={isMultiple ? "checkbox" : "radio"}
                  aria-checked={selected}
                  key={`${rawLabel}-${index}`}
                  className={`question-option ${selected ? "selected" : ""}`}
                  disabled={submitting}
                  onClick={() => handleOptionClick(rawLabel)}
                >
                  <span
                    className={`question-indicator ${isMultiple ? "checkbox" : "radio"} ${selected ? "checked" : ""}`}
                    aria-hidden="true"
                  >
                    {isMultiple ? <Check size={11} strokeWidth={2.5} /> : <span className="question-radio-dot" />}
                  </span>
                  <span className="question-option-body">
                    <span className="question-option-title-row">
                      <strong>{cleanLabel}</strong>
                      {recommended && <span className="question-rec-badge">Recommended</span>}
                    </span>
                    {option?.description && <small>{option.description}</small>}
                  </span>
                </button>
              );
            })}

            {currentOptions.length > 0 ? (
              <div className={`question-custom-option ${currentDraft.customSelected ? "selected" : ""}`}>
                <button
                  type="button"
                  role={isMultiple ? "checkbox" : "radio"}
                  aria-checked={currentDraft.customSelected}
                  className="question-custom-trigger"
                  disabled={submitting}
                  onClick={handleCustomToggle}
                >
                  <span
                    className={`question-indicator ${isMultiple ? "checkbox" : "radio"} ${currentDraft.customSelected ? "checked" : ""}`}
                    aria-hidden="true"
                  >
                    {isMultiple ? <Check size={11} strokeWidth={2.5} /> : <span className="question-radio-dot" />}
                  </span>
                  <span className="question-custom-label">Write your own answer…</span>
                </button>
                {currentDraft.customSelected && (
                  <div className="question-custom-input-wrap">
                    <input
                      ref={customInputRef}
                      value={currentDraft.customText}
                      onChange={(event) => handleCustomChange(event.target.value)}
                      onKeyDown={handleCustomKeyDown}
                      placeholder="Type your answer…"
                      aria-label="Custom answer"
                      disabled={submitting}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="question-open-input">
                <input
                  ref={customInputRef}
                  value={currentDraft.customText}
                  onChange={(event) => handleCustomChange(event.target.value)}
                  onKeyDown={handleCustomKeyDown}
                  placeholder="Type your answer…"
                  aria-label="Custom answer"
                  disabled={submitting}
                />
              </div>
            )}
          </div>

          <footer className="question-footer">
            <div className="question-footer-left">
              <button
                type="button"
                className="question-btn-ghost"
                disabled={submitting}
                onClick={() => submitPayload([])}
              >
                Skip
              </button>
              {total > 1 && safeStep > 0 && (
                <button
                  type="button"
                  className="question-btn-secondary"
                  disabled={submitting}
                  onClick={() => setActiveStep((s) => Math.max(0, s - 1))}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                  <span>Back</span>
                </button>
              )}
            </div>
            <div className="question-footer-right">
              {total > 1 && safeStep < total - 1 && !allAnswered ? (
                <button
                  type="button"
                  className="question-btn-secondary"
                  disabled={!currentHasAnswer || submitting}
                  onClick={() => setActiveStep((s) => Math.min(total - 1, s + 1))}
                >
                  <span>Next</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                className="question-btn-submit"
                disabled={!allAnswered || submitting}
                onClick={() => submitPayload(resolvedPerStep)}
              >
                {submitting
                  ? "Sending…"
                  : total > 1
                    ? `Submit (${answeredCount}/${total})`
                    : "Send answer"}
              </button>
            </div>
          </footer>
        </>
      )}

      {error && (
        <div className="question-card-error" role="alert">
          {error}
        </div>
      )}
    </article>
  );
}

function questionKeyOf(entry) {
  return `${entry?.sessionId || ""}:${entry?.toolCallId || ""}`;
}
