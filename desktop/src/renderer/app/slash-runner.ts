import { runtimeMethods } from "../../preload/types.ts"
import { executeLocalSlashCommand } from "../local-slash-commands.ts"
import { sameProjectPath as samePath } from "../project-selection.ts"
import { mergeSlashCatalog } from "../desktop-slash.ts"
import { parseSlashCommands } from "../slash-commands.ts"
import { addCommandResult, addUserMessage } from "../timeline-model.ts"
import { clearSlashCommandPending, setPrompt, startTurn } from "./composer.ts"
import { runDesktopSlash } from "./desktop-slash-runner.ts"
import { prompt } from "./dom.ts"
import { asRecord, asRecordText } from "./html.ts"
import { conversationFor, ensureRuntime, ensureSession, loadReplay, requestForSession, setConversationFor } from "./runtime.ts"
import { chatProject, currentRuntimeSnapshot, loadSessions, recordRecentSession } from "./sessions.ts"
import { render } from "./shell.ts"
import { state } from "./state.ts"



export async function runSlash(input: string) {
  if (await runDesktopSlash(input)) return
  const localResult = executeLocalSlashCommand(input, {
    settings: state.settings,
    runtime: currentRuntimeSnapshot(),
    sessionId: state.viewedSessionId,
    projectPath: state.chatProjectPath,
    commands: state.slashCommands,
  })
  if (localResult) {
    if (state.viewedSessionId && localResult.text) {
      setConversationFor(
        state.viewedSessionId,
        addCommandResult(conversationFor(state.viewedSessionId), input, localResult.text, localResult.display),
      )
    } else {
      state.notice = localResult.text
    }
    render()
    return
  }
  const project = chatProject()
  if (!project?.available) {
    state.notice = "Choose a project before running a command."
    render()
    return
  }
  const projectPath = project.path
  const requestedSessionId = state.viewedSessionId
  const requestedModel = state.model || state.settings.model
  const compacting = /^\/compact\s*$/i.test(input)
  state.slashCommandPending = true
  state.slashCommandInput = input
  if (compacting) {
    state.compacting = true
  }
  render()
  try {
    await ensureRuntime()
    const commandSessionId = await ensureSession(projectPath, requestedSessionId, requestedModel)
    const result = asRecord(await requestForSession(runtimeMethods.commandExecute, commandSessionId, { input }))
    const commands = parseSlashCommands(asRecord(result.display).commands)
    if (commands.length) state.slashCommands = mergeSlashCatalog(commands)
    const text = asRecordText(result.text)
    if (compacting && text.startsWith("Compact complete.")) {
      await loadReplay(commandSessionId)
      if (isCurrentSlashView(projectPath, commandSessionId)) {
        state.notice = "Context compacted. Session history remains visible."
      }
    } else if (text && canUpdateSlashSession(projectPath, commandSessionId)) {
      setConversationFor(
        commandSessionId,
        addCommandResult(conversationFor(commandSessionId), input, text, asRecord(result.display)),
      )
    }
    const prefill = typeof result.prompt_prefill === "string" ? result.prompt_prefill : ""
    if (prefill && isCurrentSlashView(projectPath, commandSessionId)) setPrompt(prefill, true)
    const nextPrompt = result.next_prompt && typeof result.next_prompt === "object"
      ? result.next_prompt as Record<string, unknown>
      : null
    const followUp = typeof nextPrompt?.input === "string" ? nextPrompt.input.trim() : ""
    if (followUp && canUpdateSlashSession(projectPath, commandSessionId)) {
      const inputId = crypto.randomUUID()
      setConversationFor(commandSessionId, addUserMessage(conversationFor(commandSessionId), followUp, inputId))
      const turn = await startTurn(commandSessionId, followUp, nextPrompt?.transient_system_messages, inputId)
      if (typeof turn.session_id === "string" && turn.session_id) {
        await loadSessions()
        await recordRecentSession(turn.session_id)
      }
    }
  } finally {
    state.compacting = false
    clearSlashCommandPending()
    render()
  }
}

export function isCurrentSlashView(projectPath: string, sessionId: string) {
  return samePath(state.chatProjectPath, projectPath)
    && state.viewedSessionId === sessionId
}

export function canUpdateSlashSession(projectPath: string, sessionId: string) {
  return isCurrentSlashView(projectPath, sessionId)
    || Boolean(sessionId && Object.hasOwn(state.conversationCache, sessionId))
}

export async function compactCurrentSession() {
  const project = chatProject()
  if (!project?.available || !state.viewedSessionId) return
  const sessionId = state.viewedSessionId
  state.compacting = true
  render()
  try {
    await ensureRuntime()
    const record = asRecord(await requestForSession(runtimeMethods.sessionCompact, sessionId))
    await loadReplay(sessionId)
    if (state.viewedSessionId === sessionId) state.notice = compactNotice(record)
  } finally {
    state.compacting = false
    render()
    prompt.focus()
  }
}

export function compactNotice(record: Record<string, unknown>) {
  const source = asRecord(record.source)
  const start = source.message_start_index
  const end = source.message_end_index_exclusive
  if (typeof start === "number" && typeof end === "number") {
    return `Context compacted from messages ${start + 1}-${end}. Session history remains visible.`
  }
  return "Context compacted. Session history remains visible."
}
