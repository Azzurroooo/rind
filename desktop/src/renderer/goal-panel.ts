// Goal panel (task B7): composer-adjacent presentation of the active goal
// (objective + status) with set/clear/pause/resume. Rendering is a pure DOM
// sync; the rind/goal/* protocol calls stay in index.ts. Ported from the web
// surface's /goal command flows.

import type { DesktopGoal } from "../preload/types"

export type GoalPanelElements = {
  shell: HTMLElement
  panel: HTMLElement
}

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

export function renderGoalPanel(elements: GoalPanelElements, view: GoalPanelView) {
  elements.shell.hidden = false
  const goal = view.goal
  if (goal && !view.setOpen) {
    elements.shell.hidden = false
    elements.panel.className = "goal-panel goal-active"
    elements.panel.innerHTML = `
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
  elements.panel.className = "goal-panel goal-set"
  elements.panel.innerHTML = `
    <div class="goal-set-row">
      <strong>Goal</strong>
      <input id="goal-objective-input" aria-label="Goal objective" autocomplete="off" placeholder="Set an objective for this session…" value="${escapeHtml(view.draft)}" />
      <button type="button" class="primary-button" data-goal-submit${view.busy || !view.draft.trim() ? " disabled" : ""}>${goal ? "Replace" : "Set goal"}</button>
      ${goal ? `<button type="button" class="ghost-button" data-goal-cancel>Cancel</button>` : `<button type="button" class="ghost-button" data-goal-close title="Hide goal panel">Hide</button>`}
    </div>
  `
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character)
}
