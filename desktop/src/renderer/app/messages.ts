import { messageTime } from "../message-time.ts"
import brandMarkUrl from "../assets/brand-mark.svg"
import { Copy, Pencil, Quote, renderIcon, RotateCcw } from "../icons.ts"
import { renderMarkdown } from "../markdown.ts"
import { messageActions, STARTER_PROMPTS, type MessageAction } from "../message-view.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"

// Spec section 4: message markup, action bars, error blocks and the empty state.

const actionButtons: Record<MessageAction, (id: string) => string> = {
  copy: (id) => `<button type="button" class="message-action" data-copy-message="${escapeAttribute(id)}" data-tooltip="Copy" aria-label="Copy message">${renderIcon(Copy)}</button>`,
  edit: (id) => `<button type="button" class="message-action" data-edit-message="${escapeAttribute(id)}" data-tooltip="Edit and resend" aria-label="Edit and resend">${renderIcon(Pencil)}</button>`,
}

function renderActionBar(kind: "user" | "assistant", id: string, value?: string | number, delivery?: boolean): string {
  const time = messageTime(value)
  const timestamp = time ? `<time class="message-time" datetime="${escapeAttribute(time.iso)}" title="${escapeAttribute(time.full)}">${escapeHtml(time.label)}</time>` : '<span class="message-time" title="This older message has no recorded timestamp.">Time unavailable</span>'
  const actions = delivery ? messageActions(kind).filter((action) => action !== "edit") : messageActions(kind)
  const buttons = actions.map((action) => actionButtons[action](id)).join("")
  const quoteBtn = kind === "assistant"
    ? `<button type="button" class="message-action" data-quote-message="${escapeAttribute(id)}" data-tooltip="Quote in composer" aria-label="Quote in composer">${renderIcon(Quote)}</button>`
    : ""
  return `<div class="message-actions" role="toolbar" aria-label="Message actions">${buttons}${quoteBtn}${timestamp}</div>`
}

export function renderMessageMeta(id: string, time?: string | number): string {
  return renderActionBar("assistant", id, time)
}

export function renderUserMessage(id: string, content: string, time?: string | number, delivery?: boolean): string {
  const badge = delivery
    ? `<div class="delivery-badge" title="Delivered from a team member or background task">Team delivery</div>`
    : ""
  return `<article class="turn-user${delivery ? " is-delivery" : ""}" data-entry-id="${escapeAttribute(id)}">${badge}<div class="user-bubble" dir="auto">${escapeHtml(content)}</div>${renderActionBar("user", id, time, delivery)}</article>`
}

export interface AssistantMessageState {
  readonly streaming: boolean
  readonly latest: boolean
  readonly time?: string | number
}

export function renderAssistantMessage(id: string, content: string, view: AssistantMessageState): string {
  const classes = ["turn-assistant", view.streaming ? "streaming" : "", view.latest ? "latest" : ""].filter(Boolean).join(" ")
  const actions = content.trim() && !view.streaming ? renderActionBar("assistant", id, view.time) : ""
  return `<article class="${classes}" data-entry-id="${escapeAttribute(id)}"><div class="message-body" dir="auto">${renderMarkdown(content)}</div>${actions}</article>`
}

export function renderErrorBlock(id: string, source: string, content: string, retryable: boolean): string {
  const retry = retryable
    ? `<div class="card-actions"><button type="button" class="ghost-button error-retry" data-retry-turn aria-label="Retry the last prompt">${renderIcon(RotateCcw)}<span>Retry</span></button></div>`
    : ""
  return `<div class="stream-error" role="alert" data-entry-id="${escapeAttribute(id)}"><div class="stream-error-label">${escapeHtml(source)}</div><div class="stream-error-body">${escapeHtml(content)}</div>${retry}</div>`
}

export function renderEmptyState(ready: boolean): string {
  const hint = ready ? "Explore your project, solve a problem, or build something new." : "Add a project folder and configure a model to begin."
  const chips = STARTER_PROMPTS
    .map((starter) => `<button type="button" class="starter-chip" data-starter="${escapeAttribute(starter.prompt)}">${escapeHtml(starter.label)}</button>`)
    .join("")
  return `<img class="stream-empty-mark" src="${brandMarkUrl}" alt="" aria-hidden="true" /><h2>What would you like to work on?</h2><p class="stream-empty-hint">${hint}</p><div class="starter-actions" role="group" aria-label="Suggestions">${chips}</div>`
}
