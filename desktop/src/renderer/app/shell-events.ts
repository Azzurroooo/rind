import { requiredElement, settingsNotifications, shortcutsDialog, sidebarResizeHandle, sidebarToggle } from "./dom.ts"
import { openPalette } from "./palette-ui.ts"
import { runAction } from "./runtime.ts"
import { addProject, startNewChat } from "./sessions.ts"
import { openSettings } from "./settings.ts"
import { bindSidebarResize, nextTheme, render, setTheme, toggleSidebar } from "./shell.ts"
import { state } from "./state.ts"

export function bindShellEvents(): void {
  requiredElement("sidebar-add-project").addEventListener("click", () => runAction(addProject))

  requiredElement("open-settings").addEventListener("click", () => openSettings())

  requiredElement("new-session").addEventListener("click", () => runAction(startNewChat))

  sidebarToggle.addEventListener("click", () => runAction(toggleSidebar))

  bindSidebarResize(sidebarResizeHandle)

  // ---------- topbar actions ----------
  
  document.getElementById("open-palette")?.addEventListener("click", () => openPalette())

  document.getElementById("toggle-theme")?.addEventListener("click", () => setTheme(nextTheme()))

  document.getElementById("open-shortcuts")?.addEventListener("click", () => {
    state.shortcutsOpen = true
    render()
  })

  requiredElement("close-shortcuts").addEventListener("click", () => { state.shortcutsOpen = false; render() })

  requiredElement("dismiss-shortcuts").addEventListener("click", () => { state.shortcutsOpen = false; render() })

  shortcutsDialog.addEventListener("cancel", () => { state.shortcutsOpen = false; render() })

  settingsNotifications.addEventListener("change", () => {
    const enabled = settingsNotifications.checked
    state.notificationsEnabled = enabled
    runAction(async () => {
      await window.api.prefs.update({ notificationsEnabled: enabled })
    })
  })

  window.addEventListener("resize", () => render())
}
