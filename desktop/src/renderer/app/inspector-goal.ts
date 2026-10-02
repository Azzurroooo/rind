// Activity goal state: loads and changes the session goal through rind/goal/*
// (window.api.goal) and renders it with goal-panel.ts.

import { normalizeGoal, renderGoalPanel } from "../goal-panel.ts"
import { clipLine } from "../timeline-model.ts"
import { goalPanel } from "./dom.ts"
import { asRecord } from "./html.ts"
import { showToast } from "./overlays.ts"
import { runAction } from "./runtime.ts"
import { currentRuntimeSnapshot } from "./sessions.ts"
import { render } from "./shell.ts"
import { state, vars } from "./state.ts"
import { renderActivityEmpty } from "./activity-empty.ts"

export function renderGoalTab() {
  renderGoalPanel(goalPanel, {
    goal: state.goal.value,
    busy: state.goal.busy,
  })
  renderActivityEmpty()
}

export function resetGoal() {
  state.goal = { busy: false }
  vars.goalLoadSequence += 1
}

export async function loadGoal() {
  const sessionId = state.viewedSessionId
  if (!sessionId || currentRuntimeSnapshot().status !== "ready") {
    state.goal = { ...state.goal, value: undefined }
    renderGoalTab()
    return
  }
  const sequence = ++vars.goalLoadSequence
  try {
    const result = asRecord(await window.api.goal.get(sessionId))
    if (sequence !== vars.goalLoadSequence || sessionId !== state.viewedSessionId) return
    state.goal = { ...state.goal, value: normalizeGoal(result.goal) }
  } catch {
    if (sequence !== vars.goalLoadSequence || sessionId !== state.viewedSessionId) return
  }
  renderGoalTab()
}

async function withGoalBusy(task: (sessionId: string) => Promise<void>) {
  const sessionId = state.viewedSessionId
  if (!sessionId || state.goal.busy) return
  state.goal = { ...state.goal, busy: true }
  renderGoalTab()
  try {
    await task(sessionId)
  } catch (error) {
    if (sessionId === state.viewedSessionId) state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    if (sessionId === state.viewedSessionId) state.goal = { ...state.goal, busy: false }
    render()
  }
}

export async function submitGoal(input: string) {
  const objective = input.trim()
  if (!objective) return
  await withGoalBusy(async (sessionId) => {
    const value = normalizeGoal(asRecord(await window.api.goal.set(sessionId, objective)).goal)
    if (sessionId !== state.viewedSessionId) return
    state.goal = { ...state.goal, value }
    if (value) showToast(`Goal set: ${clipLine(value.objective, 80)}`, "success")
  })
}

export async function changeGoalStatus(status: "active" | "paused") {
  await withGoalBusy(async (sessionId) => {
    const value = normalizeGoal(asRecord(await window.api.goal.status(sessionId, status)).goal)
    if (sessionId === state.viewedSessionId) state.goal = { ...state.goal, value }
  })
}

export async function clearGoal() {
  await withGoalBusy(async (sessionId) => {
    await window.api.goal.clear(sessionId)
    if (sessionId !== state.viewedSessionId) return
    state.goal = { ...state.goal, value: undefined }
    showToast("Goal cleared.", "success")
  })
}

export function bindGoalEvents(): void {
  goalPanel.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    const sessionId = state.viewedSessionId
    if (target.closest("[data-goal-pause]")) {
      runAction(() => changeGoalStatus("paused"), sessionId)
    } else if (target.closest("[data-goal-resume]")) {
      runAction(() => changeGoalStatus("active"), sessionId)
    } else if (target.closest("[data-goal-clear]")) {
      runAction(clearGoal, sessionId)
    }
  })
}
