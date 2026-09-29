import { filterCommands, moveActiveIndex, type PaletteCommand } from "../palette.ts"
import { clipLine } from "../timeline-model.ts"
import { canOpenEffortMenu, canOpenModelMenu, closeModelMenu, reasoningEfforts, selectEffort, selectModel } from "./composer-menus.ts"
import { closeSlashCommandMenu } from "./composer.ts"
import { appRoot, paletteInput, paletteList, paletteOverlay, prompt, sessionTitle } from "./dom.ts"
import { setFilesOpen } from "./files-panel.ts"
import { escapeHtml } from "./html.ts"
import { changeGoalStatus, clearGoal, showGoalPanel, toggleTaskMonitor } from "./inspector.ts"
import { remoteAccess } from "./remote-instance.ts"
import { runAction, runtimeTurnActive } from "./runtime.ts"
import { exportSession, forkCurrentSession, knownSessions, startNewChat, switchSession } from "./sessions.ts"
import { openSettings } from "./settings.ts"
import { render, setTheme, toggleSidebar } from "./shell.ts"
import { deleteSessionRequest } from "./sidebar.ts"
import { compactCurrentSession } from "./slash-runner.ts"
import { state } from "./state.ts"



// ---------- command palette (C10) ----------

export function paletteCommands(): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    { id: "new-chat", title: "New chat", detail: "Start a new chat", shortcut: "Ctrl+N", run: () => runAction(startNewChat) },
    { id: "open-settings", title: "Open settings", detail: "Runtime settings", shortcut: "Ctrl+,", run: () => openSettings() },
    { id: "remote-access", title: "Remote access", detail: "Connect your phone or another browser", run: remoteAccess.open },
    { id: "export-conversation", title: "Export conversation", detail: "Save as Markdown", run: exportSession, disabled: !state.conversation.entries.length },
    { id: "fork-conversation", title: "Fork conversation", detail: "Continue in a separate session", run: () => runAction(forkCurrentSession), disabled: !state.viewedSessionId || runtimeTurnActive() },
    { id: "compact", title: "Compact context", detail: "Compact context", run: () => runAction(compactCurrentSession, state.viewedSessionId), disabled: !state.viewedSessionId },
    { id: "toggle-sidebar", title: "Toggle sidebar", detail: "Toggle projects sidebar", run: () => runAction(toggleSidebar) },
    { id: "toggle-files", title: "Toggle files panel", detail: "Toggle project files", run: () => runAction(() => setFilesOpen(!state.filesOpen)) },
    { id: "task-monitor", title: "Background tasks", detail: state.taskMonitorOpen ? "Close background task monitor" : "Open background task monitor", run: () => toggleTaskMonitor() },
    { id: "goal-set", title: "Goal: set", detail: "Set a session goal", run: () => showGoalPanel(true), disabled: !state.viewedSessionId },
    { id: "goal-pause", title: "Goal: pause", detail: "Pause the active goal", disabled: !state.viewedSessionId || state.goal.value?.status !== "active", run: () => runAction(() => changeGoalStatus("paused"), state.viewedSessionId) },
    { id: "goal-resume", title: "Goal: resume", detail: "Resume a paused goal", disabled: !state.viewedSessionId || state.goal.value?.status !== "paused", run: () => runAction(() => changeGoalStatus("active"), state.viewedSessionId) },
    { id: "goal-clear", title: "Goal: clear", detail: "Clear the active goal", disabled: !state.viewedSessionId || !state.goal.value, run: () => runAction(clearGoal, state.viewedSessionId) },
    { id: "theme-dark", title: "Theme: dark", detail: "Dark theme", run: () => setTheme("dark") },
    { id: "theme-light", title: "Theme: light", detail: "Light theme", run: () => setTheme("light") },
    { id: "theme-system", title: "Theme: system", detail: "Follow the OS theme", run: () => setTheme("system") },
    { id: "shortcuts", title: "Help: keyboard shortcuts", detail: "Keyboard shortcuts", shortcut: "?", run: () => { state.shortcutsOpen = true; render() } },
  ]
  if (state.viewedSessionId && !runtimeTurnActive()) {
    commands.push({ id: "delete-current", title: `Delete session: ${clipLine(sessionTitle.textContent || state.viewedSessionId, 32)}`, detail: state.viewedSessionId, run: () => runAction(() => deleteSessionRequest(state.viewedSessionId)) })
  }
  for (const session of knownSessions().filter((item) => item.id !== state.viewedSessionId).slice(0, 20)) {
    commands.push({
      id: `session-${session.id}`,
      title: `Switch session: ${clipLine(session.title || "Untitled", 40)}`,
      detail: clipLine(session.preview || session.id, 60),
      keywords: `switch session ${session.id}`,
      run: () => runAction(() => switchSession(session.id), session.id),
    })
  }
  if (canOpenModelMenu()) {
    for (const model of state.models.slice(0, 15)) {
      commands.push({
        id: `model-${model}`,
        title: `Model: ${model}`,
        keywords: `model ${model}`,
        run: () => runAction(() => selectModel(model)),
      })
    }
  }
  if (canOpenEffortMenu()) {
    for (const effort of reasoningEfforts) {
      commands.push({
        id: `effort-${effort}`,
        title: `Effort: ${effort}`,
        keywords: `reasoning effort ${effort}`,
        run: () => runAction(() => selectEffort(effort), state.viewedSessionId),
      })
    }
  }
  return commands
}

export function renderPalette() {
  paletteOverlay.hidden = !state.paletteOpen
  appRoot.classList.toggle("palette-open", state.paletteOpen)
  if (!state.paletteOpen) return
  if (document.activeElement !== paletteInput && paletteInput.value !== state.paletteQuery) paletteInput.value = state.paletteQuery
  const matches = filterCommands(paletteCommands(), state.paletteQuery)
  state.paletteActiveIndex = Math.min(state.paletteActiveIndex, Math.max(0, matches.length - 1))
  paletteList.innerHTML = matches.length ? matches.map((match, index) => `
    <button type="button" class="palette-option${index === state.paletteActiveIndex ? " selected" : ""}" role="option" aria-selected="${String(index === state.paletteActiveIndex)}" data-palette-index="${index}"${match.command.disabled ? " disabled" : ""}>
      <span class="palette-option-main">${escapeHtml(match.command.title)}</span>
      ${match.command.detail ? `<span class="palette-option-detail">${escapeHtml(match.command.detail)}</span>` : ""}
      ${match.command.shortcut ? `<span class="palette-option-shortcut">${escapeHtml(match.command.shortcut)}</span>` : ""}
    </button>
  `).join("") : `<p class="palette-empty">No matching command</p>`
  paletteList.querySelector<HTMLElement>(".palette-option.selected")?.scrollIntoView({ block: "nearest" })
}

export function openPalette() {
  state.paletteOpen = true
  state.paletteQuery = ""
  state.paletteActiveIndex = 0
  closeModelMenu()
  state.effortMenuOpen = false
  state.projectMenuOpen = false
  state.composerMenuOpen = false
  closeSlashCommandMenu()
  render()
  paletteInput.focus()
}

export function closePalette(refocus = true) {
  if (!state.paletteOpen) return
  state.paletteOpen = false
  state.paletteQuery = ""
  state.paletteActiveIndex = 0
  render()
  if (refocus) prompt.focus()
}

export function runPaletteCommand(index: number) {
  const matches = filterCommands(paletteCommands(), state.paletteQuery)
  const match = matches[index]
  if (!match || match.command.disabled) return
  closePalette(false)
  match.command.run()
}

export function bindPaletteEvents(): void {
  paletteInput.addEventListener("input", () => {
    state.paletteQuery = paletteInput.value
    state.paletteActiveIndex = 0
    renderPalette()
  })

  paletteInput.addEventListener("keydown", (event) => {
    const matches = filterCommands(paletteCommands(), state.paletteQuery)
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      state.paletteActiveIndex = moveActiveIndex(state.paletteActiveIndex, event.key === "ArrowDown" ? 1 : -1, matches.length)
      renderPalette()
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      runPaletteCommand(state.paletteActiveIndex)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      closePalette()
    }
  })

  paletteList.addEventListener("click", (event) => {
    const index = (event.target as HTMLElement).closest<HTMLElement>("[data-palette-index]")?.dataset.paletteIndex
    if (index !== undefined) runPaletteCommand(Number(index))
  })
}
