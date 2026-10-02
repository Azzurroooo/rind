import "./dom.ts"
import { clearSlashCommandPending } from "./composer.ts"
import { requiredElement } from "./dom.ts"
import { remoteAccess } from "./remote-instance.ts"
import { handleRuntimeEvent } from "./runtime-events.ts"
import { clearRuntimeTurnState, runAction } from "./runtime.ts"
import { loadSessions, switchSession } from "./sessions.ts"
import { bindSessionHeadEvents } from "./session-head.ts"
import { loadSettings, openSettings } from "./settings.ts"
import { render, renderTheme } from "./shell.ts"
import { state, vars } from "./state.ts"
import { bindConversationEvents } from "./conversation-events.ts"
import { bindComposerEvents } from "./composer-events.ts"
import { bindKeyboard } from "./keyboard.ts"
import { bindShellEvents } from "./shell-events.ts"
import { bindSettingsEvents } from "./settings.ts"
import { bindSidebarEvents } from "./sidebar.ts"
import { bindFilesPanelEvents } from "./files-panel.ts"
import { bindInspectorEvents, refreshInspector } from "./inspector.ts"
import { bindGoalEvents } from "./inspector-goal.ts"
import { bindTasksEvents, stopTaskPolling } from "./inspector-tasks.ts"
import { bindPaletteEvents } from "./palette-ui.ts"
import { bindOverlays } from "./overlays.ts"


requiredElement("open-remote").addEventListener("click", remoteAccess.open)
bindSessionHeadEvents()

bindConversationEvents()
bindComposerEvents()
bindKeyboard()
bindShellEvents()
bindSettingsEvents()
bindSidebarEvents()
bindFilesPanelEvents()
bindInspectorEvents()
bindGoalEvents()
bindTasksEvents()
bindPaletteEvents()
bindOverlays()

const unsubscribeStatus = window.api.runtime.subscribe((snapshot) => {
  state.runtime = snapshot
  if (snapshot.status !== "ready") {
    vars.lastRuntimeSequence = 0
    clearRuntimeTurnState()
    stopTaskPolling()
  }
  if (snapshot.status === "error") {
    clearSlashCommandPending()
    state.notice = snapshot.message || "Runtime is unavailable."
    if (!state.settingsAutoOpened && snapshot.message?.includes("Configuration error")) {
      state.settingsAutoOpened = true
      openSettings()
      return
    }
  }
  render()
})
const unsubscribeEvents = window.api.runtime.subscribeEvents(handleRuntimeEvent)
const unsubscribeNotifyActivate = window.api.notifications.onActivate((sessionId) => {
  if (sessionId) runAction(() => switchSession(sessionId), sessionId)
})
const unsubscribeThemeChanged = window.api.prefs.onThemeChanged(() => {
  // nativeTheme flips (system mode); re-resolve the CSS dataset.
  renderTheme()
})
const themeMedia = window.matchMedia("(prefers-color-scheme: light)")
const onThemeMediaChange = () => { if (state.theme === "system") renderTheme() }
if (typeof themeMedia.addEventListener === "function") themeMedia.addEventListener("change", onThemeMediaChange)
window.addEventListener("beforeunload", () => {
  remoteAccess.dispose()
  unsubscribeStatus()
  unsubscribeEvents()
  unsubscribeNotifyActivate()
  unsubscribeThemeChanged()
  if (typeof themeMedia.removeEventListener === "function") themeMedia.removeEventListener("change", onThemeMediaChange)
}, { once: true })
runAction(async () => {
  await loadSessions()
  render()
  await refreshInspector()
})
void loadSettings()
