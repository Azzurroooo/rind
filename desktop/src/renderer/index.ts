import "./style.css"

import type { DesktopSettings, RuntimeEvent, RuntimeMethod, RuntimeSnapshot } from "../preload/types"
import {
  addUserMessage,
  clipLine,
  createConversation,
  formatDuration,
  reduceEvent,
  relativeTime,
  type ConversationState,
  type Entry,
  type ToolEntry,
} from "./stream-model"

type SessionSummary = {
  id: string
  title?: string
  updated_at?: string
  preview?: string
}

type AppState = {
  runtime: RuntimeSnapshot
  settings: DesktopSettings
  settingsOpen: boolean
  settingsSaving: boolean
  settingsAutoOpened: boolean
  sessionId: string
  model: string
  models: string[]
  sessions: SessionSummary[]
  conversation: ConversationState
  expandedTools: Set<string>
  notice: string
  bootstrapped: boolean
}

const root = document.querySelector<HTMLElement>("#app")
if (!root) throw new Error("Renderer root is missing.")

const state: AppState = {
  runtime: { status: "stopped" },
  settings: { model: "", baseUrl: "", reasoningEffort: "", hasApiKey: false },
  settingsOpen: false,
  settingsSaving: false,
  settingsAutoOpened: false,
  sessionId: "",
  model: "",
  models: [],
  sessions: [],
  conversation: createConversation(),
  expandedTools: new Set(),
  notice: "Choose a workspace to begin.",
  bootstrapped: false,
}

root.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="identity">
        <span class="brand">Rind</span>
        <span id="connection" class="connection"><span class="status-pip"></span><span id="connection-text">Stopped</span></span>
      </div>
      <div class="workspace">
        <span id="workspace-label" class="workspace-path" title="">No workspace selected</span>
        <button id="choose-workspace" type="button" class="ghost-button">Change</button>
        <button id="open-settings" type="button" class="ghost-button">Settings</button>
      </div>
    </header>
    <main class="layout">
      <aside class="sidebar" aria-label="Sessions">
        <div class="sidebar-heading"><span>Sessions</span><button id="new-session" type="button" class="ghost-button" title="New session">+ New</button></div>
        <div id="session-list" class="session-list"></div>
      </aside>
      <section class="conversation">
        <div class="conversation-head">
          <div class="conversation-title"><strong id="session-title">New session</strong><span id="session-id" class="subtle"></span></div>
          <button id="compact" type="button" class="ghost-button" title="Compact context now">Compact</button>
        </div>
        <div id="notice" class="notice" role="status" hidden><span id="notice-text"></span><button id="retry" type="button" class="ghost-button" hidden>Restart runtime</button></div>
        <div class="stream-wrap">
          <div id="message-stream" class="message-stream" aria-live="polite"></div>
          <button id="jump-latest" type="button" class="jump-latest" hidden>Jump to latest</button>
        </div>
        <form id="composer" class="composer">
          <textarea id="prompt" rows="1" placeholder="Message Rind — Enter to send, Shift+Enter for a new line" aria-label="Message Rind"></textarea>
          <div class="composer-footer">
            <label class="model-control" title="Active model"><select id="model-select" aria-label="Model"></select></label>
            <span id="context-meter" class="context-meter" hidden></span>
            <span class="composer-spacer"></span>
            <button id="steer" type="button" class="ghost-button" title="Steer the running turn with this message">Steer</button>
            <button id="interrupt" type="button" class="ghost-button danger" title="Stop the running turn (Esc)">Stop</button>
            <button id="send" type="submit" class="primary-button">Send</button>
          </div>
        </form>
      </section>
    </main>
    <dialog id="settings-dialog" class="settings-dialog">
      <form id="settings-form" method="dialog">
        <div class="settings-heading"><strong>Runtime settings</strong><button id="close-settings" type="button" class="ghost-button" title="Close settings">Close</button></div>
        <label>API key<input id="settings-api-key" type="password" autocomplete="new-password" placeholder="Leave blank to keep the current key" /></label>
        <p id="settings-key-status" class="subtle"></p>
        <label>Base URL<input id="settings-base-url" type="url" placeholder="https://api.openai.com/v1" /></label>
        <label>Model<input id="settings-model" type="text" placeholder="Default model" /></label>
        <label>Reasoning effort<input id="settings-reasoning" type="text" placeholder="high" /></label>
        <div class="settings-actions"><button id="cancel-settings" type="button" class="ghost-button">Cancel</button><button id="save-settings" type="submit" class="primary-button">Save</button></div>
      </form>
    </dialog>
  </div>
`

const connection = requiredElement("connection")
const connectionText = requiredElement("connection-text")
const workspaceLabel = requiredElement("workspace-label")
const sessionList = requiredElement("session-list")
const sessionTitle = requiredElement("session-title")
const sessionIdLabel = requiredElement("session-id")
const modelSelect = requiredElement<HTMLSelectElement>("model-select")
const messageStream = requiredElement("message-stream")
const jumpLatest = requiredElement<HTMLButtonElement>("jump-latest")
const notice = requiredElement("notice")
const noticeText = requiredElement("notice-text")
const retry = requiredElement<HTMLButtonElement>("retry")
const contextMeter = requiredElement("context-meter")
const prompt = requiredElement<HTMLTextAreaElement>("prompt")
const send = requiredElement<HTMLButtonElement>("send")
const steer = requiredElement<HTMLButtonElement>("steer")
const interrupt = requiredElement<HTMLButtonElement>("interrupt")
const settingsDialog = requiredElement<HTMLDialogElement>("settings-dialog")
const settingsForm = requiredElement<HTMLFormElement>("settings-form")
const settingsApiKey = requiredElement<HTMLInputElement>("settings-api-key")
const settingsBaseUrl = requiredElement<HTMLInputElement>("settings-base-url")
const settingsModel = requiredElement<HTMLInputElement>("settings-model")
const settingsReasoning = requiredElement<HTMLInputElement>("settings-reasoning")
const settingsKeyStatus = requiredElement("settings-key-status")
const saveSettingsButton = requiredElement<HTMLButtonElement>("save-settings")

let workingTimer: ReturnType<typeof setInterval> | undefined
let lastRenderedEntries = 0

function requiredElement<T extends HTMLElement = HTMLElement>(id: string) {
  const element = document.getElementById(id) as T | null
  if (!element) throw new Error(`Missing ${id}.`)
  return element
}

function render() {
  const { runtime, conversation } = state
  connectionText.textContent = runtime.status === "ready" ? "Connected" : titleCase(runtime.status)
  connection.className = `connection connection-${runtime.status}`
  workspaceLabel.textContent = runtime.workspace || "No workspace selected"
  workspaceLabel.title = runtime.workspace || ""
  const current = state.sessions.find((item) => item.id === state.sessionId)
  sessionTitle.textContent = current?.title || (state.sessionId ? "Session" : "New session")
  sessionIdLabel.textContent = state.sessionId || ""
  noticeText.textContent = state.notice || runtime.message || ""
  retry.hidden = !runtime.workspace || (runtime.status !== "error" && runtime.status !== "stopped")
  notice.hidden = !noticeText.textContent && retry.hidden
  renderSessions()
  renderModels()
  renderStream()
  renderComposer()
  renderSettings()
  syncWorkingTimer()
}

function renderSettings() {
  if (state.settingsOpen && !settingsDialog.open) settingsDialog.showModal()
  if (!state.settingsOpen && settingsDialog.open) settingsDialog.close()
  settingsKeyStatus.textContent = state.settings.hasApiKey ? "An API key is available." : "No API key is configured."
  saveSettingsButton.disabled = state.settingsSaving
  saveSettingsButton.textContent = state.settingsSaving ? "Saving..." : "Save"
}

function renderSessions() {
  sessionList.replaceChildren()
  if (!state.sessions.length) {
    sessionList.textContent = state.runtime.status === "ready" ? "No saved sessions yet" : ""
    return
  }
  for (const item of state.sessions) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = `session-item${item.id === state.sessionId ? " selected" : ""}`
    button.dataset.sessionId = item.id
    const when = item.updated_at ? relativeTime(item.updated_at) : ""
    button.innerHTML = `
      <span class="session-item-title">${escapeHtml(item.title || "Untitled")}</span>
      <small>${escapeHtml(clipLine(item.preview || "", 48))}</small>
      <small class="session-item-meta">${escapeHtml(when)}</small>
    `
    sessionList.append(button)
  }
}

function renderModels() {
  const previous = modelSelect.value
  modelSelect.replaceChildren()
  const choices = state.models.length ? state.models : state.model ? [state.model] : []
  for (const model of choices) {
    const option = document.createElement("option")
    option.value = model
    option.textContent = model
    option.selected = model === state.model
    modelSelect.append(option)
  }
  if (previous && choices.includes(previous)) modelSelect.value = previous
  modelSelect.disabled = state.runtime.status !== "ready" || !choices.length
}

function renderStream() {
  const stickToBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
  const { conversation } = state
  if (!conversation.entries.length && !conversation.question) {
    messageStream.innerHTML = state.runtime.status === "ready"
      ? `<div class="stream-empty"><p>No messages yet.</p><p class="subtle">Ask Rind to inspect, change, or explain something in this workspace.</p></div>`
      : ""
  } else {
    messageStream.innerHTML = conversation.entries.map(renderEntry).join("") + renderQuestion() + renderWorking()
  }
  if (stickToBottom) {
    messageStream.scrollTop = messageStream.scrollHeight
    jumpLatest.hidden = true
  } else if (conversation.entries.length > lastRenderedEntries) {
    jumpLatest.hidden = false
  }
  lastRenderedEntries = conversation.entries.length
}

function renderEntry(entry: Entry): string {
  switch (entry.kind) {
    case "user":
      return `<article class="turn-user"><div class="user-bubble">${renderMarkdown(entry.content)}</div></article>`
    case "assistant":
      return `<article class="turn-assistant">${renderMarkdown(entry.content)}</article>`
    case "tool":
      return renderTool(entry)
    case "file":
      return `<div class="ledger-row ledger-file"><span class="status-pip pip-done"></span><span class="ledger-verb">Edited</span><code class="ledger-arg">${escapeHtml(entry.filePath)}</code></div>`
    case "error":
      return `<div class="stream-card card-error"><div class="card-label">${escapeHtml(entry.source)}</div><div class="card-body">${escapeHtml(entry.content)}</div></div>`
    case "notice":
      return `<div class="stream-card card-notice"><div class="card-label">${escapeHtml(entry.label)}</div><div class="card-body">${escapeHtml(entry.content)}</div></div>`
  }
}

function renderTool(tool: ToolEntry): string {
  const open = state.expandedTools.has(tool.id)
  const pip = tool.status === "running" || tool.status === "pending"
    ? "pip-running"
    : tool.status === "error" ? "pip-error" : "pip-done"
  const duration = formatDuration(tool.durationMs)
  const body = tool.output || tool.errorType
  return `
    <div class="ledger-row${open ? " open" : ""}" data-tool-id="${escapeAttribute(tool.id)}">
      <button type="button" class="ledger-trigger" data-toggle-tool="${escapeAttribute(tool.id)}" ${body ? "" : "disabled"}>
        <span class="status-pip ${pip}"></span>
        <span class="ledger-verb">${escapeHtml(tool.toolName)}</span>
        ${tool.argsPreview ? `<code class="ledger-arg">${escapeHtml(tool.argsPreview)}</code>` : ""}
        ${tool.errorType ? `<span class="ledger-error">${escapeHtml(tool.errorType)}</span>` : ""}
        ${duration ? `<span class="ledger-duration">${duration}</span>` : ""}
        ${body ? `<span class="ledger-chevron" aria-hidden="true"></span>` : ""}
      </button>
      ${open && body ? `<pre class="ledger-output"><code>${escapeHtml(tool.output || tool.errorType)}</code></pre>` : ""}
    </div>
  `
}

function renderQuestion(): string {
  const question = state.conversation.question
  if (!question) return ""
  return `
    <div class="stream-card card-question">
      <div class="card-label">Rind asks</div>
      <div class="question-text">${escapeHtml(question.question)}</div>
      <div class="question-options">${question.options.map((option) => `
        <button type="button" class="question-option${option === question.recommended ? " recommended" : ""}" data-answer="${escapeAttribute(option)}">${escapeHtml(option)}</button>
      `).join("")}</div>
      <form id="question-form" class="question-form">
        <input id="question-answer" aria-label="Your answer" autocomplete="off" placeholder="Type your own answer" />
        <button type="submit" class="primary-button">Answer</button>
      </form>
    </div>
  `
}

function renderWorking(): string {
  const { conversation } = state
  if (!conversation.activeTurnId) return ""
  const elapsed = conversation.turnStartedAt ? Math.max(0, Math.round((Date.now() - conversation.turnStartedAt) / 1000)) : 0
  return `<div class="working"><span class="status-pip pip-running"></span><span id="working-label">Working… ${elapsed}s</span></div>`
}

function syncWorkingTimer() {
  const active = Boolean(state.conversation.activeTurnId)
  if (active && !workingTimer) {
    workingTimer = setInterval(() => {
      const label = document.getElementById("working-label")
      const started = state.conversation.turnStartedAt
      if (label && started) label.textContent = `Working… ${Math.max(0, Math.round((Date.now() - started) / 1000))}s`
    }, 1000)
  }
  if (!active && workingTimer) {
    clearInterval(workingTimer)
    workingTimer = undefined
  }
}

function renderComposer() {
  const ready = state.runtime.status === "ready"
  const active = Boolean(state.conversation.activeTurnId)
  prompt.disabled = !ready
  send.disabled = !ready
  send.textContent = active ? "Queue" : "Send"
  send.title = active ? "Queue as follow-up for the running turn" : "Send message"
  steer.disabled = !ready || !active
  interrupt.disabled = !ready || !active
  const percent = state.conversation.contextUsagePercent
  contextMeter.hidden = percent === null
  contextMeter.textContent = percent === null ? "" : `${Math.round(percent * 100)}% ctx`
  contextMeter.classList.toggle("context-hot", percent !== null && percent >= 0.8)
}

function renderMarkdown(value: string): string {
  const chunks = value.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g)
  const parts: string[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    if (index % 3 === 0) {
      parts.push(renderInline(chunks[index]))
    } else if (index % 3 === 2) {
      const language = chunks[index - 1]
      const code = chunks[index]
      parts.push(`<pre><div class="code-head"><span>${escapeHtml(language || "code")}</span><button class="copy-code" type="button" data-copy="${escapeAttribute(code)}">Copy</button></div><code>${escapeHtml(code)}</code></pre>`)
    }
  }
  return parts.join("")
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, "<br>")
}

function titleCase(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character)
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/\n/g, "&#10;")
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

async function request(method: RuntimeMethod, params: Record<string, unknown> = {}) {
  try {
    return await window.api.runtime.request(method, params)
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
    render()
    throw error
  }
}

function runAction(action: () => Promise<unknown>) {
  void action().catch(() => undefined)
}

async function loadSessions() {
  const result = asRecord(await request("session.list", { limit: 30 }))
  state.sessions = Array.isArray(result.sessions) ? result.sessions.filter(isSession) : []
  state.sessionId = typeof result.current_session_id === "string" ? result.current_session_id : state.sessionId
}

function isSession(value: unknown): value is SessionSummary {
  return Boolean(value && typeof value === "object" && typeof (value as SessionSummary).id === "string")
}

async function loadReplay() {
  const result = asRecord(await request("session.replay"))
  const messages = Array.isArray(result.messages) ? result.messages.filter(isStoredMessage) : []
  const entries: Entry[] = messages.map((message, index) => ({
    kind: message.role === "assistant" ? "assistant" : "user",
    id: `replay-${index}`,
    content: String(message.content || ""),
  }))
  state.conversation = { ...createConversation(), entries }
  state.expandedTools = new Set()
  const turnState = asRecord(result.turn_state)
  if (turnState.status === "running" && typeof turnState.turn_id === "string") {
    state.conversation = { ...state.conversation, activeTurnId: turnState.turn_id, turnStartedAt: Date.now() }
  }
}

function isStoredMessage(value: unknown): value is { role: string; content?: unknown } {
  return Boolean(value && typeof value === "object" && ["user", "assistant"].includes(String((value as { role?: unknown }).role)))
}

async function loadModels() {
  try {
    const result = asRecord(await request("models.list"))
    state.models = Array.isArray(result.models) ? result.models.filter((model): model is string => typeof model === "string") : []
    state.model = typeof result.current_model === "string" ? result.current_model : state.model
  } catch {
    state.models = state.model ? [state.model] : []
  }
}

async function loadSettings() {
  try {
    state.settings = await window.api.settings.get()
    if (!state.settings.hasApiKey && !state.settingsAutoOpened) {
      state.settingsAutoOpened = true
      state.notice = "Configure the shared ~/.rind/settings.json before using the runtime."
      openSettings()
    } else {
      render()
    }
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
    render()
  }
}

async function refreshSession() {
  await Promise.all([loadSessions(), loadReplay(), loadModels()])
  state.notice = ""
  render()
}

async function bootstrap(result: unknown) {
  const initialize = asRecord(result)
  state.sessionId = typeof initialize.session_id === "string" ? initialize.session_id : state.sessionId
  state.model = typeof initialize.model === "string" ? initialize.model : state.model
  await refreshSession()
}

function handleRuntimeEvent(envelope: RuntimeEvent) {
  state.conversation = reduceEvent(state.conversation, envelope)
  if (envelope.type === "turn_completed" || envelope.type === "turn_failed" || envelope.type === "turn_cancelled") {
    runAction(async () => { await loadSessions(); render() })
  }
  render()
}

function autoGrowPrompt() {
  prompt.style.height = "auto"
  prompt.style.height = `${Math.min(prompt.scrollHeight, 220)}px`
}

requiredElement<HTMLFormElement>("composer").addEventListener("submit", (event) => { event.preventDefault(); runAction(sendPrompt) })

prompt.addEventListener("input", autoGrowPrompt)
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    runAction(sendPrompt)
  }
})
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.conversation.activeTurnId && !state.settingsOpen) {
    runAction(() => request("turn.interrupt"))
  }
})

async function sendPrompt() {
  const input = prompt.value.trim()
  if (!input) return
  prompt.value = ""
  autoGrowPrompt()
  if (input.startsWith("/")) {
    runAction(() => runSlash(input))
    return
  }
  const active = Boolean(state.conversation.activeTurnId)
  if (!active) {
    state.conversation = addUserMessage(state.conversation, input)
    render()
  }
  await request(active ? "turn.follow_up" : "turn.start", { input })
}

async function runSlash(input: string) {
  const result = asRecord(await request("slash.execute", { input }))
  const text = asRecordText(result.text)
  if (text) {
    state.conversation = {
      ...state.conversation,
      entries: [...state.conversation.entries, { kind: "notice", id: `slash-${Date.now()}`, label: input, content: text }],
    }
  }
  const prefill = typeof result.input_prefill === "string" ? result.input_prefill : ""
  if (prefill) {
    prompt.value = prefill
    autoGrowPrompt()
    prompt.focus()
  }
  const followUp = typeof result.run_turn_input === "string" ? result.run_turn_input.trim() : ""
  if (followUp) {
    state.conversation = addUserMessage(state.conversation, followUp)
    await request("turn.start", { input: followUp })
  }
  render()
}

function asRecordText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

steer.addEventListener("click", () => {
  const input = prompt.value.trim()
  if (!input) return
  prompt.value = ""
  autoGrowPrompt()
  runAction(() => request("turn.steer", { input }))
})
interrupt.addEventListener("click", () => runAction(() => request("turn.interrupt")))
retry.addEventListener("click", () => runAction(window.api.runtime.restart))
jumpLatest.addEventListener("click", () => {
  messageStream.scrollTop = messageStream.scrollHeight
  jumpLatest.hidden = true
})
messageStream.addEventListener("scroll", () => {
  const nearBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
  if (nearBottom) jumpLatest.hidden = true
})
requiredElement("choose-workspace").addEventListener("click", () => runAction(window.api.openDirectory))
requiredElement("open-settings").addEventListener("click", () => openSettings())
requiredElement("new-session").addEventListener("click", () => runAction(createSession))
requiredElement("compact").addEventListener("click", () => runAction(() => request("compact")))
modelSelect.addEventListener("change", () => {
  const model = modelSelect.value
  if (!model) return
  runAction(async () => {
    await request("model.set", { model })
    state.model = model
    render()
  })
})
settingsForm.addEventListener("submit", (event) => { event.preventDefault(); runAction(saveSettings) })
requiredElement("close-settings").addEventListener("click", () => { state.settingsOpen = false; render() })
requiredElement("cancel-settings").addEventListener("click", () => { state.settingsOpen = false; render() })
settingsDialog.addEventListener("cancel", () => { state.settingsOpen = false; render() })
sessionList.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-session-id]")
  const nextSessionId = target?.dataset.sessionId
  if (nextSessionId) runAction(() => switchSession(nextSessionId))
})
messageStream.addEventListener("click", (event) => {
  const target = event.target as HTMLElement
  const toggle = target.closest<HTMLButtonElement>("[data-toggle-tool]")
  if (toggle?.dataset.toggleTool) {
    const id = toggle.dataset.toggleTool
    const next = new Set(state.expandedTools)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    state.expandedTools = next
    render()
    return
  }
  const copy = target.closest<HTMLButtonElement>(".copy-code")
  if (copy?.dataset.copy) {
    runAction(() => navigator.clipboard.writeText(copy.dataset.copy || ""))
    return
  }
  const answer = target.closest<HTMLButtonElement>("[data-answer]")?.dataset.answer
  if (answer) runAction(() => answerQuestion(answer))
})
messageStream.addEventListener("submit", (event) => {
  event.preventDefault()
  if ((event.target as HTMLElement).id !== "question-form") return
  const input = requiredElement<HTMLInputElement>("question-answer").value.trim()
  if (input) runAction(() => answerQuestion(input))
})

function openSettings() {
  state.settingsOpen = true
  settingsApiKey.value = ""
  settingsBaseUrl.value = state.settings.baseUrl
  settingsModel.value = state.settings.model
  settingsReasoning.value = state.settings.reasoningEffort
  render()
}

async function createSession() {
  const result = asRecord(await request("session.new"))
  state.sessionId = String(result.session_id || "")
  state.model = String(result.model || state.model)
  state.conversation = createConversation()
  state.expandedTools = new Set()
  await refreshSession()
}

async function switchSession(nextSessionId: string) {
  if (nextSessionId === state.sessionId || state.conversation.activeTurnId) return
  const result = asRecord(await request("session.switch", { session_id: nextSessionId }))
  state.sessionId = String(result.session_id || nextSessionId)
  state.model = String(result.model || state.model)
  state.expandedTools = new Set()
  await refreshSession()
}

async function answerQuestion(answer: string) {
  const question = state.conversation.question
  if (!question) return
  state.conversation = { ...state.conversation, question: undefined }
  render()
  await request("user_question.respond", { tool_call_id: question.toolCallId, answer })
}

async function saveSettings() {
  const apiKey = settingsApiKey.value.trim()
  if (!state.settings.hasApiKey && !apiKey) {
    state.notice = "Enter an API key to start the runtime."
    render()
    settingsApiKey.focus()
    return
  }
  state.settingsSaving = true
  state.notice = "Saving settings and restarting the runtime..."
  render()
  try {
    state.settings = await window.api.settings.save({
      ...(apiKey ? { apiKey } : {}),
      model: settingsModel.value.trim(),
      baseUrl: settingsBaseUrl.value.trim(),
      reasoningEffort: settingsReasoning.value.trim(),
    })
    state.settingsOpen = false
    state.settingsAutoOpened = true
    state.notice = "Settings saved."
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    state.settingsSaving = false
    render()
  }
}

const unsubscribeStatus = window.api.runtime.subscribe((snapshot) => {
  state.runtime = snapshot
  if (snapshot.status === "starting") {
    state.sessionId = ""
    state.sessions = []
    state.conversation = createConversation()
    state.expandedTools = new Set()
    state.bootstrapped = false
    state.notice = "Starting runtime..."
  }
  if (snapshot.status === "error") {
    state.notice = snapshot.message || "Runtime is unavailable."
    if (!state.settingsAutoOpened && snapshot.message?.includes("Configuration error")) {
      state.settingsAutoOpened = true
      openSettings()
      return
    }
  }
  render()
  if (snapshot.status === "ready" && !state.bootstrapped) {
    state.bootstrapped = true
    void window.api.runtime.initialize().then(bootstrap).catch(() => { state.bootstrapped = false; render() })
  }
})
const unsubscribeEvents = window.api.runtime.subscribeEvents(handleRuntimeEvent)
window.addEventListener("beforeunload", () => { unsubscribeStatus(); unsubscribeEvents() }, { once: true })
if (state.runtime.status !== "stopped") {
  state.bootstrapped = true
  void window.api.runtime.initialize().then(bootstrap).catch(() => { state.bootstrapped = false; render() })
}
void loadSettings()
