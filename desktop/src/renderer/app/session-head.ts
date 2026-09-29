// Conversation header (spec section 2): truncated session title, a running or
// idle status chip, and the tasks, inspector and overflow icon buttons.
import { requiredElement, sessionTitle } from "./dom.ts"
import { runAction, runtimeTurnActive } from "./runtime.ts"
import { exportSession, forkCurrentSession, knownSessions } from "./sessions.ts"
import { state } from "./state.ts"

const statusChip = requiredElement("session-status")
const statusText = requiredElement("session-status-text")
const menuTrigger = requiredElement<HTMLButtonElement>("session-head-menu-trigger")
const menu = requiredElement("session-head-menu")
const exportButton = requiredElement<HTMLButtonElement>("export-session")
const forkButton = requiredElement<HTMLButtonElement>("fork-session")

export function renderSessionHead() {
  const current = knownSessions().find((item) => item.id === state.viewedSessionId)
  const title = current?.title || (state.viewedSessionId ? "Session" : "New session")
  sessionTitle.textContent = title
  sessionTitle.title = title
  const running = runtimeTurnActive()
  statusChip.hidden = !state.viewedSessionId
  statusChip.classList.toggle("running", running)
  statusText.textContent = running ? "Running" : "Idle"
  exportButton.disabled = !state.conversation.entries.length
  forkButton.disabled = !state.viewedSessionId || running
  menuTrigger.disabled = exportButton.disabled && forkButton.disabled
  if (menuTrigger.disabled) setMenuOpen(false)
}

function menuItems() {
  return [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].filter((item) => !item.disabled)
}

function setMenuOpen(open: boolean, focusFirst = false) {
  menu.hidden = !open
  menuTrigger.setAttribute("aria-expanded", String(open))
  if (open && focusFirst) menuItems()[0]?.focus()
}

function closeMenu(restoreFocus: boolean) {
  if (menu.hidden) return
  setMenuOpen(false)
  if (restoreFocus) menuTrigger.focus()
}

function moveFocus(step: number) {
  const items = menuItems()
  if (!items.length) return
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  items[(index + step + items.length) % items.length]?.focus()
}

export function bindSessionHeadEvents() {
  menuTrigger.addEventListener("click", () => setMenuOpen(menu.hidden, true))
  menuTrigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return
    event.preventDefault()
    setMenuOpen(true, true)
  })
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      moveFocus(event.key === "ArrowDown" ? 1 : -1)
    } else if (event.key === "Tab") {
      closeMenu(false)
    }
  })
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target as HTMLElement).closest(".session-head-menu-wrap")) closeMenu(false)
  })
  exportButton.addEventListener("click", () => {
    closeMenu(true)
    runAction(exportSession, state.viewedSessionId)
  })
  forkButton.addEventListener("click", () => {
    closeMenu(true)
    runAction(forkCurrentSession, state.viewedSessionId)
  })
}
