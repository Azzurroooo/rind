// Inspector Goal tab: loads and changes the session goal through rind/goal/*
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

export function renderGoalTab() {
  renderGoalPanel(goalPanel, {
    goal: state.goal.value,
    busy: state.goal.busy,
    setOpen: state.goal.setOpen || !state.goal.value,
    draft: state.goal.draft,
  })
  const input = goalPanel.querySelector<HTMLInputElement>("#goal-objective-input")
  if (input) input.disabled = !state.viewedSessionId
}

export function focusGoalInput() {
  goalPanel.querySelector<HTMLInputElement>("#goal-objective-input")?.focus()
}

export function resetGoal() {
  state.goal = { busy: false, setOpen: false, draft: "" }
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
    if (sequence === vars.goalLoadSequence) state.goal = { ...state.goal, value: undefined }
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
    state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    state.goal = { ...state.goal, busy: false }
    render()
  }
}

export async function submitGoal() {
  const objective = state.goal.draft.trim()
  if (!objective) return
  await withGoalBusy(async (sessionId) => {
    const value = normalizeGoal(asRecord(await window.api.goal.set(sessionId, objective)).goal)
    state.goal = { ...state.goal, value, draft: "", setOpen: false }
    if (value) showToast(`Goal set: ${clipLine(value.objective, 80)}`, "success")
  })
}

export async function changeGoalStatus(status: "active" | "paused") {
  await withGoalBusy(async (sessionId) => {
    state.goal = { ...state.goal, value: normalizeGoal(asRecord(await window.api.goal.status(sessionId, status)).goal) }
  })
}

export async function clearGoal() {
  await withGoalBusy(async (sessionId) => {
    await window.api.goal.clear(sessionId)
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
    } else if (target.closest("[data-toggle-goal-set]")) {
      state.goal = { ...state.goal, setOpen: true }
      renderGoalTab()
      focusGoalInput()
    } else if (target.closest("[data-goal-cancel]")) {
      state.goal = { ...state.goal, setOpen: false, draft: "" }
      renderGoalTab()
    } else if (target.closest("[data-goal-submit]")) {
      runAction(submitGoal, sessionId)
    }
  })

  goalPanel.addEventListener("input", (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.id !== "goal-objective-input") return
    state.goal = { ...state.goal, draft: input.value }
    const submit = goalPanel.querySelector<HTMLButtonElement>("[data-goal-submit]")
    if (submit) submit.disabled = state.goal.busy || !input.value.trim()
  })

  goalPanel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || event.target.id !== "goal-objective-input") return
    event.preventDefault()
    runAction(submitGoal, state.viewedSessionId)
  })
}
