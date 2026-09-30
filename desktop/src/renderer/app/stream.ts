import { renderCommandResult } from "../command-results.ts"
import { isStreamingAssistant, latestAssistantId } from "../message-view.ts"
import { canConfirmQuestion } from "../question-state.ts"
import { type Entry } from "../timeline-model.ts"
import { foldWorkSegments, isWorkSegment, type StreamItem } from "../work-segments.ts"
import { canRetryLastPrompt } from "./composer.ts"
import { jumpLatest, messageStream } from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { activeTurnIdFor, questionSelectionFor } from "./runtime.ts"
import { state, vars } from "./state.ts"
import { renderAssistantMessage, renderEmptyState, renderErrorBlock, renderUserMessage } from "./messages.ts"
import { renderFileChange, renderTool, renderWorkSegment } from "./tools.ts"

/** Per-render context for message markup: which assistant is streaming and which is latest. */
interface MessageContext {
  readonly openAssistantId: string
  readonly activeTurn: boolean
  readonly latestAssistantId: string
}

const idleContext: MessageContext = { openAssistantId: "", activeTurn: false, latestAssistantId: "" }

export function renderStream() {
  const stickToBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
  const { conversation } = state
  const entries = conversation.entries
  const existing = new Map<string, HTMLElement>()
  for (const node of messageStream.querySelectorAll<HTMLElement>(":scope > [data-entry-id]")) {
    if (node.dataset.entryId) existing.set(node.dataset.entryId, node)
  }
  const nextNodes: HTMLElement[] = []
  const activeTurn = Boolean(activeTurnIdFor(state.viewedSessionId))
  const items = foldWorkSegments(entries, { activeTurn, awaitingToolCallId: conversation.question?.toolCallId })
  const context: MessageContext = { openAssistantId: conversation.openAssistantId, activeTurn, latestAssistantId: latestAssistantId(entries) }
  for (const entry of items) {
    const template = document.createElement("template")
    template.innerHTML = renderStreamItem(entry, context)
    const next = template.content.firstElementChild as HTMLElement | null
    if (!next) continue
    const current = existing.get(entry.id)
    if (current && current.tagName === next.tagName) {
      syncElementAttributes(current, next)
      replaceElementChildren(current, next)
      nextNodes.push(current)
    } else {
      nextNodes.push(next)
    }
  }
  const extras = document.createElement("template")
  extras.innerHTML = renderQuestion()
  const specialNodes = new Map<string, HTMLElement>()
  for (const node of messageStream.querySelectorAll<HTMLElement>("[data-stream-role]")) {
    if (node.dataset.streamRole) specialNodes.set(node.dataset.streamRole, node)
  }
  for (const next of Array.from(extras.content.children) as HTMLElement[]) {
    const current = next.dataset.streamRole ? specialNodes.get(next.dataset.streamRole) : undefined
    if (current && current.tagName === next.tagName) {
      syncElementAttributes(current, next)
      replaceElementChildren(current, next)
      nextNodes.push(current)
    } else {
      nextNodes.push(next)
    }
  }
  const nextSet = new Set(nextNodes)
  for (const child of Array.from(messageStream.children)) {
    if (!nextSet.has(child as HTMLElement)) child.remove()
  }
  let anchor = messageStream.firstElementChild
  for (const node of nextNodes) {
    if (node !== anchor) messageStream.insertBefore(node, anchor)
    anchor = node.nextElementSibling
  }
  if (!entries.length && !conversation.question) {
    const ready = state.runtime.status === "ready"
    if (!messageStream.querySelector(".stream-empty")) {
      const empty = document.createElement("div")
      empty.className = "stream-empty"
      empty.innerHTML = renderEmptyState(ready)
      messageStream.append(empty)
    }
  } else {
    messageStream.querySelector(".stream-empty")?.remove()
  }
  if (stickToBottom) {
    messageStream.scrollTop = messageStream.scrollHeight
    jumpLatest.hidden = true
  } else if (entries.length > vars.lastRenderedEntries) {
    jumpLatest.hidden = false
  }
  vars.lastRenderedEntries = entries.length
}

export function syncElementAttributes(current: HTMLElement, next: HTMLElement) {
  for (const attribute of Array.from(current.attributes)) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
  }
  for (const attribute of Array.from(next.attributes)) current.setAttribute(attribute.name, attribute.value)
}

export function replaceElementChildren(current: HTMLElement, next: HTMLElement) {
  const focused = document.activeElement instanceof HTMLInputElement && current.contains(document.activeElement)
  const selectionStart = focused ? (document.activeElement as HTMLInputElement).selectionStart : null
  const selectionEnd = focused ? (document.activeElement as HTMLInputElement).selectionEnd : null
  current.replaceChildren(...Array.from(next.childNodes))
  if (!focused) return
  const input = current.querySelector<HTMLInputElement>("input")
  if (!input) return
  input.focus()
  if (selectionStart !== null && selectionEnd !== null) input.setSelectionRange(selectionStart, selectionEnd)
}

export function renderStreamItem(item: StreamItem, context: MessageContext = idleContext): string {
  return isWorkSegment(item) ? renderWorkSegment(item) : renderEntry(item, context)
}

export function renderEntry(entry: Entry, context: MessageContext = idleContext): string {
  switch (entry.kind) {
    case "user":
      return renderUserMessage(entry.id, entry.content)
    case "assistant":
      return renderAssistantMessage(entry.id, entry.content, {
        streaming: isStreamingAssistant(entry.id, context.openAssistantId, context.activeTurn),
        latest: entry.id === context.latestAssistantId,
      })
    case "tool":
      return renderTool(entry)
    case "file":
      return renderFileChange(entry.id, entry.filePath)
    case "error":
      return renderErrorBlock(entry.id, entry.source, entry.content, Boolean(entry.retryable) && canRetryLastPrompt())
    case "notice":
      return `<div class="stream-card card-notice" data-entry-id="${escapeAttribute(entry.id)}"><div class="card-label">${escapeHtml(entry.label)}</div><div class="card-body">${escapeHtml(entry.content)}</div></div>`
    case "system":
      return `<div class="system-line system-${entry.tone}" role="note" data-entry-id="${escapeAttribute(entry.id)}"><span>${escapeHtml(entry.content)}</span></div>`
    case "command":
      return `<div data-entry-id="${escapeAttribute(entry.id)}">${renderCommandResult(entry)}</div>`
  }
}

export function renderQuestion(): string {
  const question = state.conversation.question
  if (!question) return ""
  const selection = questionSelectionFor(question)
  const customIndex = question.options.length
  const customSelected = selection.selectedIndex === customIndex
  const canConfirm = canConfirmQuestion(selection, question.options.length)
  return `
    <div class="stream-card card-question" data-stream-role="question">
      <div class="card-label">Rind asks</div>
      <div class="question-text">${escapeHtml(question.question)}</div>
      <div class="question-options">${question.options.map((option, index) => `
        <button type="button" class="question-option${selection.selectedIndex === index ? " selected" : ""}" data-question-option-index="${index}" aria-pressed="${String(selection.selectedIndex === index)}">
          <strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.description)}</small>
        </button>
      `).join("")}
        <button type="button" class="question-option question-custom${customSelected ? " selected" : ""}" data-question-option-index="${customIndex}" aria-pressed="${String(customSelected)}">
          <strong>Type your own answer</strong><small>Enter a custom response.</small>
        </button>
      </div>
      <form id="question-form" class="question-form">
        ${customSelected ? `<input id="question-answer" aria-label="Your answer" autocomplete="off" placeholder="Type your own answer" value="${escapeAttribute(selection.customInput)}" />` : ""}
        <button type="submit" class="primary-button"${canConfirm ? "" : " disabled"}>Confirm</button>
      </form>
    </div>
  `
}

export function toolHeaderOffset(id: string) {
  const trigger = findToolTrigger(id)
  if (!trigger) return 12
  const stream = messageStream.getBoundingClientRect()
  const header = trigger.getBoundingClientRect()
  const offset = header.top - stream.top
  return offset >= 8 && header.bottom <= stream.bottom - 8 ? offset : 12
}

export function keepToolHeaderVisible(id: string, targetOffset: number) {
  const sequence = ++vars.toolPinSequence
  const pin = () => {
    if (sequence !== vars.toolPinSequence) return
    const trigger = findToolTrigger(id)
    if (!trigger) return
    const currentOffset = trigger.getBoundingClientRect().top - messageStream.getBoundingClientRect().top
    messageStream.scrollTop += currentOffset - targetOffset
  }
  requestAnimationFrame(pin)
  window.setTimeout(pin, 160)
  window.setTimeout(pin, 300)
}

export function findToolTrigger(id: string) {
  return [...messageStream.querySelectorAll<HTMLButtonElement>("[data-toggle-tool]")]
    .find((button) => button.dataset.toggleTool === id)
}

export function setToolExpanded(id: string, expanded: boolean) {
  const trigger = findToolTrigger(id)
  const row = trigger?.closest<HTMLElement>("[data-tool-id]")
  if (!row) return
  row.classList.toggle("open", expanded)
  trigger?.setAttribute("aria-expanded", String(expanded))
  row.querySelector<HTMLElement>(".tool-detail-shell")?.setAttribute("aria-hidden", String(!expanded))
}
