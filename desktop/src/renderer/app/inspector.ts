import { runtimeMethods } from "../../preload/types.ts"
import { normalizeGoal, renderGoalPanel } from "../goal-panel.ts"
import { readTaskOutput, refreshTaskPages, renderTaskMonitor, runningTaskCount } from "../task-monitor.ts"
import { clipLine } from "../timeline-model.ts"
import { goalPanel, goalPanelShell, taskMonitorDock, taskMonitorShell } from "./dom.ts"
import { asRecord } from "./html.ts"
import { requestForSession, runAction } from "./runtime.ts"
import { currentRuntimeSnapshot } from "./sessions.ts"
import { render } from "./shell.ts"
import { state, vars } from "./state.ts"



// ---------- background task monitor (B6) ----------

export function renderTaskMonitorDock() {
  const monitor = state.taskMonitor
  taskMonitorShell.hidden = !state.taskMonitorOpen
  const toggle = document.getElementById("toggle-tasks")
  const running = runningTaskCount(monitor.tasks)
  const badge = document.getElementById("task-count-badge")
  if (badge) {
    badge.hidden = !running
    badge.textContent = running ? String(running) : ""
  }
  if (toggle) {
    toggle.setAttribute("aria-label", running ? `Toggle background task monitor, ${running} running` : "Toggle background task monitor")
    toggle.setAttribute("aria-expanded", String(state.taskMonitorOpen))
  }
  if (!state.taskMonitorOpen) return
  renderTaskMonitor({ shell: taskMonitorShell, dock: taskMonitorDock }, monitor)
}

export function toggleTaskMonitor(open?: boolean) {
  const next = open === undefined ? !state.taskMonitorOpen : open
  state.taskMonitorOpen = next
  if (!next) {
    stopTaskMonitorPolling()
    render()
    return
  }
  render()
  void pollTaskMonitor().catch(() => {})
  if (!vars.taskMonitorTimer && state.viewedSessionId && currentRuntimeSnapshot().status === "ready") {
    vars.taskMonitorTimer = setInterval(() => { void pollTaskMonitor().catch(() => {}) }, 2000)
  }
}

export function stopTaskMonitorPolling() {
  if (vars.taskMonitorTimer) {
    clearInterval(vars.taskMonitorTimer)
    vars.taskMonitorTimer = undefined
  }
}

export async function pollTaskMonitor(more = false) {
  if (!state.taskMonitorOpen || !state.viewedSessionId || currentRuntimeSnapshot().status !== "ready") {
    stopTaskMonitorPolling()
    return
  }
  const monitor = state.taskMonitor
  if (monitor.refreshing) return
  const sessionId = state.viewedSessionId
  const pending = refreshTaskPages(monitor, (token) => requestForSession(runtimeMethods.taskList, sessionId, token ? { page_token: token } : {}), more)
  renderTaskMonitorDock()
  await pending
  if (monitor !== state.taskMonitor) return
  const expandedId = monitor.expandedId
  if (expandedId && !monitor.reading.has(expandedId)) {
    await loadTaskOutput(expandedId)
  }
  if (monitor === state.taskMonitor) renderTaskMonitorDock()
}

export async function loadTaskOutput(taskId: string, cursor = state.taskMonitor.cursors[taskId]) {
  const monitor = state.taskMonitor
  const sessionId = state.viewedSessionId
  if (!sessionId) return
  const pending = readTaskOutput(monitor, (id, position) => requestForSession(runtimeMethods.taskRead, sessionId, {
    task_id: id, max_output_chars: 20000, ...(position ? { cursor: position } : {}),
  }), taskId, cursor)
  renderTaskMonitorDock()
  await pending
  if (monitor === state.taskMonitor) renderTaskMonitorDock()
}

// ---------- goal panel (B7) ----------

export function renderGoalDock() {
  goalPanelShell.hidden = !state.goal.visible
  if (!state.goal.visible) return
  renderGoalPanel({ shell: goalPanelShell, panel: goalPanel }, {
    goal: state.goal.value,
    busy: state.goal.busy,
    setOpen: state.goal.setOpen,
    draft: state.goal.draft,
  })
}

export function showGoalPanel(open = true) {
  state.goal.visible = open
  state.goal.setOpen = open && !state.goal.value ? true : open && state.goal.setOpen
  render()
  if (open) goalPanel.querySelector<HTMLInputElement>("#goal-objective-input")?.focus()
}

export async function loadGoal() {
  const sessionId = state.viewedSessionId
  if (!sessionId || currentRuntimeSnapshot().status !== "ready") {
    state.goal.value = undefined
    if (state.goal.visible) renderGoalDock()
    return
  }
  const sequence = ++vars.goalLoadSequence
  try {
    const result = asRecord(await window.api.goal.get(sessionId))
    if (sequence !== vars.goalLoadSequence || sessionId !== state.viewedSessionId) return
    state.goal.value = normalizeGoal(result.goal)
    if (state.goal.visible) renderGoalDock()
  } catch {
    if (sequence === vars.goalLoadSequence) state.goal.value = undefined
  }
}

export async function submitGoal() {
  const sessionId = state.viewedSessionId
  const objective = state.goal.draft.trim()
  if (!sessionId || !objective || state.goal.busy) return
  state.goal.busy = true
  renderGoalDock()
  try {
    const result = asRecord(await window.api.goal.set(sessionId, objective))
    state.goal.value = normalizeGoal(result.goal)
    state.goal.draft = ""
    state.goal.setOpen = false
    state.notice = state.goal.value ? `Goal set: ${clipLine(state.goal.value.objective, 80)}` : state.notice
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    state.goal.busy = false
    render()
  }
}

export async function changeGoalStatus(status: "active" | "paused") {
  const sessionId = state.viewedSessionId
  if (!sessionId || state.goal.busy) return
  state.goal.busy = true
  renderGoalDock()
  try {
    const result = asRecord(await window.api.goal.status(sessionId, status))
    state.goal.value = normalizeGoal(result.goal)
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    state.goal.busy = false
    render()
  }
}

export async function clearGoal() {
  const sessionId = state.viewedSessionId
  if (!sessionId || state.goal.busy) return
  state.goal.busy = true
  renderGoalDock()
  try {
    await window.api.goal.clear(sessionId)
    state.goal.value = undefined
    state.notice = "Goal cleared."
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    state.goal.busy = false
    render()
  }
}

export function bindInspectorEvents(): void {
  // ---------- task monitor / goal panel / palette interactions ----------
  
  taskMonitorDock.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    if (target.closest("[data-task-more]")) {
      void pollTaskMonitor(true)
      return
    }
    const outputAction = target.closest<HTMLButtonElement>("[data-task-output]")
    if (outputAction?.dataset.taskId) {
      const taskId = outputAction.dataset.taskId
      const output = state.taskMonitor.outputs[taskId]
      const cursor = outputAction.dataset.taskOutput === "next" ? output?.next_cursor : outputAction.dataset.taskOutput === "start" ? output?.start_cursor : ""
      void loadTaskOutput(taskId, cursor)
      return
    }
    const action = target.closest<HTMLButtonElement>("[data-task-action]")
    if (action) {
      const sessionId = state.viewedSessionId
      const taskId = action.dataset.taskId
      if (!sessionId || !taskId) return
      action.disabled = true
      runAction(async () => {
        try {
          await requestForSession(action.dataset.taskAction === "cancel" ? runtimeMethods.taskCancel : runtimeMethods.taskReleaseWait, sessionId, { task_id: taskId })
          if (state.viewedSessionId === sessionId) await pollTaskMonitor()
        } finally { action.disabled = false }
      }, sessionId)
      return
    }
    if (target.closest<HTMLButtonElement>("[data-task-close]")) {
      toggleTaskMonitor(false)
      return
    }
    const bgId = target.closest<HTMLButtonElement>("[data-toggle-task]")?.dataset.toggleTask
    if (!bgId) return
    state.taskMonitor.expandedId = state.taskMonitor.expandedId === bgId ? "" : bgId
    renderTaskMonitorDock()
    if (state.taskMonitor.expandedId && state.viewedSessionId) {
      void loadTaskOutput(state.taskMonitor.expandedId)
    }
  })

  goalPanel.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    if (target.closest<HTMLButtonElement>("[data-goal-pause]")) {
      runAction(() => changeGoalStatus("paused"), state.viewedSessionId)
      return
    }
    if (target.closest<HTMLButtonElement>("[data-goal-resume]")) {
      runAction(() => changeGoalStatus("active"), state.viewedSessionId)
      return
    }
    if (target.closest<HTMLButtonElement>("[data-goal-clear]")) {
      runAction(clearGoal, state.viewedSessionId)
      return
    }
    if (target.closest<HTMLButtonElement>("[data-toggle-goal-set]")) {
      state.goal.setOpen = true
      renderGoalDock()
      goalPanel.querySelector<HTMLInputElement>("#goal-objective-input")?.focus()
      return
    }
    if (target.closest<HTMLButtonElement>("[data-goal-cancel]")) {
      state.goal.setOpen = false
      state.goal.draft = ""
      renderGoalDock()
      return
    }
    if (target.closest<HTMLButtonElement>("[data-goal-close]")) {
      showGoalPanel(false)
      return
    }
    if (target.closest<HTMLButtonElement>("[data-goal-submit]")) {
      runAction(submitGoal, state.viewedSessionId)
    }
  })

  goalPanel.addEventListener("input", (event) => {
    const input = event.target as HTMLElement
    if (input.id !== "goal-objective-input" || !(input instanceof HTMLInputElement)) return
    state.goal.draft = input.value
    const submit = goalPanel.querySelector<HTMLButtonElement>("[data-goal-submit]")
    if (submit) submit.disabled = state.goal.busy || !input.value.trim()
  })

  goalPanel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || event.target.id !== "goal-objective-input") return
    event.preventDefault()
    runAction(submitGoal, state.viewedSessionId)
  })
}
