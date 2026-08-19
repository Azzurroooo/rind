import { activePlan, clipLine, type ConversationState, type PlanEntry } from "./timeline-model.ts"

export type PlanDockPresentation = {
  collapsed: boolean
  sessionId: string
  dismissedPlanErrors: Set<string>
}

export type PlanDockElements = {
  shell: HTMLElement
  dock: HTMLElement
}

export type ComposerElements = {
  prompt: HTMLTextAreaElement
  send: HTMLButtonElement
  interrupt: HTMLButtonElement
  menuTrigger: HTMLButtonElement
  menu: HTMLElement
  compactContext: HTMLButtonElement
  slashCommandMenu: HTMLElement
  contextMeter: HTMLElement
}

export type PendingInput = {
  inputId: string
  input: string
  mode: "follow_up" | "steering"
  promoting: boolean
}

export type ComposerView = {
  ready: boolean
  active: boolean
  readOnly: boolean
  starting: boolean
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
      <div id="plan-dock-shell" class="plan-dock-shell" hidden>
        <section id="plan-dock" class="plan-dock" aria-label="Plan progress"></section>
      </div>
      <div id="pending-input-dock" class="pending-input-dock" aria-label="Queued messages" hidden></div>
      <form id="composer" class="composer">
        <div class="prompt-wrap">
          <div id="slash-command-menu" class="slash-command-menu" role="listbox" aria-label="Slash commands" hidden></div>
          <textarea id="prompt" rows="2" placeholder="Message Rind — Enter to send, Shift+Enter for a new line" aria-label="Message Rind" aria-controls="slash-command-menu" aria-expanded="false" autocomplete="off"></textarea>
        </div>
        <div class="composer-footer">
          <div class="composer-menu-wrap">
            <button id="composer-menu-trigger" type="button" class="composer-menu-trigger" title="More chat actions" aria-label="More chat actions" aria-haspopup="menu" aria-expanded="false">+</button>
            <div id="composer-menu" class="composer-menu" role="menu" hidden><button id="compact-context" type="button" role="menuitem"><span class="compact-label">Compact context</span></button></div>
          </div>
          <div class="composer-select-wrap model-control">
            <button id="model-menu-trigger" type="button" class="composer-select-trigger" title="Choose model" aria-label="Choose model" aria-haspopup="listbox" aria-controls="model-menu" aria-expanded="false"><span id="model-menu-label" class="composer-select-label">Model</span><span class="composer-select-chevron" aria-hidden="true"></span></button>
            <div id="model-menu" class="composer-select-menu" role="listbox" aria-label="Models" hidden></div>
          </div>
          <div class="composer-select-wrap project-control">
            <button id="project-menu-trigger" type="button" class="composer-select-trigger" title="Choose working directory" aria-label="Choose working directory" aria-haspopup="listbox" aria-controls="project-menu" aria-expanded="false"><span id="project-menu-label" class="composer-select-label">Working directory</span><span class="composer-select-chevron" aria-hidden="true"></span></button>
            <div id="project-menu" class="composer-select-menu" role="listbox" aria-label="Working directories" hidden></div>
          </div>
          <span id="context-meter" class="context-meter" hidden></span>
          <span class="composer-spacer"></span>
          <button id="interrupt" type="button" class="ghost-button danger" title="Stop the running turn (Esc)">Stop</button>
          <button id="send" type="submit" class="primary-button"><span class="send-label">Send</span><span class="send-spinner" aria-hidden="true"></span></button>
        </div>
      </form>
    </div>
  `
}

export function renderPlanDock(
  elements: PlanDockElements,
  conversation: ConversationState,
  sessionId: string,
  presentation: PlanDockPresentation,
) {
  const scrollTop = elements.dock.querySelector<HTMLElement>(".plan-dock-content")?.scrollTop || 0
  syncPlanDockSession(presentation, sessionId)
  const plan = visiblePlan(conversation, sessionId, presentation)
  if (!plan) {
    elements.shell.hidden = true
    elements.dock.replaceChildren()
    return
  }
  const progress = planProgress(plan)
  const preview = plan.steps.find((step) => step.status === "in_progress")
    ?? plan.steps.find((step) => step.status === "pending")
    ?? plan.steps.at(-1)
  const collapsed = presentation.collapsed
  elements.shell.hidden = false
  elements.shell.className = `plan-dock-shell${collapsed ? " collapsed" : ""}`
  elements.dock.className = `plan-dock${progress.status === "error" ? " plan-error" : ""}`
  elements.dock.innerHTML = `
    <button type="button" class="plan-dock-trigger" data-toggle-plan aria-expanded="${String(!collapsed)}">
      <span class="status-pip ${progress.pip}"></span>
      <strong>Plan</strong>
      <span class="plan-progress">${progress.completed}/${plan.steps.length}</span>
      ${preview ? `<span class="plan-preview">${escapeHtml(clipLine(preview.step, 72))}</span>` : ""}
      <span class="plan-chevron" aria-hidden="true"></span>
    </button>
    <div class="plan-dock-body" aria-hidden="${String(collapsed)}">
      <div class="plan-dock-content">
        <ol class="plan-steps">${plan.steps.map((step) => `<li class="plan-step plan-${escapeAttribute(step.status)}"><span aria-hidden="true"></span><span>${escapeHtml(step.step)}</span></li>`).join("")}</ol>
        ${plan.error ? `<p class="plan-error-text">${escapeHtml(plan.error)}</p>` : ""}
      </div>
    </div>
  `
  const content = elements.dock.querySelector<HTMLElement>(".plan-dock-content")
  if (content) content.scrollTop = scrollTop
}

export function syncPlanDockSession(presentation: PlanDockPresentation, sessionId: string) {
  if (presentation.sessionId === sessionId) return
  presentation.sessionId = sessionId
  presentation.collapsed = false
}

export function dismissPlanError(conversation: ConversationState, sessionId: string, presentation: PlanDockPresentation) {
  const plan = activePlan(conversation)
  if (!plan || !(plan.error || plan.status === "error") || !sessionId || !plan.id) return
  presentation.dismissedPlanErrors.add(planErrorKey(sessionId, plan))
}

export function renderComposer(elements: ComposerElements, view: ComposerView) {
  const unavailable = !view.ready || view.readOnly || view.compacting || view.slashCommandPending
  elements.prompt.disabled = unavailable
  elements.prompt.placeholder = view.slashCommandPending
    ? `Running ${view.slashCommandInput || "command"}...`
    : view.compacting
    ? "Compacting context..."
    : view.readOnly
    ? "Return to the current task to send a message"
    : "Message Rind — Enter to send, Shift+Enter for a new line"
  elements.send.disabled = unavailable || view.starting
  const label = elements.send.querySelector<HTMLElement>(".send-label")
  if (label) label.textContent = view.slashCommandPending
    ? "Running"
    : view.compacting ? "Compacting" : view.readOnly ? "Viewing" : view.active ? "Queue" : "Send"
  const working = view.starting || view.slashCommandPending
  elements.send.classList.toggle("is-starting", working)
  elements.send.setAttribute("aria-busy", String(working))
  elements.send.title = view.slashCommandPending
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
  elements.contextMeter.hidden = view.contextUsagePercent === null
  elements.contextMeter.textContent = view.contextUsagePercent === null ? "" : `${Math.round(view.contextUsagePercent * 100)}% ctx`
  elements.contextMeter.classList.toggle("context-hot", view.contextUsagePercent !== null && view.contextUsagePercent >= 0.8)
}

export function syncPendingInputDock(
  dock: HTMLElement,
  inputs: PendingInput[],
  onPromote: (inputId: string) => void,
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

      const promote = document.createElement("button")
      promote.type = "button"
      promote.className = "ghost-button pending-input-promote"
      promote.textContent = "Steer"
      promote.addEventListener("click", () => onPromote(input.inputId))
      item.append(content, promote)
    }

    const mode = item.querySelector<HTMLElement>(".pending-input-mode")
    const text = item.querySelector<HTMLElement>(".pending-input-text")
    const promote = item.querySelector<HTMLButtonElement>(".pending-input-promote")
    if (mode) mode.textContent = input.mode === "steering" || input.promoting ? "Steering" : "Queue"
    if (text) text.textContent = input.input
    if (promote) {
      promote.disabled = input.mode === "steering" || input.promoting
      promote.textContent = input.promoting ? "Steering..." : "Steer"
      promote.title = input.mode === "steering" ? "Message will steer the next model step" : "Apply this queued message as steering"
    }
    if (dock.children[index] !== item) dock.append(item)
    existing.delete(input.inputId)
  }

  for (const stale of existing.values()) stale.remove()
  dock.hidden = inputs.length === 0
}

function visiblePlan(conversation: ConversationState, sessionId: string, presentation: PlanDockPresentation) {
  const plan = activePlan(conversation)
  if (!plan || !(plan.error || plan.status === "error")) return plan
  return presentation.dismissedPlanErrors.has(planErrorKey(sessionId, plan)) ? undefined : plan
}

function planErrorKey(sessionId: string, plan: PlanEntry) {
  return `${sessionId}:${plan.id}`
}

function planProgress(plan: PlanEntry) {
  const completed = plan.steps.filter((step) => step.status === "completed").length
  const settled = plan.steps.filter((step) => step.status === "completed" || step.status === "cancelled").length
  const status = plan.error || plan.status === "error"
    ? "error"
    : plan.steps.some((step) => step.status === "in_progress")
      ? "running"
      : settled === plan.steps.length ? "completed" : "pending"
  return { completed, status, pip: status === "error" ? "pip-error" : status === "completed" ? "pip-done" : "pip-running" }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character)
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/\n/g, "&#10;")
}
