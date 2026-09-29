import { Check, ListTodo } from "lucide-react";

const STEP_STATES = new Set(["pending", "in_progress", "completed", "cancelled"]);

// The agent's live plan (update_plan), shown in the Activity tab. The deck
// above the composer is gone; the checklist lives beside the conversation.
export function PlanSection({ plan }) {
  const steps = (Array.isArray(plan) ? plan : [])
    .map((item) => ({
      text: String(item?.step || item?.title || "").trim(),
      status: STEP_STATES.has(item?.status) ? item.status : "pending",
    }))
    .filter((step) => step.text);
  if (!steps.length) return null;
  const done = steps.filter((step) => step.status === "completed").length;
  return (
    <section className="inspector-section plan-section" aria-label="Plan">
      <div className="inspector-section-head">
        <h3 className="inspector-section-title"><ListTodo size={14} aria-hidden="true" /> Plan</h3>
        <span className="section-note">{done} of {steps.length}</span>
      </div>
      <ol className="plan-list">
        {steps.map((step, index) => (
          <li key={`${index}-${step.text}`} className={`plan-row ${step.status}`}>
            <span className="plan-check" aria-hidden="true">
              {step.status === "completed" ? <Check size={12} /> : index + 1}
            </span>
            <span className="plan-text">{step.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
