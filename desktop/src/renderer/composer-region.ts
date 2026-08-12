import { activePlan, clipLine, type ConversationState, type PlanEntry } from "./timeline-model.ts"

export type PlanDockPresentation = {
  collapsed: boolean
  displayedPlanId: string
  dismissedPlanErrors: Set<string>
}

export type PlanDockElements = {
  shell: HTMLElement
  dock: HTMLElement
}

export type ComposerElements = {
  prompt: HTMLTextAreaElement
  send: HTMLButtonElement
  steer: HTMLButtonElement
  interrupt: HTMLButtonElement
  menuTrigger: HTMLButtonElement
  menu: HTMLElement
  compactContext: HTMLButtonElement
  contextMeter: HTMLElement
}

export type ComposerView = {
  ready: boolean
  active: boolean
  readOnly: boolean
  starting: boolean
  controllingTurn: boolean
  runtimeSessionId: string
  composerMenuOpen: boolean
  contextUsagePercent: number | null
}

export function composerRegionMarkup() {
  return `
    <div class="composer-region">
      <div id="plan-dock-shell" class="plan-dock-shell" hidden>
        <section id="plan-dock" class="plan-dock" aria-label="Plan progress"></section>
      </div>
      <form id="composer" class="composer">
        <textarea id="prompt" rows="2" placeholder="Message Rind — Enter to send, Shift+Enter for a new line" aria-label="Message Rind"></textarea>
        <div class="composer-footer">
          <div class="composer-menu-wrap">
            <button id="composer-menu-trigger" type="button" class="composer-menu-trigger" title="More chat actions" aria-label="More chat actions" aria-haspopup="menu" aria-expanded="false">+</button>
            <div id="composer-menu" class="composer-menu" role="menu" hidden><button id="compact-context" type="button" role="menuitem">Compact context</button></div>
          </div>
          <label class="model-control" title="Active model"><select id="model-select" aria-label="Model"></select></label>
          <label class="project-control" title="Active project"><select id="project-select" aria-label="Active project"></select></label>
          <span id="context-meter" class="context-meter" hidden></span>
          <span class="composer-spacer"></span>
          <button id="steer" type="button" class="ghost-button" title="Steer the running turn with this message">Steer</button>
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
  const plan = visiblePlan(conversation, sessionId, presentation)
  if (!plan) {
    elements.shell.hidden = true
    elements.dock.replaceChildren()
    presentation.displayedPlanId = ""
    presentation.collapsed = false
    return
  }
  if (presentation.displayedPlanId !== plan.id) {
    presentation.displayedPlanId = plan.id
    presentation.collapsed = false
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

export function dismissPlanError(conversation: ConversationState, sessionId: string, presentation: PlanDockPresentation) {
  const plan = activePlan(conversation)
  if (!plan || !(plan.error || plan.status === "error") || !sessionId || !plan.id) return
  presentation.dismissedPlanErrors.add(planErrorKey(sessionId, plan))
}

export function renderComposer(elements: ComposerElements, view: ComposerView) {
  elements.prompt.disabled = !view.ready || view.readOnly
  elements.prompt.placeholder = view.readOnly
    ? "Return to the current task to send a message"
    : "Message Rind — Enter to send, Shift+Enter for a new line"
  elements.send.disabled = !view.ready || view.readOnly || view.starting
  const label = elements.send.querySelector<HTMLElement>(".send-label")
  if (label) label.textContent = view.readOnly ? "Viewing" : view.active ? "Queue" : "Send"
  elements.send.classList.toggle("is-starting", view.starting)
  elements.send.setAttribute("aria-busy", String(view.starting))
  elements.send.title = view.readOnly
    ? "Return to the current task before sending"
    : view.starting ? "Waiting for the task to start" : view.active ? "Queue as follow-up for the running turn" : "Send message"
  elements.steer.disabled = !view.ready || !view.controllingTurn || view.readOnly
  elements.interrupt.disabled = !view.ready || !view.controllingTurn || view.readOnly
  elements.menuTrigger.disabled = !view.ready || !view.runtimeSessionId || view.readOnly || view.active
  elements.menuTrigger.setAttribute("aria-expanded", String(view.composerMenuOpen))
  elements.menu.hidden = !view.composerMenuOpen
  elements.compactContext.disabled = !view.ready || !view.runtimeSessionId || view.readOnly || view.active
  elements.contextMeter.hidden = view.contextUsagePercent === null
  elements.contextMeter.textContent = view.contextUsagePercent === null ? "" : `${Math.round(view.contextUsagePercent * 100)}% ctx`
  elements.contextMeter.classList.toggle("context-hot", view.contextUsagePercent !== null && view.contextUsagePercent >= 0.8)
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
