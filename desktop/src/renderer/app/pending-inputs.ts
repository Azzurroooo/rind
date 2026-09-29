import { runtimeMethods } from "../../preload/types.ts"
import { syncPendingInputDock } from "../composer-region.ts"
import { addUserMessage } from "../timeline-model.ts"
import { isTurnNotActive } from "../turn-state.ts"
import { setPrompt } from "./composer.ts"
import { pendingInputDock, prompt } from "./dom.ts"
import { asRecord, asRecordText } from "./html.ts"
import { conversationFor, requestForSession, runAction, setConversationFor } from "./runtime.ts"
import { render } from "./shell.ts"
import { state } from "./state.ts"



export function syncCurrentPendingInputs() {
  syncPendingInputDock(
    pendingInputDock,
    state.pendingInputs[state.viewedSessionId] || [],
    (inputId) => runAction(() => promoteFollowUp(inputId), state.viewedSessionId),
    (inputId) => runAction(() => recallPendingInput(inputId), state.viewedSessionId),
  )
}

export function addPendingInput(sessionId: string, input: string, result: Record<string, unknown>) {
  const inputId = asRecordText(result.input_id)
  if (!inputId) throw new Error("Runtime accepted queued input without input_id.")
  const pending = state.pendingInputs[sessionId] || []
  state.pendingInputs[sessionId] = [
    ...pending,
    { inputId, input, mode: result.mode === "steering" ? "steering" : "follow_up", promoting: false, recalling: false },
  ]
}

export function deliverPendingInput(sessionId: string, inputId: string) {
  if (!inputId) return false
  const pending = state.pendingInputs[sessionId]
  const index = pending?.findIndex((item) => item.inputId === inputId) ?? -1
  if (index < 0 || !pending) return false
  const input = pending[index]
  pending.splice(index, 1)
  if (!pending.length) delete state.pendingInputs[sessionId]
  if (sessionId) setConversationFor(sessionId, addUserMessage(conversationFor(sessionId), input.input))
  return true
}

export async function promoteFollowUp(inputId: string) {
  const sessionId = state.viewedSessionId
  const item = state.pendingInputs[sessionId]?.find((pending) => pending.inputId === inputId)
  if (!item || item.mode !== "follow_up" || item.promoting) return
  item.promoting = true
  syncCurrentPendingInputs()
  try {
    const result = asRecord(await requestForSession(runtimeMethods.sessionPromoteFollowUp, sessionId, { input_id: inputId }))
    if (asRecordText(result.input_id) !== inputId || result.mode !== "steering") {
      throw new Error("Runtime returned an invalid queued input promotion.")
    }
    item.mode = "steering"
    const pending = state.pendingInputs[sessionId]
    if (pending) {
      pending.splice(pending.indexOf(item), 1)
      pending.push(item)
    }
  } catch (error) {
    if (isTurnNotActive(error)) {
      // The turn (and its queues) are gone — the worker discarded pending
      // inputs on settle. Invalidate the dock instead of surfacing the race.
      delete state.pendingInputs[sessionId]
      syncCurrentPendingInputs()
      state.notice = "The turn has ended; queued input was discarded."
      render()
      return
    }
    throw error
  } finally {
    item.promoting = false
    syncCurrentPendingInputs()
  }
}

export async function recallPendingInput(inputId: string) {
  const sessionId = state.viewedSessionId
  const pending = state.pendingInputs[sessionId]
  const item = pending?.find((candidate) => candidate.inputId === inputId)
  if (!item || item.promoting || item.recalling) return
  item.recalling = true
  syncCurrentPendingInputs()
  try {
    const method = item.mode === "steering"
      ? runtimeMethods.sessionUnsteer
      : runtimeMethods.sessionDequeueFollowUp
    const result = asRecord(await requestForSession(method, sessionId, { input_id: item.inputId }))
    const input = asRecordText(result.input)
    if (result.retrieved !== true || result.mode !== item.mode || asRecordText(result.input_id) !== item.inputId || !input) {
      throw new Error("Runtime returned an invalid queued input retrieval.")
    }
    const index = pending.findIndex((candidate) => candidate.inputId === item.inputId)
    if (index < 0) throw new Error("Retrieved input is not present in the local queue.")
    pending.splice(index, 1)
    if (!pending.length) delete state.pendingInputs[sessionId]
    setPrompt([input, prompt.value].filter((value) => value.trim()).join("\n\n"), true)
  } catch (error) {
    if (isTurnNotActive(error)) {
      // The turn settled and the worker discarded its queues: the text lives
      // only in our chip now — hand it back to the composer instead of erroring.
      const index = pending.findIndex((candidate) => candidate.inputId === item.inputId)
      if (index >= 0) pending.splice(index, 1)
      if (pending.length === 0) delete state.pendingInputs[sessionId]
      setPrompt([asRecordText(item.input), prompt.value].filter((value) => value.trim()).join("\n\n"), true)
      state.notice = "The turn has ended; queued input was returned to the composer."
      render()
      return
    }
    throw error
  } finally {
    item.recalling = false
    syncCurrentPendingInputs()
  }
}
