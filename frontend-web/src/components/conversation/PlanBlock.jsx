import { Check, ListTodo } from "lucide-react";

// The agent's current plan, rendered as a compact checklist under the transcript.
export function PlanBlock({ plan }) {
  if (!plan?.length) return null;
  const done = plan.filter((item) => item.status === "completed").length;
  return (
    <section className="plan-block" aria-label="Plan">
      <div className="plan-heading">
        <ListTodo size={14} aria-hidden="true" />
        <span>Plan</span>{" "}
        <span className="plan-count">{done} of {plan.length}</span>
      </div>
      <ol className="plan-list">
        {plan.map((item, index) => (
          <li className={`plan-row ${item.status || "pending"}`} key={`${item.step || item.title}-${index}`}>
            <span className="plan-check" aria-hidden="true">{item.status === "completed" ? <Check size={12} /> : index + 1}</span>
            <span>{item.step || item.title || "Untitled step"}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
