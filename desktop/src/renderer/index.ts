import "./style.css"

import type { DesktopSettings, RuntimeEvent, RuntimeMethod, RuntimeSnapshot } from "../preload/types"

type SessionSummary = {
  id: string
  title?: string
  updated_at?: string
  last_preview?: string
}

type Message = {
  id: string
  role: "user" | "assistant" | "tool" | "error"
  content: string
  status?: string
}

type Question = {
  toolCallId: string
  turnId: string
  question: string
  options: string[]
  recommended?: string
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
  messages: Message[]
  activeTurnId: string
  question?: Question
  notice: string
  bootstrapped: boolean
}

const maxMessageChars = 30_000
const maxMessages = 200
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
  messages: [],
  activeTurnId: "",
  notice: "Choose a workspace to begin.",
  bootstrapped: false,
}

root.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="identity"><span class="brand">Rind</span><span id="connection" class="connection">Stopped</span></div>
      <div class="workspace" title="Current workspace"><span id="workspace-label">No workspace selected</span><button id="choose-workspace" type="button">Workspace</button><button id="open-settings" type="button">Settings</button></div>
    </header>
    <main class="layout">
      <aside class="sidebar" aria-label="Sessions">
        <div class="sidebar-heading"><span>Sessions</span><button id="new-session" type="button" title="New session">New</button></div>
        <div id="session-list" class="session-list"></div>
      </aside>
      <section class="conversation">
        <div class="conversation-head">
          <div><strong id="session-title">New session</strong><span id="session-id" class="subtle"></span></div>
          <div class="actions">
            <label class="model-control">Model <select id="model-select" aria-label="Model"></select></label>
            <button id="compact" type="button">Compact</button>
            <button id="retry" type="button" hidden>Retry</button>
          </div>
        </div>
        <div id="notice" class="notice" role="status"></div>
        <div id="message-stream" class="message-stream" aria-live="polite"></div>
        <section id="question-panel" class="question-panel" hidden></section>
        <form id="composer" class="composer">
          <textarea id="prompt" rows="3" placeholder="Message Rind" aria-label="Message Rind"></textarea>
          <div class="composer-actions">
            <button id="send" type="submit">Send</button>
            <button id="steer" type="button">Steer</button>
            <button id="interrupt" type="button">Stop</button>
          </div>
        </form>
      </section>
    </main>
    <dialog id="settings-dialog" class="settings-dialog">
      <form id="settings-form" method="dialog">
        <div class="settings-heading"><strong>Runtime settings</strong><button id="close-settings" type="button" title="Close settings">Close</button></div>
        <label>API key<input id="settings-api-key" type="password" autocomplete="new-password" placeholder="Leave blank to keep the current key" /></label>
        <p id="settings-key-status" class="subtle"></p>
        <label>Base URL<input id="settings-base-url" type="url" placeholder="https://api.openai.com/v1" /></label>
        <label>Model<input id="settings-model" type="text" placeholder="Default model" /></label>
        <label>Reasoning effort<input id="settings-reasoning" type="text" placeholder="xhigh" /></label>
        <div class="settings-actions"><button id="cancel-settings" type="button">Cancel</button><button id="save-settings" type="submit">Save</button></div>
      </form>
    </dialog>
  </div>
`

const connection = requiredElement("connection")
const workspaceLabel = requiredElement("workspace-label")
const sessionList = requiredElement("session-list")
const sessionTitle = requiredElement("session-title")
const sessionId = requiredElement("session-id")
const modelSelect = requiredElement<HTMLSelectElement>("model-select")
const messageStream = requiredElement("message-stream")
const questionPanel = requiredElement("question-panel")
const notice = requiredElement("notice")
const prompt = requiredElement<HTMLTextAreaElement>("prompt")
const send = requiredElement<HTMLButtonElement>("send")
const steer = requiredElement<HTMLButtonElement>("steer")
const interrupt = requiredElement<HTMLButtonElement>("interrupt")
const retry = requiredElement<HTMLButtonElement>("retry")
const settingsDialog = requiredElement<HTMLDialogElement>("settings-dialog")
const settingsForm = requiredElement<HTMLFormElement>("settings-form")
const settingsApiKey = requiredElement<HTMLInputElement>("settings-api-key")
const settingsBaseUrl = requiredElement<HTMLInputElement>("settings-base-url")
const settingsModel = requiredElement<HTMLInputElement>("settings-model")
const settingsReasoning = requiredElement<HTMLInputElement>("settings-reasoning")
const settingsKeyStatus = requiredElement("settings-key-status")
const saveSettingsButton = requiredElement<HTMLButtonElement>("save-settings")

function requiredElement<T extends HTMLElement = HTMLElement>(id: string) {
  const element = document.getElementById(id) as T | null
  if (!element) throw new Error(`Missing ${id}.`)
  return element
}

function render() {
  const { runtime } = state
  connection.textContent = runtime.status === "ready" ? "Connected" : titleCase(runtime.status)
  connection.className = `connection connection-${runtime.status}`
  workspaceLabel.textContent = runtime.workspace || "No workspace selected"
  sessionTitle.textContent = state.sessions.find((item) => item.id === state.sessionId)?.title || "New session"
  sessionId.textContent = state.sessionId ? ` ${state.sessionId}` : ""
  notice.textContent = state.notice || runtime.message || ""
  notice.hidden = !notice.textContent
  retry.hidden = runtime.status !== "error" && runtime.status !== "stopped"
  renderSessions()
  renderModels()
  renderMessages()
  renderQuestion()
  renderSettings()
  renderControls()
}

function renderSettings() {
  if (state.settingsOpen && !settingsDialog.open) settingsDialog.showModal()
  if (!state.settingsOpen && settingsDialog.open) settingsDialog.close()
  settingsKeyStatus.textContent = state.settings.hasApiKey ? "An API key is available." : "No API key is configured."
  saveSettingsButton.disabled = state.settingsSaving
  saveSettingsButton.textContent = state.settingsSaving ? "Saving..." : "Save"
}

function populateSettingsForm() {
  settingsApiKey.value = ""
  settingsBaseUrl.value = state.settings.baseUrl
  settingsModel.value = state.settings.model
  settingsReasoning.value = state.settings.reasoningEffort
}

function openSettings() {
  state.settingsOpen = true
  populateSettingsForm()
  render()
}

function renderSessions() {
  sessionList.replaceChildren()
  if (!state.sessions.length) {
    sessionList.textContent = state.runtime.status === "ready" ? "No saved sessions" : ""
    return
  }
  for (const item of state.sessions) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = `session-item${item.id === state.sessionId ? " selected" : ""}`
    button.dataset.sessionId = item.id
    button.innerHTML = `<span>${escapeHtml(item.title || "Untitled")}</span><small>${escapeHtml(item.last_preview || item.updated_at || item.id)}</small>`
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

function renderMessages() {
  const nearBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 80
  messageStream.innerHTML = state.messages.map((message) => `
    <article class="message message-${message.role}">
      <div class="message-label">${message.role === "tool" ? escapeHtml(message.status || "Tool") : message.role}</div>
      <div class="message-content">${renderMarkdown(message.content)}</div>
    </article>
  `).join("")
  if (nearBottom) messageStream.scrollTop = messageStream.scrollHeight
}

function renderQuestion() {
  const question = state.question
  questionPanel.hidden = !question
  if (!question) {
    questionPanel.replaceChildren()
    return
  }
  questionPanel.innerHTML = `
    <div class="question-text">${escapeHtml(question.question)}</div>
    <div class="question-options">${question.options.map((option) => `<button type="button" data-answer="${escapeAttribute(option)}">${escapeHtml(option)}${option === question.recommended ? " (recommended)" : ""}</button>`).join("")}</div>
    <form id="question-form" class="question-form"><input id="question-answer" aria-label="Answer" autocomplete="off" /><button type="submit">Answer</button></form>
  `
}

function renderControls() {
  const ready = state.runtime.status === "ready"
  const active = Boolean(state.activeTurnId)
  send.disabled = !ready
  steer.disabled = !ready || !active
  interrupt.disabled = !ready || !active
  prompt.disabled = !ready
  send.textContent = active ? "Follow up" : "Send"
}

function renderMarkdown(value: string) {
  const chunks = boundText(value).split(/```([\s\S]*?)```/g)
  return chunks.map((chunk, index) => {
    if (index % 2 === 1) {
      const code = chunk.replace(/^\w*\n/, "")
      return `<pre><button class="copy-code" type="button" data-copy="${escapeAttribute(code)}">Copy</button><code>${escapeHtml(code)}</code></pre>`
    }
    return escapeHtml(chunk).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\n/g, "<br>")
  }).join("")
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

function boundText(value: string) {
  return value.length > maxMessageChars ? `${value.slice(0, maxMessageChars)}\n\n[Output truncated]` : value
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
  state.messages = Array.isArray(result.messages) ? result.messages.filter(isStoredMessage).map((message, index) => ({
    id: `replay-${index}`,
    role: message.role === "assistant" ? "assistant" : "user",
    content: String(message.content || ""),
  })) : []
  limitMessages()
  state.activeTurnId = ""
  const turnState = asRecord(result.turn_state)
  if (turnState.status === "running" && typeof turnState.turn_id === "string") state.activeTurnId = turnState.turn_id
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

function appendMessage(role: Message["role"], content: string, status?: string) {
  state.messages.push({ id: `${Date.now()}-${state.messages.length}`, role, content: boundText(content), status })
  limitMessages()
}

function ensureAssistantMessage(turnId: string) {
  const existing = state.messages.find((message) => message.id === `assistant-${turnId}`)
  if (existing) return existing
  const message = { id: `assistant-${turnId}`, role: "assistant" as const, content: "" }
  state.messages.push(message)
  limitMessages()
  return message
}

function limitMessages() {
  if (state.messages.length > maxMessages) state.messages.splice(0, state.messages.length - maxMessages)
}

function handleRuntimeEvent(envelope: RuntimeEvent) {
  const event = envelope.event
  switch (envelope.type) {
    case "turn_started": state.activeTurnId = envelope.turnId; break
    case "assistant_delta": {
      const message = ensureAssistantMessage(envelope.turnId)
      message.content = boundText(message.content + String(event.text || ""))
      break
    }
    case "assistant_message_completed": ensureAssistantMessage(envelope.turnId).content = boundText(String(event.content || "")); break
    case "tool_requested": appendMessage("tool", String(event.args_preview || ""), String(event.tool_name || "Tool requested")); break
    case "tool_call_started": appendMessage("tool", "Running", String(event.tool_name || "Tool")); break
    case "tool_progress": appendMessage("tool", boundText(JSON.stringify(event.payload || {})), "Tool progress"); break
    case "tool_result": appendMessage("tool", String(event.result || event.error_type || "Completed"), `${String(event.tool_name || "Tool")} ${String(event.status || "completed")}`); break
    case "user_question_requested":
      state.question = {
        toolCallId: String(event.tool_call_id || ""), turnId: envelope.turnId,
        question: String(event.question || "Question required"),
        options: Array.isArray(event.options) ? event.options.filter((item): item is string => typeof item === "string") : [],
        recommended: typeof event.recommended === "string" ? event.recommended : undefined,
      }
      break
    case "turn_failed": appendMessage("error", String(event.error || "Turn failed"), String(event.error_source || "Runtime error")); finishTurn(envelope.turnId); runAction(async () => { await loadSessions(); render() }); break
    case "turn_cancelled": appendMessage("tool", String(event.reason || "Stopped"), "Turn cancelled"); finishTurn(envelope.turnId); runAction(async () => { await loadSessions(); render() }); break
    case "turn_completed": finishTurn(envelope.turnId); runAction(async () => { await loadSessions(); render() }); break
  }
  render()
}

function finishTurn(turnId: string) {
  if (!turnId || state.activeTurnId === turnId) state.activeTurnId = ""
  if (state.question?.turnId === turnId) state.question = undefined
}

requiredElement<HTMLFormElement>("composer").addEventListener("submit", (event) => { event.preventDefault(); runAction(sendPrompt) })

async function sendPrompt() {
  const input = prompt.value.trim()
  if (!input) return
  const active = Boolean(state.activeTurnId)
  prompt.value = ""
  if (!active) appendMessage("user", input)
  render()
  await request(active ? "turn.follow_up" : "turn.start", { input })
}

steer.addEventListener("click", () => {
  const input = prompt.value.trim()
  if (!input) return
  prompt.value = ""
  runAction(() => request("turn.steer", { input }))
})
interrupt.addEventListener("click", () => runAction(() => request("turn.interrupt")))
requiredElement("choose-workspace").addEventListener("click", () => runAction(window.api.openDirectory))
requiredElement("open-settings").addEventListener("click", () => openSettings())
requiredElement("new-session").addEventListener("click", () => runAction(createSession))
requiredElement("compact").addEventListener("click", () => runAction(() => request("compact")))
retry.addEventListener("click", () => runAction(window.api.runtime.restart))
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
questionPanel.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-answer]")
  const answer = target?.dataset.answer
  if (answer) runAction(() => answerQuestion(answer))
})
questionPanel.addEventListener("submit", (event) => {
  event.preventDefault()
  const answer = requiredElement<HTMLInputElement>("question-answer").value.trim()
  if (answer) runAction(() => answerQuestion(answer))
})
messageStream.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>(".copy-code")
  const copy = target?.dataset.copy
  if (copy) runAction(() => navigator.clipboard.writeText(copy))
})

async function createSession() {
  const result = asRecord(await request("session.new"))
  state.sessionId = String(result.session_id || "")
  state.model = String(result.model || state.model)
  state.messages = []
  state.question = undefined
  await refreshSession()
}

async function switchSession(nextSessionId: string) {
  if (nextSessionId === state.sessionId || state.activeTurnId) return
  const result = asRecord(await request("session.switch", { session_id: nextSessionId }))
  state.sessionId = String(result.session_id || nextSessionId)
  state.model = String(result.model || state.model)
  state.question = undefined
  await refreshSession()
}

async function answerQuestion(answer: string) {
  const question = state.question
  if (!question) return
  await request("user_question.respond", { tool_call_id: question.toolCallId, answer })
  state.question = undefined
  render()
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
    state.messages = []
    state.activeTurnId = ""
    state.question = undefined
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
