import { closeComposerSelectMenus, closeModelMenu } from "./composer-menus.ts"
import { closeSlashCommandMenu } from "./composer.ts"
import { effortMenuTrigger, modelMenuTrigger, projectList, projectMenuTrigger, prompt } from "./dom.ts"
import { closePalette, openPalette } from "./palette-ui.ts"
import { cancelActiveTurn, runAction, runtimeTurnActive } from "./runtime.ts"
import { knownSessions, startNewChat, switchSession } from "./sessions.ts"
import { openSettings } from "./settings.ts"
import { render } from "./shell.ts"
import { resetDeleteConfirm } from "./sidebar.ts"
import { state } from "./state.ts"
import { type KeyBinding } from "./types.ts"



export function modifierPressed(event: KeyboardEvent) {
  return event.ctrlKey || event.metaKey
}

export function isTypingTarget(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (!target) return false
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable
}

export function quickSwitchSessions() {
  return knownSessions().filter((item) => item.id !== state.viewedSessionId).slice(0, 9)
}

export const keyBindings: KeyBinding[] = [
  {
    id: "palette",
    matches: (event) => modifierPressed(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k",
    run: (event) => {
      event.preventDefault()
      if (state.paletteOpen) closePalette()
      else openPalette()
    },
  },
  {
    id: "new-chat",
    matches: (event) => modifierPressed(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n",
    run: (event) => {
      event.preventDefault()
      runAction(startNewChat)
    },
  },
  {
    id: "settings",
    matches: (event) => modifierPressed(event) && !event.shiftKey && !event.altKey && event.key === ",",
    run: (event) => {
      event.preventDefault()
      openSettings()
    },
  },
  {
    id: "quick-session",
    matches: (event) => modifierPressed(event) && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key),
    run: (event) => {
      event.preventDefault()
      const session = quickSwitchSessions()[Number(event.key) - 1]
      if (session) runAction(() => switchSession(session.id), session.id)
    },
  },
  {
    id: "cheat-sheet",
    matches: (event) => event.key === "?" && !modifierPressed(event) && !isTypingTarget(event),
    run: (event) => {
      event.preventDefault()
      state.shortcutsOpen = !state.shortcutsOpen
      render()
    },
  },
  {
    id: "escape-chain",
    matches: (event) => event.key === "Escape",
    run: (event) => {
      if (state.paletteOpen) {
        event.preventDefault()
        closePalette()
        return
      }
      if (state.shortcutsOpen) {
        event.preventDefault()
        state.shortcutsOpen = false
        render()
        return
      }
      if (state.slashMenuOpen) {
        event.preventDefault()
        closeSlashCommandMenu()
        return
      }
      if (state.modelMenuOpen) {
        event.preventDefault()
        closeModelMenu()
        render()
        modelMenuTrigger.focus()
        return
      }
      if (state.effortMenuOpen) {
        event.preventDefault()
        state.effortMenuOpen = false
        render()
        effortMenuTrigger.focus()
        return
      }
      if (state.projectMenuOpen) {
        event.preventDefault()
        state.projectMenuOpen = false
        render()
        projectMenuTrigger.focus()
        return
      }
      if (state.composerMenuOpen) {
        state.composerMenuOpen = false
        render()
        prompt.focus()
        return
      }
      if (state.projectMenuPath) {
        const menuPath = state.projectMenuPath
        state.projectMenuPath = ""
        render()
        projectList.querySelector<HTMLButtonElement>(`[data-project-menu="${CSS.escape(menuPath)}"]`)?.focus()
        return
      }
      if (state.sessionDeleteConfirmId) {
        resetDeleteConfirm()
        render()
        return
      }
      if (state.settingsOpen || state.shortcutsOpen) return
      // Esc with nothing open: interrupt the active turn, else refocus the
      // composer ("stop" semantics, matching the web surface).
      if (runtimeTurnActive() && !state.settingsOpen) {
        cancelActiveTurn(state.viewedSessionId)
        return
      }
      prompt.focus()
    },
  },
]

export function bindKeyboard(): void {
  document.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229 || document.getElementById("remote-dialog")?.hasAttribute("open")) return
    for (const binding of keyBindings) {
      if (binding.matches(event)) {
        binding.run(event)
        return
      }
    }
  })

  document.addEventListener("pointerdown", (event) => {
    if ((state.modelMenuOpen || state.projectMenuOpen || state.effortMenuOpen) && !(event.target as HTMLElement).closest(".composer-select-wrap")) {
      closeComposerSelectMenus()
      render()
    }
    if (state.composerMenuOpen && !(event.target as HTMLElement).closest(".composer-menu-wrap")) {
      state.composerMenuOpen = false
      render()
    }
    if (state.projectMenuPath && !(event.target as HTMLElement).closest(".project-menu-wrap")) {
      state.projectMenuPath = ""
      render()
    }
    if (state.slashMenuOpen && !(event.target as HTMLElement).closest(".prompt-wrap")) closeSlashCommandMenu()
    if (state.paletteOpen && !(event.target as HTMLElement).closest(".command-palette-box")) closePalette(false)
    if (state.sessionDeleteConfirmId && !(event.target as HTMLElement).closest("[data-session-delete]")) {
      resetDeleteConfirm()
      render()
    }
  })
}
