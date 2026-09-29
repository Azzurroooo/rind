import brandMarkUrl from "../assets/brand-mark.svg"
import { Copy, Pencil, renderIcon, RotateCcw } from "../icons.ts"
import { renderMarkdown } from "../markdown.ts"
import { messageActions, STARTER_PROMPTS, type MessageAction } from "../message-view.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"

// Spec section 4: message markup, action bars, error blocks and the empty state.

const actionButtons: Record<MessageAction, (id: string) => string> = {
  copy: (id) => `<button type="button" class="message-action" data-copy-message="${escapeAttribute(id)}" data-tooltip="Copy" aria-label="Copy message">${renderIcon(Copy)}</button>`,
  edit: (id) => `<button type="button" class="message-action" data-edit-message="${escapeAttribute(id)}" data-tooltip="Edit and resend" aria-label="Edit and resend">${renderIcon(Pencil)}</button>`,
}

function renderActionBar(kind: "user" | "assistant", id: string): string {
  const buttons = messageActions(kind).map((action) => actionButtons[action](id)).join("")
  return `<div class="message-actions" role="toolbar" aria-label="Message actions">${buttons}</div>`
}

export function renderUserMessage(id: string, content: string): string {
  return `<article class="turn-user" data-entry-id="${escapeAttribute(id)}"><div class="user-bubble" dir="auto">${escapeHtml(content)}</div>${renderActionBar("user", id)}</article>`
}

export interface AssistantMessageState {
  readonly streaming: boolean
  readonly latest: boolean
}

export function renderAssistantMessage(id: string, content: string, view: AssistantMessageState): string {
  const classes = ["turn-assistant", view.streaming ? "streaming" : "", view.latest ? "latest" : ""].filter(Boolean).join(" ")
  const actions = content.trim() && !view.streaming ? renderActionBar("assistant", id) : ""
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
