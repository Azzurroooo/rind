// Goal panel: the inspector Goal tab shows the active goal (objective and
// status) with set, clear, pause, and resume. Rendering is a pure DOM sync;
// the rind/goal/* protocol calls live in app/inspector-goal.ts.

import type { DesktopGoal } from "../preload/types"
import { escapeHtml } from "./app/html.ts"

export type GoalPanelView = {
  goal?: DesktopGoal
  busy: boolean
  setOpen: boolean
  draft: string
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
 * Re-renders only when the visible shape changes, so a render pass during a
 * streaming turn never replaces the objective input while it has focus.
 */
export function renderGoalPanel(panel: HTMLElement, view: GoalPanelView) {
  const goal = view.goal
  const key = JSON.stringify([goal?.objective, goal?.status, view.busy, view.setOpen])
  if (panel.dataset.renderKey === key) return
  panel.dataset.renderKey = key
  if (goal && !view.setOpen) {
    panel.className = "goal-panel goal-active"
    panel.innerHTML = `
      <button type="button" class="goal-trigger" data-toggle-goal-set aria-expanded="false" title="Set a new goal">
        <span class="status-pip ${goal.status === "paused" ? "pip-paused" : "pip-running"}"></span>
        <strong>Goal</strong>
        <span class="goal-objective">${escapeHtml(goal.objective)}</span>
        <span class="goal-status">${escapeHtml(goal.status)}</span>
      </button>
      <div class="goal-actions">
        ${goal.status === "paused"
          ? `<button type="button" class="ghost-button" data-goal-resume${view.busy ? " disabled" : ""}>Resume</button>`
          : `<button type="button" class="ghost-button" data-goal-pause${view.busy ? " disabled" : ""}>Pause</button>`}
        <button type="button" class="ghost-button danger" data-goal-clear${view.busy ? " disabled" : ""}>Clear</button>
      </div>
    `
    return
  }
  panel.className = "goal-panel goal-set"
  panel.innerHTML = `
    <div class="goal-set-row">
      <strong>Goal</strong>
      <input id="goal-objective-input" aria-label="Goal objective" autocomplete="off" placeholder="Set an objective for this session…" value="${escapeHtml(view.draft)}" />
      <button type="button" class="primary-button" data-goal-submit${view.busy || !view.draft.trim() ? " disabled" : ""}>${goal ? "Replace" : "Set goal"}</button>
      ${goal ? `<button type="button" class="ghost-button" data-goal-cancel>Cancel</button>` : ""}
    </div>
    <p class="goal-help">Rind will continue working automatically until the goal is reached or paused.</p>
  `
}
