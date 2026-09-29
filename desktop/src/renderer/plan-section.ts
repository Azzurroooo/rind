// Plan checklist for the inspector Activity tab. The composer plan dock is
// gone; this renders the same live update_plan state beside the conversation.

import { escapeAttribute, escapeHtml } from "./app/html.ts"
import { activePlan, clipLine, type ConversationState, type PlanEntry } from "./timeline-model.ts"

export function planProgress(plan: PlanEntry) {
  const completed = plan.steps.filter((step) => step.status === "completed").length
  const settled = plan.steps.filter((step) => step.status === "completed" || step.status === "cancelled").length
  const status = plan.error || plan.status === "error"
    ? "error"
    : plan.steps.some((step) => step.status === "in_progress")
      ? "running"
      : settled === plan.steps.length ? "completed" : "pending"
  return { completed, status, pip: status === "error" ? "pip-error" : status === "completed" ? "pip-done" : "pip-running" }
}

/** The Activity tab's Plan section; empty string when no plan is live. */
export function renderPlanSection(conversation: ConversationState): string {
  const plan = activePlan(conversation)
  if (!plan) return ""
  const progress = planProgress(plan)
  return `
    <section class="activity-section plan-section" aria-label="Plan">
      <div class="inspector-section-head">
        <h3 class="inspector-section-title">Plan</h3>
        <span class="activity-note">${progress.completed}/${plan.steps.length}</span>
      </div>
      <ol class="plan-steps">
        ${plan.steps.map((step) => `<li class="plan-step plan-${escapeAttribute(step.status)}"><span aria-hidden="true"></span><span>${escapeHtml(clipLine(step.step, 160))}</span></li>`).join("")}
      </ol>
      ${plan.error ? `<p class="plan-error-text">${escapeHtml(clipLine(plan.error, 300))}</p>` : ""}
    </section>
  `
}
