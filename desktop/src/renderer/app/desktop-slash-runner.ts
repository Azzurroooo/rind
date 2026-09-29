// Runs desktop-owned slash commands (spec sections 6 and 8) against local UI.

import { runtimeMethods } from "../../preload/types.ts"
import { contextDisplayFrom, contextReportText } from "../context-report.ts"
import { desktopSlashAction, type DesktopSlashAction } from "../desktop-slash.ts"
import { addCommandResult } from "../timeline-model.ts"
import { selectEffort, selectModel, toggleEffortMenu, toggleModelMenu } from "./composer-menus.ts"
import { clearSlashCommandPending } from "./composer.ts"
import { sessionSearchInput } from "./dom.ts"
import { asRecord } from "./html.ts"
import { showGoalPanel, submitGoal } from "./inspector.ts"
import { conversationFor, ensureRuntime, requestForSession, setConversationFor } from "./runtime.ts"
import { forkCurrentSession } from "./sessions.ts"
import { showToast } from "./overlays.ts"
import { nextTheme, render, setTheme, toggleSidebar } from "./shell.ts"
import { state } from "./state.ts"

/** Returns true when the input was a desktop command and has been handled. */
export async function runDesktopSlash(input: string): Promise<boolean> {
  const action = desktopSlashAction(input)
  if (!action) return false
  clearSlashCommandPending()
  await perform(action, input)
  render()
  return true
}

async function perform(action: DesktopSlashAction, input: string) {
  if (action.type === "error") {
    showToast(action.message, "danger")
  } else if (action.type === "theme") {
    const theme = action.theme || nextTheme()
    setTheme(theme)
    showToast(`Theme: ${theme}`)
  } else if (action.type === "model") {
    await (action.model ? selectModel(action.model) : toggleModelMenu())
  } else if (action.type === "effort") {
    await (action.effort ? selectEffort(action.effort) : toggleEffortMenu())
  } else if (action.type === "goal") {
    await runGoal(action.objective)
  } else if (action.type === "fork") {
    if (!state.viewedSessionId) showToast("Open a session to fork it.")
    else await forkCurrentSession()
  } else if (action.type === "sessions") {
    await focusSessionSearch(action.query)
  } else if (action.type === "context") {
    await inspectContext(input)
  }
}

async function runGoal(objective: string) {
  if (!objective) {
    showGoalPanel(true)
    return
  }
  if (!state.viewedSessionId) {
    showToast("Open a session before setting a goal.")
    return
  }
  state.goal.draft = objective
  await submitGoal()
}

async function focusSessionSearch(query: string) {
  if (!state.sidebarOpen) await toggleSidebar()
  sessionSearchInput.value = query
  state.sessionSearch = query
  render()
  sessionSearchInput.focus()
  sessionSearchInput.select()
}

/** Shows the context breakdown as a command result in the viewed session. */
export async function inspectContext(input = "/context") {
  const sessionId = state.viewedSessionId
  if (!sessionId) {
    showToast("Open a session to inspect its context.")
    render()
    return
  }
  await ensureRuntime()
  const display = contextDisplayFrom(asRecord(await requestForSession(runtimeMethods.contextInspect, sessionId)))
  setConversationFor(sessionId, addCommandResult(conversationFor(sessionId), input, contextReportText(display), display))
  render()
}
