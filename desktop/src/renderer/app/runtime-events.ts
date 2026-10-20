import { type RuntimeEvent } from "../../preload/types.ts"
import { mergeTasks, normalizeTask } from "../task-monitor.ts"
import { createConversation, reduceEvent } from "../timeline-model.ts"
import { decideTurnEvent } from "../turn-state.ts"
import { asRecordText } from "./html.ts"
import { refreshInspector } from "./inspector.ts"
import { loadGoal } from "./inspector-goal.ts"
import { renderTaskBadge, renderTasksSection } from "./inspector-tasks.ts"
import { deliverPendingInput } from "./pending-inputs.ts"
import { activeTurnIdFor, conversationFor, finalAssistantPreview, maybeNotify, resetConversationPresentation, runAction, setConversationFor } from "./runtime.ts"
import { loadSessions, recordRecentSession } from "./sessions.ts"
import { render, scheduleRender } from "./shell.ts"
import { renderRecentSessions } from "./sidebar.ts"
import { state, vars } from "./state.ts"




export function handleRuntimeEvent(envelope: RuntimeEvent) {
  // Sequence numbers restart at 1 with every worker process generation; adopt
  // the new generation instead of dropping the whole generation as "already
  // seen" (which poisoned turn state after a runtime restart).
  if (envelope.generation !== undefined && envelope.generation !== vars.runtimeEventGeneration) {
    vars.runtimeEventGeneration = envelope.generation
    vars.lastRuntimeSequence = 0
  }
  if (envelope.sequence <= vars.lastRuntimeSequence) return
  vars.lastRuntimeSequence = envelope.sequence

  if (envelope.type === "folder_defaults_changed") {
    runAction(() => loadSessions())
    return
  }

  const sessionId = envelope.sessionId
  const eventSessionId = asRecordText(envelope.event.session_id)
  if (!sessionId || (eventSessionId && eventSessionId !== sessionId)) return

  if (envelope.type === "session_renamed") {
    const nextTitle = asRecordText(envelope.event.title) || asRecordText(envelope.event.name)
    if (nextTitle) {
      state.recentSessions = state.recentSessions.map((item) => item.id === sessionId ? { ...item, title: nextTitle } : item)
      for (const [projectPath, list] of Object.entries(state.sessionPages)) {
        state.sessionPages[projectPath] = list.map((item) => item.id === sessionId ? { ...item, title: nextTitle } : item)
      }
      state.projects = state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((item) => item.id === sessionId ? { ...item, title: nextTitle } : item),
      }))
    }
    runAction(() => loadSessions(), sessionId)
    scheduleRender()
    return
  }

  if (envelope.type === "session_settings_changed") {
    const nextModel = asRecordText(envelope.event.model)
    const nextProvider = asRecordText(envelope.event.provider)
    const nextEffort = asRecordText(envelope.event.reasoning_effort)
    if (nextModel) state.sessionModels[sessionId] = nextModel
    if (nextEffort) state.sessionEfforts[sessionId] = nextEffort
    if (sessionId === state.viewedSessionId) {
      if (nextModel) state.model = nextModel
      if (nextProvider) state.modelProvider = nextProvider
      if (nextEffort) state.effort = nextEffort
      scheduleRender()
    }
    return
  }

  if (envelope.type === "session_deleted" || envelope.type === "session_discarded") {
    delete state.activeTurnIds[sessionId]
    delete state.pendingInputs[sessionId]
    delete state.runtimeTurnPending[sessionId]
    delete state.conversationCache[sessionId]
    state.recentSessions = state.recentSessions.filter((item) => item.id !== sessionId)
    for (const [projectPath, list] of Object.entries(state.sessionPages)) {
      state.sessionPages[projectPath] = list.filter((item) => item.id !== sessionId)
    }
    if (sessionId === state.viewedSessionId) {
      state.viewedSessionId = ""
      state.conversation = createConversation()
      resetConversationPresentation()
    }
    runAction(() => loadSessions())
    scheduleRender()
    return
  }

  if (envelope.type === "task_updated" || envelope.type === "task_output") {
    if (sessionId === state.viewedSessionId) {
      const task = normalizeTask(envelope.event.task)
      if (task.bg_id) {
        if (state.taskMonitor.refreshing) state.taskMonitor.updates[task.bg_id] = task
        state.taskMonitor.tasks = mergeTasks(state.taskMonitor.tasks, [...state.taskMonitor.tasks, task])
        if (!state.taskMonitor.cursors[task.bg_id] && !state.taskMonitor.reading.has(task.bg_id) && (task.stdout !== undefined || task.stderr !== undefined)) {
          state.taskMonitor.outputs[task.bg_id] = task
        }
        renderTaskBadge()
        if (state.inspectorOpen && state.inspectorTab === "activity") renderTasksSection()
      }
    }
    return
  }
  // The worker is authoritative about turn generations: never drop terminals
  // (they reconcile local state) and let a new turn_started supersede the
  // remembered generation (goal continuation / post-restart turns).
  const decision = decideTurnEvent(envelope.type, envelope.turnId, activeTurnIdFor(sessionId))
  if (decision.adopt) state.activeTurnIds[sessionId] = envelope.turnId
  const turnStarted = envelope.type === "turn_started"
  const turnSettled = decision.settle
  if (turnStarted || turnSettled) {
    state.runtimeTurnPending[sessionId] = turnStarted
  }
  if (turnStarted) {
    runAction(() => recordRecentSession(sessionId), sessionId)
  }
  if (envelope.type === "queued_input_delivered") {
    deliverPendingInput(sessionId, asRecordText(envelope.event.input_id))
  }
  if (envelope.type === "user_question_requested") {
    void maybeNotify(sessionId, "Rind asks a question", asRecordText(envelope.event.question))
  }
  const nextConversation = reduceEvent(conversationFor(sessionId), envelope)
  setConversationFor(sessionId, nextConversation)
  if (turnSettled) {
    delete state.activeTurnIds[sessionId]
    delete state.pendingInputs[sessionId]
    // Cancellations are user-initiated; they never warrant a notification.
    if (envelope.type !== "turn_cancelled") {
      void maybeNotify(sessionId, envelope.type === "turn_failed" ? "Turn failed" : "Turn completed", finalAssistantPreview(sessionId))
    }
    if (sessionId === state.viewedSessionId) {
      void loadGoal()
      void refreshInspector().catch(() => {})
    }
    runAction(async () => {
      await loadSessions()
      if (sessionId === state.viewedSessionId) render()
      else renderRecentSessions()
    }, sessionId)
  }
  if (sessionId === state.viewedSessionId) scheduleRender()
  else if (turnStarted || turnSettled) render()
}
