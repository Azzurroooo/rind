// Activity displays an existing goal with clear, pause and resume actions.
// Creating or replacing an objective belongs to /goal. Rendering is a pure DOM sync;
// the rind/goal/* protocol calls live in app/inspector-goal.ts.

import type { DesktopGoal } from "../preload/types"
import { escapeHtml } from "./app/html.ts"

export type GoalPanelView = {
  goal?: DesktopGoal
  busy: boolean
}

export function normalizeGoal(value: unknown): DesktopGoal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const objective = typeof record.objective === "string" ? record.objective.trim() : ""
  if (!objective) return undefined
  const status = typeof record.status === "string" && record.status.trim() ? record.status.trim() : "active"
  return { objective, status }
}

/**
 * Preserve controls and focus during unrelated streaming updates.
 */
export function renderGoalPanel(panel: HTMLElement, view: GoalPanelView) {
  const goal = view.goal
  panel.hidden = !goal
  const key = JSON.stringify([goal?.objective, goal?.status, view.busy])
  if (panel.dataset.renderKey === key) return
  panel.dataset.renderKey = key
  if (goal) {
    panel.innerHTML = `
      <div class="goal-heading">
        <h3 class="inspector-section-title">Goal</h3>
        <span class="goal-status">${escapeHtml(goal.status)}</span>
      </div>
      <p class="goal-objective">${escapeHtml(goal.objective)}</p>
      <div class="goal-actions">
        ${goal.status === "paused"
          ? `<button type="button" class="ghost-button" data-goal-resume${view.busy ? " disabled" : ""}>Resume</button>`
          : `<button type="button" class="ghost-button" data-goal-pause${view.busy ? " disabled" : ""}>Pause</button>`}
        <button type="button" class="ghost-button danger" data-goal-clear${view.busy ? " disabled" : ""}>Clear</button>
      </div>
    `
    return
  }
  panel.replaceChildren()
}
