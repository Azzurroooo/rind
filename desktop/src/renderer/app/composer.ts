import { runtimeMethods } from "../../preload/types.ts"
import { composeMessageWithAttachments } from "../attachments.ts"
import { restoreFailedDraft } from "../session-actions.ts"
import { commandPrefill, revealSlashCommandOption, type SlashCommand, slashCommandMenu as buildSlashCommandMenu } from "../slash-commands.ts"
import { addUserMessage } from "../timeline-model.ts"
import { isTurnNotActive } from "../turn-state.ts"
import { attachmentsFor, renderAttachments, waitForAttachments } from "./attachments-ui.ts"
import { prompt, slashCommandMenu } from "./dom.ts"
import { asRecord, escapeAttribute, escapeHtml } from "./html.ts"
import { addPendingInput, syncCurrentPendingInputs } from "./pending-inputs.ts"
import { conversationFor, ensureRuntime, ensureSession, requestForSession, runAction, setConversationFor } from "./runtime.ts"
import { chatProject, currentDraftKey, loadSessions, recordRecentSession, sessionTurnActive } from "./sessions.ts"
import { render } from "./shell.ts"
import { runSlash } from "./slash-runner.ts"
import { preparingPrompts, state } from "./state.ts"



export function canRetryLastPrompt() {
  const sessionId = state.viewedSessionId
  return Boolean(sessionId && state.lastPrompts[sessionId]?.trim() && !sessionTurnActive(sessionId))
}

export async function retryLastPrompt() {
  const sessionId = state.viewedSessionId
  const input = state.lastPrompts[sessionId]?.trim()
  if (!sessionId || !input || sessionTurnActive(sessionId)) return
  await ensureRuntime()
  setConversationFor(sessionId, addUserMessage(conversationFor(sessionId), input))
  if (state.viewedSessionId === sessionId) render()
  await startTurn(sessionId, input)
  await loadSessions()
  if (state.viewedSessionId === sessionId) render()
}

export function autoGrowPrompt() {
  const style = window.getComputedStyle(prompt)
  const lineHeight = Number.parseFloat(style.lineHeight) || 21
  const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  const minimum = lineHeight * 2 + verticalPadding
  const maximum = lineHeight * 7 + verticalPadding
  prompt.style.height = "auto"
  prompt.style.height = `${Math.max(minimum, Math.min(prompt.scrollHeight, maximum))}px`
  prompt.style.overflowY = prompt.scrollHeight > maximum ? "auto" : "hidden"
}

export function setPrompt(value: string, focus = false) {
  prompt.value = value
  if (state.chatProjectPath) state.drafts[currentDraftKey()] = value
  autoGrowPrompt()
  renderSlashCommandMenu()
  if (focus) prompt.focus()
}

export function renderSlashCommandMenu() {
  if (prompt.disabled) {
    closeSlashCommandMenu()
    return
  }
  const menu = buildSlashCommandMenu(state.slashCommands, prompt.value)
  if (!menu) {
    state.slashMenuOpen = false
    slashCommandMenu.hidden = true
    slashCommandMenu.replaceChildren()
    prompt.setAttribute("aria-expanded", "false")
    prompt.removeAttribute("aria-activedescendant")
    return
  }
  state.slashMenuOpen = true
  prompt.setAttribute("aria-expanded", "true")
  if (!menu.commands.length) {
    slashCommandMenu.innerHTML = `<p class="slash-command-empty">No matching command</p>`
    slashCommandMenu.hidden = false
    prompt.removeAttribute("aria-activedescendant")
    return
  }
  state.slashMenuActiveIndex = Math.min(state.slashMenuActiveIndex, menu.commands.length - 1)
  const active = menu.commands[state.slashMenuActiveIndex]
  prompt.setAttribute("aria-activedescendant", `slash-command-${active.name}`)
  slashCommandMenu.innerHTML = menu.commands.map((command, index) => `
    <button
      id="slash-command-${escapeAttribute(command.name)}"
      type="button"
      class="slash-command-option${index === state.slashMenuActiveIndex ? " selected" : ""}"
      role="option"
      aria-selected="${String(index === state.slashMenuActiveIndex)}"
      data-slash-command="${escapeAttribute(command.name)}"
    >
      <span class="slash-command-main"><code>/${escapeHtml(command.name)}</code><span>${escapeHtml(command.description)}</span></span>
      <span class="slash-command-usage">${escapeHtml(command.usage)}</span>
    </button>
  `).join("")
  slashCommandMenu.hidden = false
}

export function revealActiveSlashCommand() {
  revealSlashCommandOption(slashCommandMenu.querySelector<HTMLElement>(".slash-command-option.selected"))
}

export function closeSlashCommandMenu() {
  state.slashMenuOpen = false
  state.slashMenuActiveIndex = 0
  slashCommandMenu.hidden = true
  slashCommandMenu.replaceChildren()
  prompt.setAttribute("aria-expanded", "false")
  prompt.removeAttribute("aria-activedescendant")
}

export function selectSlashCommand(command: SlashCommand) {
  if (!command) return
  setPrompt(commandPrefill(command), true)
  closeSlashCommandMenu()
}

/** "queue" adds a follow-up to a running turn; "steer" injects it into the turn. */
export type RunningSendMode = "queue" | "steer"

export async function sendPrompt(mode: RunningSendMode = "queue") {
  const draftKey = currentDraftKey()
  if (preparingPrompts.has(draftKey)) return
  preparingPrompts.add(draftKey)
  try { await submitPrompt(draftKey, mode) }
  finally { preparingPrompts.delete(draftKey) }
}

export async function submitPrompt(draftKey: string, mode: RunningSendMode = "queue") {
  if (state.slashCommandPending) {
    state.notice = `Running ${state.slashCommandInput || "command"}...`
    render()
    return
  }
  const rawInput = prompt.value.trim()
  if (!rawInput) return
  const project = chatProject()
  if (!project?.available) {
    state.notice = "Choose a project before sending a message."
    render()
    return
  }
  if (rawInput.startsWith("/")) {
    prompt.value = ""
    state.drafts[currentDraftKey()] = ""
    autoGrowPrompt()
    closeSlashCommandMenu()
    runAction(() => runSlash(rawInput), state.viewedSessionId)
    return
  }
  // Wait for in-flight attachment uploads, then attach the ok chips' paths.
  if (attachmentsFor(state.chatProjectPath).length) {
    await waitForAttachments()
    if (currentDraftKey() !== draftKey || prompt.value.trim() !== rawInput) return
    const chips = attachmentsFor(state.chatProjectPath)
    const failed = chips.filter((chip) => chip.status === "failed")
    if (failed.length) {
      state.notice = `${failed.length} attachment(s) failed to upload. Retry or remove them before sending.`
      renderAttachments()
      render()
      return
    }
  }
  const chips = attachmentsFor(state.chatProjectPath)
  const input = composeMessageWithAttachments(rawInput, chips.map((chip) => chip.path))
  // Clear the composer (and its draft) before the request so the draft is
  // never left duplicated after a queued prompt.
  prompt.value = ""
  state.drafts[currentDraftKey()] = ""
  autoGrowPrompt()
  closeSlashCommandMenu()
  const projectPath = project.path
  const requestedSessionId = state.viewedSessionId
  const requestedModel = state.model || state.settings.model
  let sessionId = requestedSessionId
  let accepted = false
  const clearSentAttachments = () => {
    const sentIds = new Set(chips.map((chip) => chip.id))
    state.attachments[projectPath] = attachmentsFor(projectPath).filter((chip) => !sentIds.has(chip.id))
  }
  try {
    await ensureRuntime()
    sessionId = await ensureSession(projectPath, requestedSessionId, requestedModel)
    if (sessionTurnActive(sessionId)) {
      try {
        const result = asRecord(await requestForSession(mode === "steer" ? runtimeMethods.sessionSteer : runtimeMethods.sessionFollowUp, sessionId, { input }))
        accepted = true
        addPendingInput(sessionId, input, result)
        state.lastPrompts[sessionId] = input
        clearSentAttachments()
        syncCurrentPendingInputs()
        return
      } catch (error) {
        if (!isTurnNotActive(error)) throw error
        // A turn may finish between the local queue decision and the RPC.
        delete state.activeTurnIds[sessionId]
        delete state.pendingInputs[sessionId]
        syncCurrentPendingInputs()
      }
    }
    setConversationFor(sessionId, addUserMessage(conversationFor(sessionId), input))
    state.lastPrompts[sessionId] = input
    if (state.viewedSessionId === sessionId) render()
    const result = await startTurn(sessionId, input)
    accepted = true
    clearSentAttachments()
    if (typeof result.session_id === "string" && result.session_id) {
      await loadSessions()
      await recordRecentSession(result.session_id)
    }
  } catch (error) {
    const key = sessionId ? `${sessionId}:draft` : draftKey
    if (!accepted) {
      restoreFailedDraft(state.drafts, key, rawInput)
      if (currentDraftKey() === key) { prompt.value = state.drafts[key]; autoGrowPrompt() }
    }
    if (currentDraftKey() === key) state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    renderAttachments()
    if (state.viewedSessionId === sessionId) render()
  }
}

export async function startTurn(sessionId: string, input: string, transientSystemMessages?: unknown) {
  state.runtimeTurnPending[sessionId] = true
  if (state.viewedSessionId === sessionId) render()
  try {
    return asRecord(await requestForSession(runtimeMethods.sessionPrompt, sessionId, {
      input,
      ...(Array.isArray(transientSystemMessages) ? { transient_system_messages: transientSystemMessages } : {}),
    }))
  } finally {
    state.runtimeTurnPending[sessionId] = false
    if (state.viewedSessionId === sessionId) render()
  }
}

export function clearSlashCommandPending() {
  state.slashCommandPending = false
  state.slashCommandInput = ""
}
