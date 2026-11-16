import { requiredElement, sidebarResizeHandle, sidebarToggle, topbarUpdateButton } from "./dom.ts"
import { openPalette } from "./palette-ui.ts"
import { runAction } from "./runtime.ts"
import { addProject, startNewChat } from "./sessions.ts"
import { openSettings } from "./settings.ts"
import { bindSidebarResize, nextTheme, render, scheduleRender, setTheme, toggleSidebar } from "./shell.ts"
import { state } from "./state.ts"

export function bindShellEvents(): void {
  requiredElement("sidebar-add-project").addEventListener("click", () => runAction(addProject))

  requiredElement("open-settings").addEventListener("click", () => openSettings())

  requiredElement("new-session").addEventListener("click", () => runAction(startNewChat))

  sidebarToggle.addEventListener("click", () => runAction(toggleSidebar))

  bindSidebarResize(sidebarResizeHandle)

  // ---------- topbar actions ----------

  document.getElementById("open-palette")?.addEventListener("click", () => openPalette())

  topbarUpdateButton.addEventListener("click", () => {
    runAction(async () => {
      state.update = await window.api.update.apply()
      render()
    })
  })

  document.getElementById("toggle-theme")?.addEventListener("click", () => setTheme(nextTheme()))

  window.addEventListener("resize", () => scheduleRender())
}
