import { type RuntimeMethod, runtimeMethods, sessionScopedMethods, turnScopedMethods } from "../../preload/types.ts"
import { dismissPlanError } from "../composer-region.ts"
import { sameProjectPath as samePath } from "../project-selection.ts"
import { createQuestionSelection, type QuestionSelection } from "../question-state.ts"
import { fallbackSlashCommands, parseSlashCommands, type SlashCommand } from "../slash-commands.ts"
import { clipLine, conversationFromLiveTurn, conversationFromReplay, type ConversationState, createConversation, mergeLiveConversation, mergeReplayConversation } from "../timeline-model.ts"
import { isTurnNotActive } from "../turn-state.ts"
import { asRecord, asRecordText } from "./html.ts"
import { syncCurrentPendingInputs } from "./pending-inputs.ts"
import { knownSessions, loadSessions, sessionTurnActive } from "./sessions.ts"
import { render } from "./shell.ts"
import { replayRequests, state, toolOpenRequests, vars } from "./state.ts"



export function conversationFor(sessionId: string) {
  return sessionId === state.viewedSessionId
    ? state.conversation
    : state.conversationCache[sessionId] || createConversation()
}

export function questionSelectionFor(question: NonNullable<ConversationState["question"]>): QuestionSelection {
  if (state.questionSelection?.questionId === question.toolCallId) return state.questionSelection
  const selection = createQuestionSelection(question.toolCallId, question.options.length)
  state.questionSelection = selection
  return selection
}

export function runtimeConversation() {
  return conversationFor(state.viewedSessionId)
}

export function activeTurnIdFor(sessionId: string) {
  return state.activeTurnIds[sessionId] || conversationFor(sessionId).activeTurnId || ""
}

export function runtimeTurnActive() {
  return sessionTurnActive(state.viewedSessionId)
}

export function setConversationFor(sessionId: string, conversation: ConversationState) {
  if (sessionId === state.viewedSessionId) {
    state.conversation = conversation
    return
  }
  state.conversationCache = { ...state.conversationCache, [sessionId]: conversation }
}

export function clearRuntimeTurnState() {
  state.runtimeTurnPending = {}
  state.activeTurnIds = {}
  state.pendingInputs = {}
  state.conversation = { ...state.conversation, activeTurnId: "", turnStartedAt: 0 }
  state.conversationCache = Object.fromEntries(
    Object.entries(state.conversationCache).map(([sessionId, conversation]) => [
      sessionId,
      { ...conversation, activeTurnId: "", turnStartedAt: 0 },
    ]),
  )
}

export function resetConversationPresentation(resetPlanDock = true) {
  state.expandedTools = new Set()
  state.revealedTools = new Set()
  state.stepGroups = new Map()
  toolOpenRequests.clear()
  vars.toolAnimationUntil = 0
  if (resetPlanDock) {
    state.planDock.collapsed = false
    state.planDock.sessionId = ""
  }
  dismissPlanError(state.conversation, state.viewedSessionId, state.planDock)
  vars.lastRenderedEntries = 0
}

export async function request(method: RuntimeMethod, params: Record<string, unknown> = {}) {
  const requestParams = { ...params }
  if (sessionScopedMethods.has(method) && state.viewedSessionId && !requestParams.session_id) {
    requestParams.session_id = state.viewedSessionId
  }
  const targetSessionId = typeof requestParams.session_id === "string" ? requestParams.session_id : ""
  try {
    const turnSessionId = targetSessionId || state.viewedSessionId
    if (turnScopedMethods.has(method) && turnSessionId && !requestParams.turn_id) {
      const turnId = activeTurnIdFor(turnSessionId)
      if (turnId) requestParams.turn_id = turnId
    }
    return await window.api.runtime.request(method, requestParams)
  } catch (error) {
    if (!targetSessionId || targetSessionId === state.viewedSessionId) {
      state.notice = error instanceof Error ? error.message : String(error)
      render()
    }
    throw error
  }
}

export async function requestForSession(method: RuntimeMethod, sessionId: string, params: Record<string, unknown> = {}) {
  const result = await request(method, { ...params, session_id: sessionId })
  const responseSessionId = asRecordText(asRecord(result).session_id)
  if (responseSessionId && responseSessionId !== sessionId) {
    throw new Error(`Runtime returned session ${responseSessionId} for requested session ${sessionId}.`)
  }
  return result
}

export async function ensureRuntime() {
  if (state.runtime.status === "ready") return state.runtime
  if (state.runtime.status !== "starting") {
    throw new Error(state.runtime.message || "Runtime is not available. Use Retry to restart it.")
  }
  render()
  try {
    applyRuntimeInitialization(await window.api.runtime.initialize())
    state.runtime = { status: "ready" }
    return state.runtime
  } finally {
    render()
  }
}

export async function restartRuntime(workspace: string) {
  state.runtime = await window.api.runtime.start(workspace)
  render()
  return ensureRuntime()
}

export function runAction(action: () => Promise<unknown>, sessionId = "") {
  void action().catch((error) => {
    if (sessionId && state.viewedSessionId !== sessionId) return
    state.notice = error instanceof Error ? error.message : String(error)
    render()
  })
}

export function cancelActiveTurn(sessionId: string) {
  void (async () => {
    try {
      await request(runtimeMethods.sessionCancel, sessionId ? { session_id: sessionId } : {})
    } catch (error) {
      if (isTurnNotActive(error)) {
        // The turn already ended worker-side: reconcile instead of surfacing a
        // race as an error (matches the web surface's quiet stop).
        delete state.activeTurnIds[sessionId]
        delete state.pendingInputs[sessionId]
        syncCurrentPendingInputs()
        if (sessionId === state.viewedSessionId) render()
        return
      }
      throw error
    }
  })().catch((error) => {
    if (sessionId && state.viewedSessionId !== sessionId) return
    state.notice = error instanceof Error ? error.message : String(error)
    render()
  })
}

export async function ensureSession(workspaceRoot: string, requestedSessionId?: string, requestedModel = "") {
  const currentSessionId = requestedSessionId === undefined ? state.viewedSessionId : requestedSessionId
  if (currentSessionId) return currentSessionId
  const created = asRecord(await request(runtimeMethods.sessionNew, { workspace_root: workspaceRoot }))
  const sessionId = asRecordText(created.session_id)
  if (!sessionId) throw new Error("Runtime did not create a session.")
  const selectedModel = requestedModel.trim() || state.model.trim() || state.settings.model.trim()
  const createdModel = asRecordText(created.model)
  state.sessionModels[sessionId] = createdModel || selectedModel
  const selectedEffort = asRecordText(created.reasoning_effort) || state.effort || state.settings.reasoningEffort
  if (selectedEffort) state.sessionEfforts[sessionId] = selectedEffort
  const bindToView = !state.viewedSessionId && samePath(state.chatProjectPath, workspaceRoot)
  if (bindToView) {
    state.viewedSessionId = sessionId
    state.viewedProjectPath = workspaceRoot
    state.model = state.sessionModels[sessionId]
    state.conversation = createConversation()
  } else {
    state.conversationCache = { ...state.conversationCache, [sessionId]: createConversation() }
  }
  if (selectedModel && selectedModel !== createdModel) {
    await requestForSession(runtimeMethods.modelSet, sessionId, { model: selectedModel })
    state.sessionModels[sessionId] = selectedModel
    if (state.viewedSessionId === sessionId) state.model = selectedModel
  }
  await loadSessions()
  return sessionId
}

export async function loadReplay(sessionId = state.viewedSessionId) {
  const pending = replayRequests.get(sessionId)
  if (pending) return pending
  const request = loadReplayNow(sessionId)
  replayRequests.set(sessionId, request)
  try {
    await request
  } finally {
    if (replayRequests.get(sessionId) === request) replayRequests.delete(sessionId)
  }
}

export async function loadReplayNow(sessionId: string) {
  if (!sessionId) return
  const session = knownSessions().find((item) => item.id === sessionId)
  if (!session) return
  await ensureRuntime()
  const result = asRecord(await requestForSession(runtimeMethods.sessionReplay, sessionId))
  const messages = Array.isArray(result.messages) ? result.messages : []
  const persisted = conversationFromReplay(messages)
  const live = conversationFor(sessionId)
  const liveSnapshot = asRecord(result.live_turn)
  const snapshotLive = conversationFromLiveTurn(liveSnapshot)
  const snapshotTurnId = asRecordText(liveSnapshot.turn_id)
  if (snapshotTurnId && snapshotLive.activeTurnId) state.activeTurnIds[sessionId] = snapshotTurnId
  else if (asRecord(result.turn_state).status === "running" && asRecordText(asRecord(result.turn_state).turn_id)) {
    state.activeTurnIds[sessionId] = asRecordText(asRecord(result.turn_state).turn_id)
  } else if (!snapshotTurnId) delete state.activeTurnIds[sessionId]
  const mergedLive = mergeLiveConversation(live, snapshotLive)
  const conversation = mergeReplayConversation(persisted, mergedLive)
  setConversationFor(sessionId, conversation)
  if (!state.pendingInputs[sessionId] && Array.isArray(liveSnapshot.pending_inputs)) {
    state.pendingInputs[sessionId] = liveSnapshot.pending_inputs.flatMap((item) => {
      const value = asRecord(item)
      const inputId = asRecordText(value.input_id)
      const input = asRecordText(value.input)
      const mode = value.mode === "steering" ? "steering" : "follow_up"
      return inputId && input ? [{ inputId, input, mode, promoting: false, recalling: false }] : []
    })
    if (!state.pendingInputs[sessionId].length) delete state.pendingInputs[sessionId]
  }
  if (sessionId === state.viewedSessionId) {
    const model = asRecordText(result.model)
    if (model) {
      state.sessionModels[sessionId] = model
      state.model = model
    }
    const replayEffort = asRecordText(result.reasoning_effort)
    if (replayEffort) state.sessionEfforts[sessionId] = replayEffort
    resetConversationPresentation(false)
  }
}

export function applyRuntimeInitialization(result: unknown) {
  const initialize = asRecord(result)
  if (!state.viewedSessionId && typeof initialize.model === "string") {
    state.model = initialize.model
  }
  if (typeof initialize.reasoning_effort === "string" && initialize.reasoning_effort) {
    state.effort = initialize.reasoning_effort
  }
  const commands = parseSlashCommands(initialize.commands)
  if (commands.length) state.slashCommands = mergeSlashCommands(fallbackSlashCommands, commands)
}

export function mergeSlashCommands(...groups: SlashCommand[][]) {
  const unique = new Map<string, SlashCommand>()
  for (const group of groups) {
    for (const command of group) unique.set(command.name, command)
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name))
}

// ---------- OS notifications (B5) ----------

// The main process ignores this when the window is focused or the user
// disabled notifications, so firing unconditionally here is safe.
export async function maybeNotify(sessionId: string, title: string, body: string) {
  if (!body && title !== "Rind asks a question") return
  try {
    await window.api.notifications.show({
      title,
      body: body ? clipLine(body.replace(/\s+/g, " ").trim(), 120) : "This session needs your input.",
      sessionId,
    })
  } catch {
    // Notifications are best-effort only.
  }
}

// Best-effort final assistant text for turn-completed notifications.
export function finalAssistantPreview(sessionId: string): string {
  const conversation = conversationFor(sessionId)
  for (let index = conversation.entries.length - 1; index >= 0; index -= 1) {
    const entry = conversation.entries[index]
    if (entry.kind === "assistant" && entry.content) return entry.content
    if (entry.kind === "error" || entry.kind === "notice") return entry.content
  }
  return ""
}

export async function answerQuestion(answer: string) {
  const sessionId = state.viewedSessionId
  if (!sessionTurnActive(sessionId)) return
  const question = state.conversation.question
  if (!question) return
  state.conversation = { ...state.conversation, question: undefined }
  state.questionSelection = undefined
  render()
  await requestForSession(runtimeMethods.userQuestionRespond, sessionId, { tool_call_id: question.toolCallId, answer })
}
