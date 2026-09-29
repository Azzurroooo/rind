import brandMarkUrl from "../assets/brand-mark.svg"
import workingMarkUrl from "../assets/working-mark.svg"
import { renderCommandResult } from "../command-results.ts"
import { renderMarkdown } from "../markdown.ts"
import { canConfirmQuestion } from "../question-state.ts"
import { type Entry } from "../timeline-model.ts"
import { foldWorkSegments, isWorkSegment, type StreamItem } from "../work-segments.ts"
import { canRetryLastPrompt } from "./composer.ts"
import { jumpLatest, messageStream } from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { activeTurnIdFor, questionSelectionFor, runtimeConversation, runtimeTurnActive } from "./runtime.ts"
import { state, vars } from "./state.ts"
import { renderFileChange, renderTool, renderWorkSegment } from "./tools.ts"



export function renderStream() {
  const stickToBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
  const { conversation } = state
  const entries = conversation.entries
  const existing = new Map<string, HTMLElement>()
  for (const node of messageStream.querySelectorAll<HTMLElement>(":scope > [data-entry-id]")) {
    if (node.dataset.entryId) existing.set(node.dataset.entryId, node)
  }
  const nextNodes: HTMLElement[] = []
  const items = foldWorkSegments(entries, {
    activeTurn: Boolean(activeTurnIdFor(state.viewedSessionId)),
    awaitingToolCallId: conversation.question?.toolCallId,
  })
  for (const entry of items) {
    const template = document.createElement("template")
    template.innerHTML = renderStreamItem(entry)
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
  extras.innerHTML = `${renderQuestion()}${renderWorking()}`
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
      empty.innerHTML = `<img class="stream-empty-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" /><h2>What would you like to work on?</h2><p class="subtle">${ready ? "Explore your project, solve a problem, or build something new." : "Add a project folder and configure a model to begin."}</p><div class="starter-actions"><button type="button" data-starter="Explain how this project is organized">Explore this project <span>↗</span></button><button type="button" data-starter="Review the code and suggest focused improvements">Review the code <span>↗</span></button><button type="button" data-starter="Help me plan and implement a new feature">Build a feature <span>↗</span></button></div>`
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

export function renderStreamItem(item: StreamItem): string {
  return isWorkSegment(item) ? renderWorkSegment(item) : renderEntry(item)
}

export function renderEntry(entry: Entry): string {
  switch (entry.kind) {
    case "user":
      return `<article class="turn-user" data-entry-id="${escapeAttribute(entry.id)}"><div class="message-actions"><button type="button" class="ghost-button message-copy" data-copy-message="${escapeAttribute(entry.id)}" title="Copy message">Copy</button></div><div class="user-bubble">${renderMarkdown(entry.content)}</div></article>`
    case "assistant": {
      const actions = entry.content ? `<div class="message-actions"><button type="button" class="ghost-button message-copy" data-copy-message="${escapeAttribute(entry.id)}" title="Copy message">Copy</button></div>` : ""
      return `<article class="turn-assistant" data-entry-id="${escapeAttribute(entry.id)}">${actions}${renderMarkdown(entry.content)}</article>`
    }
    case "tool":
      return renderTool(entry)
    case "file":
      return renderFileChange(entry.id, entry.filePath)
    case "error": {
      const retryable = entry.retryable && canRetryLastPrompt() ? `<button type="button" class="ghost-button" data-retry-turn title="Resend the last prompt">Retry</button>` : ""
      return `<div class="stream-card card-error" data-entry-id="${escapeAttribute(entry.id)}"><div class="card-label">${escapeHtml(entry.source)}</div><div class="card-body">${escapeHtml(entry.content)}</div>${retryable ? `<div class="card-actions">${retryable}</div>` : ""}</div>`
    }
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

export function renderWorking(): string {
  const conversation = runtimeConversation()
  const turnId = activeTurnIdFor(state.viewedSessionId)
  const wait = conversation.backgroundWait
  if (!turnId && wait) {
    const noun = wait.count === 1 ? "background task" : "background tasks"
    return `<div class="working working-background" data-stream-role="working" role="status"><img class="working-mark" src="${workingMarkUrl}" alt="" aria-hidden="true" /><span>Waiting on ${wait.count} ${noun}</span></div>`
  }
  if (!turnId) return ""
  const elapsed = conversation.turnStartedAt ? Math.max(0, Math.round((Date.now() - conversation.turnStartedAt) / 1000)) : 0
  return `<div class="working" data-stream-role="working"><img class="working-mark" src="${workingMarkUrl}" alt="" aria-hidden="true" /><span id="working-label">Working… ${elapsed}s</span></div>`
}

export function syncWorkingTimer() {
  const active = runtimeTurnActive()
  if (active && !vars.workingTimer) {
    vars.workingTimer = setInterval(() => {
      const label = document.getElementById("working-label")
      const started = state.conversation.turnStartedAt
      if (label && started) label.textContent = `Working… ${Math.max(0, Math.round((Date.now() - started) / 1000))}s`
    }, 1000)
  }
  if (!active && vars.workingTimer) {
    clearInterval(vars.workingTimer)
    vars.workingTimer = undefined
  }
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
