import { bindMenuNavigation } from "../menu-navigation.ts"
import { sendPrompt } from "./composer.ts"
import { prompt, requiredElement, send } from "./dom.ts"
import { cancelActiveTurn, runAction, runtimeTurnActive } from "./runtime.ts"
import { sessionCompacting, state } from "./state.ts"

const trigger = requiredElement<HTMLButtonElement>("send-options")
const menu = requiredElement("send-actions-menu")
const queue = requiredElement<HTMLButtonElement>("queue-message")

export function closeSendMenu() {
  menu.hidden = true
  trigger.setAttribute("aria-expanded", "false")
}

export function renderSendMenu() {
  trigger.disabled = !runtimeTurnActive()
  queue.disabled = send.disabled || !prompt.value.trim() || sessionCompacting()
  if (trigger.disabled) closeSendMenu()
}

export function bindSendActions() {
  const focusFirst = bindMenuNavigation(trigger, menu, closeSendMenu)
  trigger.addEventListener("click", () => {
    const open = menu.hidden
    menu.hidden = !open
    trigger.setAttribute("aria-expanded", String(open))
    if (open) focusFirst()
  })
  menu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button:not(:disabled)")) { closeSendMenu(); prompt.focus() }
  })
  queue.addEventListener("click", () => runAction(() => sendPrompt(), state.viewedSessionId))
  requiredElement<HTMLButtonElement>("steer").addEventListener("click", () => runAction(() => sendPrompt("steer"), state.viewedSessionId))
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target as HTMLElement).closest(".send-control")) closeSendMenu()
  })
  // A click on the primary action stops only while it displays the stop icon.
  send.addEventListener("click", (event) => {
    if (send.dataset.action !== "stop") return
    event.preventDefault()
    cancelActiveTurn(state.viewedSessionId)
  })
}
