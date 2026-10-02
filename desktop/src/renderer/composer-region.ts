import { ArrowUp, Brain, ChevronDown, CornerUpRight, Cpu, Folder, ListPlus, Square, renderIcon } from "./icons.ts"

export type ComposerElements = {
  prompt: HTMLTextAreaElement
  send: HTMLButtonElement
  steer?: HTMLButtonElement
  interrupt: HTMLButtonElement
  menuTrigger: HTMLButtonElement
  menu: HTMLElement
  compactContext: HTMLButtonElement
  slashCommandMenu: HTMLElement
  contextMeter: HTMLElement
  attachButton?: HTMLButtonElement | null
}

export type PendingInput = {
  inputId: string
  input: string
  mode: "follow_up" | "steering"
  promoting: boolean
  recalling: boolean
}

export type ComposerView = {
  ready: boolean
  active: boolean
  readOnly: boolean
  starting: boolean
  hasContent?: boolean
  controllingTurn: boolean
  runtimeSessionId: string
  composerMenuOpen: boolean
  compacting: boolean
  slashCommandPending: boolean
  slashCommandInput: string
  contextUsagePercent: number | null
}

export function composerRegionMarkup() {
  return `
    <div class="composer-region">
      <div id="pending-input-dock" class="pending-input-dock" aria-label="Queued messages" hidden></div>
      <div id="attachment-chips" class="attachment-chips" hidden></div>
      <form id="composer" class="composer">
        <div class="composer-context">
          <div class="composer-select-wrap project-control">
            <button id="project-menu-trigger" type="button" class="composer-select-trigger" title="Working folder" aria-label="Working folder" aria-haspopup="listbox" aria-controls="project-menu" aria-expanded="false">${renderIcon(Folder)}<span id="project-menu-label" class="composer-select-label">Working folder</span></button>
            <div id="project-menu" class="composer-select-menu" role="listbox" aria-label="Working directories" hidden></div>
          </div>
          <span id="composer-activity" class="composer-activity" role="status"><span class="activity-motion" aria-hidden="true"><i></i><i></i><i></i></span><span id="composer-activity-text">Ready</span></span>
        </div>
        <div class="prompt-wrap">
          <div id="slash-command-menu" class="slash-command-menu" role="listbox" aria-label="Slash commands" hidden></div>
          <textarea id="prompt" rows="2" placeholder="Message Rind — Enter to send, Shift+Enter for a new line" aria-label="Message Rind" aria-controls="slash-command-menu" aria-expanded="false" autocomplete="off"></textarea>
        </div>
        <div class="composer-footer">
          <div class="composer-menu-wrap">
            <button id="composer-menu-trigger" type="button" class="composer-menu-trigger" title="More chat actions" aria-label="More chat actions" aria-haspopup="menu" aria-expanded="false">+</button>
            <div id="composer-menu" class="composer-menu" role="menu" hidden>
              <button id="compact-context" type="button" role="menuitem"><span class="compact-label">Compact context</span></button>
            </div>
          </div>
          <button id="attach-button" type="button" class="composer-menu-trigger attach-trigger" title="Attach files" aria-label="Attach files">${paperclipIcon()}</button>
          <input id="attach-input" type="file" multiple hidden />
          <div class="composer-select-wrap model-control">
            <button id="model-menu-trigger" type="button" class="composer-select-trigger" title="Choose model" aria-label="Choose model" aria-haspopup="listbox" aria-controls="model-menu" aria-expanded="false">${renderIcon(Cpu)}<span id="model-menu-label" class="composer-select-label">Model</span>${renderIcon(ChevronDown, "select-chevron")}</button>
            <div id="model-menu" class="composer-select-menu" role="listbox" aria-label="Models" hidden></div>
          </div>
          <div class="composer-select-wrap effort-control">
            <button id="effort-menu-trigger" type="button" class="composer-select-trigger" title="Choose reasoning effort" aria-label="Choose reasoning effort" aria-haspopup="listbox" aria-controls="effort-menu" aria-expanded="false">${renderIcon(Brain)}<span id="effort-menu-label" class="composer-select-label">Effort</span>${renderIcon(ChevronDown, "select-chevron")}</button>
            <div id="effort-menu" class="composer-select-menu" role="listbox" aria-label="Reasoning effort" hidden></div>
          </div>
          <button type="button" id="context-meter" class="context-meter" data-tooltip="Open the Context tab" aria-controls="inspector" hidden></button>
          <span class="composer-spacer"></span>
          <div class="send-control">
            <button id="send" type="submit" class="send-button" aria-label="Send message"><span class="send-icon">${renderIcon(ArrowUp)}</span></button>
            <button id="send-options" type="button" class="send-options" aria-label="Message actions" aria-haspopup="menu" aria-expanded="false" aria-controls="send-actions-menu">${renderIcon(ChevronDown)}</button>
            <div id="send-actions-menu" class="composer-menu send-actions-menu" role="menu" aria-label="Running turn actions" hidden>
              <button id="queue-message" type="button" role="menuitem">${renderIcon(ListPlus)}<span>Send after this turn</span><kbd>Enter</kbd></button>
              <button id="steer" type="button" role="menuitem">${renderIcon(CornerUpRight)}<span>Steer this turn</span><kbd>Alt+Enter</kbd></button>
              <div role="separator"></div>
              <button id="interrupt" type="button" role="menuitem" class="danger">${renderIcon(Square)}<span>Stop active turn</span></button>
            </div>
          </div>
        </div>
      </form>
    </div>
  `
}

function paperclipIcon() {
  return `<svg class="attach-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`
}

export function renderComposer(elements: ComposerElements, view: ComposerView) {
  const unavailable = !view.ready || view.readOnly || view.compacting || view.slashCommandPending
  elements.prompt.disabled = !view.ready || view.readOnly
  elements.prompt.placeholder = view.slashCommandPending
    ? `Running ${view.slashCommandInput || "command"}...`
    : view.compacting
    ? "Compacting context… You can prepare your next message."
    : view.readOnly
    ? "Return to the current task to send a message"
    : view.controllingTurn
    ? "Enter to queue a follow-up, Alt+Enter to steer"
    : "Message Rind — Enter to send, Shift+Enter for a new line"
  const hasContent = view.hasContent ?? Boolean(elements.prompt.value.trim())
  const stopping = view.active && (!hasContent || view.compacting)
  elements.send.disabled = stopping ? !view.controllingTurn || view.readOnly : unavailable || view.starting || !hasContent
  const action = stopping ? "stop" : view.active ? "queue" : "send"
  if (elements.send.dataset.action !== action) {
    elements.send.dataset.action = action
    const icon = elements.send.querySelector(".send-icon")
    if (icon) icon.innerHTML = renderIcon(stopping ? Square : view.active ? ListPlus : ArrowUp)
  }
  elements.send.classList.toggle("stop", stopping)
  elements.send.setAttribute("aria-label", stopping ? "Stop active turn" : view.active ? "Send queued message" : "Send message")
  if (elements.steer) {
    elements.steer.disabled = unavailable || !hasContent || !view.controllingTurn
  }
  elements.send.title = stopping ? "Stop active turn (Esc)" : view.slashCommandPending
    ? `Running ${view.slashCommandInput || "command"}`
    : view.compacting
    ? "Context compaction is in progress"
    : view.readOnly
    ? "Return to the current task before sending"
    : view.starting ? "Waiting for the task to start" : view.active ? "Queue as follow-up for the running turn" : "Send message"
  elements.interrupt.disabled = !view.ready || !view.controllingTurn || view.readOnly
  elements.menuTrigger.disabled = !view.ready || !view.runtimeSessionId || view.readOnly || view.active || view.compacting || view.slashCommandPending
  elements.menuTrigger.setAttribute("aria-expanded", String(view.composerMenuOpen))
  elements.menu.hidden = !view.composerMenuOpen
  elements.compactContext.disabled = !view.ready || !view.runtimeSessionId || view.readOnly || view.active || view.compacting || view.slashCommandPending
  const compactLabel = elements.compactContext.querySelector<HTMLElement>(".compact-label")
  if (compactLabel) compactLabel.textContent = view.compacting ? "Compacting..." : "Compact context"
  const attach = elements.attachButton
  if (attach) {
    attach.disabled = !view.ready || view.compacting || view.slashCommandPending
    attach.title = view.ready ? "Attach files" : "Attach files after the runtime is ready"
  }
  renderContextMeter(elements.contextMeter, view.contextUsagePercent)
}

export function syncPendingInputDock(
  dock: HTMLElement,
  inputs: PendingInput[],
  onPromote: (inputId: string) => void,
  onRecall: (inputId: string) => void,
) {
  const existing = new Map<string, HTMLElement>()
  for (const element of dock.querySelectorAll<HTMLElement>("[data-pending-input-id]")) {
    const inputId = element.dataset.pendingInputId
    if (inputId) existing.set(inputId, element)
  }

  for (const [index, input] of inputs.entries()) {
    let item = existing.get(input.inputId)
    if (!item) {
      item = document.createElement("div")
      item.className = "pending-input-item"
      item.dataset.pendingInputId = input.inputId

      const content = document.createElement("div")
      content.className = "pending-input-content"
      const mode = document.createElement("span")
      mode.className = "pending-input-mode"
      const text = document.createElement("span")
      text.className = "pending-input-text"
      content.append(mode, text)

      const actions = document.createElement("div")
      actions.className = "pending-input-actions"
      const promote = document.createElement("button")
      promote.type = "button"
      promote.className = "ghost-button pending-input-promote"
      promote.textContent = "Steer"
      promote.addEventListener("click", () => onPromote(input.inputId))
      const recall = document.createElement("button")
      recall.type = "button"
      recall.className = "ghost-button pending-input-recall"
      recall.textContent = "Recall"
      recall.addEventListener("click", () => onRecall(input.inputId))
      actions.append(promote, recall)
      item.append(content, actions)
    }

    const mode = item.querySelector<HTMLElement>(".pending-input-mode")
    const text = item.querySelector<HTMLElement>(".pending-input-text")
    const promote = item.querySelector<HTMLButtonElement>(".pending-input-promote")
    const recall = item.querySelector<HTMLButtonElement>(".pending-input-recall")
    if (mode) mode.textContent = input.mode === "steering" || input.promoting ? "Steering" : "Queue"
    if (text) text.textContent = input.input
    if (promote) {
      promote.hidden = input.mode === "steering"
      promote.disabled = input.promoting || input.recalling
      promote.textContent = input.promoting ? "Steering..." : "Steer"
      promote.title = "Apply this queued message as steering"
    }
    if (recall) {
      recall.hidden = false
      recall.disabled = input.promoting || input.recalling
      recall.textContent = input.recalling ? "Recalling..." : "Recall"
      recall.title = input.mode === "steering"
        ? "Recall this steering message"
        : "Recall this queued message"
    }
    if (dock.children[index] !== item) dock.append(item)
    existing.delete(input.inputId)
  }

  for (const stale of existing.values()) stale.remove()
  dock.hidden = inputs.length === 0
}

const METER_RADIUS = 6
const METER_CIRCUMFERENCE = 2 * Math.PI * METER_RADIUS
const METER_HOT = 0.8
const meterMarkup = new WeakMap<HTMLElement, string>()

/** 16px ring plus percentage (spec section 6); clicking it opens the Context tab. */
export function contextMeterMarkup(fraction: number) {
  const used = Math.min(1, Math.max(0, fraction))
  const offset = (METER_CIRCUMFERENCE * (1 - used)).toFixed(2)
  const circumference = METER_CIRCUMFERENCE.toFixed(2)
  return `<svg class="context-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle class="context-ring-track" cx="8" cy="8" r="${METER_RADIUS}"></circle><circle class="context-ring-value" cx="8" cy="8" r="${METER_RADIUS}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"></circle></svg><span>${Math.round(used * 100)}%</span>`
}

function renderContextMeter(meter: HTMLElement, fraction: number | null) {
  meter.hidden = fraction === null
  if (fraction === null) {
    meter.textContent = ""
    meterMarkup.delete(meter)
    meter.setAttribute("aria-label", "Open the Context tab")
    return
  }
  const markup = contextMeterMarkup(fraction)
  if (meterMarkup.get(meter) !== markup) {
    meter.innerHTML = markup
    meterMarkup.set(meter, markup)
  }
  meter.setAttribute("aria-label", `Context ${Math.round(fraction * 100)}% used. Open the Context tab`)
  meter.classList.toggle("context-hot", fraction >= METER_HOT)
}
