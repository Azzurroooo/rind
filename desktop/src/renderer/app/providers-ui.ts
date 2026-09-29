import type { DesktopAuthPrompt, DesktopAuthProvider } from "../../preload/types.ts"
import { authPromptDialog, authPromptField, authPromptForm, authPromptMessage, requiredElement, settingsProviders } from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { ensureSession } from "./runtime.ts"
import { chatProject } from "./sessions.ts"
import { state } from "./state.ts"

// Settings > Providers: list, sign in (interactive worker prompts) and sign out.
type ProvidersView = {
  providers: readonly DesktopAuthProvider[]
  loading: boolean
  busyProviderId: string
  error: string
  message: string
}

let view: ProvidersView = { providers: [], loading: false, busyProviderId: "", error: "", message: "" }
let activePrompt: DesktopAuthPrompt | undefined

function setView(patch: Partial<ProvidersView>) {
  view = { ...view, ...patch }
  renderProviders()
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function providerStatus(provider: DesktopAuthProvider) {
  if (!provider.configured) return "Not signed in"
  return provider.source ? `Signed in (${provider.source})` : "Signed in"
}

function renderProviderRow(provider: DesktopAuthProvider) {
  const busy = view.busyProviderId === provider.id
  const disabled = view.busyProviderId !== "" ? " disabled" : ""
  const canLogin = provider.methods.length === 0 || provider.methods.includes("api_key")
  const action = provider.configured
    ? `<button type="button" class="ghost-button" data-provider-logout="${escapeAttribute(provider.id)}"${disabled}>${busy ? "Signing out..." : "Sign out"}</button>`
    : `<button type="button" class="secondary-button" data-provider-login="${escapeAttribute(provider.id)}"${disabled || (canLogin ? "" : " disabled")}>${busy ? "Signing in..." : "Sign in"}</button>`
  return `<div class="settings-row provider-row">
    <div class="settings-row-text">
      <span class="settings-row-label">${escapeHtml(provider.name || provider.id)}</span>
      <span class="settings-row-desc"><span class="status-dot" data-configured="${provider.configured}" aria-hidden="true"></span>${escapeHtml(providerStatus(provider))}</span>
    </div>
    <div class="settings-row-control">${action}</div>
  </div>`
}

export function renderProviders() {
  const notice = view.error
    ? `<p class="settings-inline-error" role="alert">${escapeHtml(view.error)}</p>`
    : view.message ? `<p class="settings-inline-note">${escapeHtml(view.message)}</p>` : ""
  if (view.loading && view.providers.length === 0) {
    settingsProviders.innerHTML = `<p class="subtle">Loading providers...</p>`
    return
  }
  const rows = view.providers.length
    ? view.providers.map(renderProviderRow).join("")
    : `<p class="subtle">The runtime did not report any providers.</p>`
  settingsProviders.innerHTML = `${notice}${rows}`
}

function normalizeProvider(value: unknown): DesktopAuthProvider | undefined {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined
  if (!record || typeof record.id !== "string" || !record.id) return undefined
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : record.id,
    methods: Array.isArray(record.methods) ? record.methods.filter((item): item is string => typeof item === "string") : [],
    configured: record.configured === true,
    source: typeof record.source === "string" ? record.source : "",
  }
}

export async function loadProviders() {
  if (state.runtime.status !== "ready") {
    setView({ loading: false, error: "Start the runtime to manage providers." })
    return
  }
  setView({ loading: true, error: "" })
  try {
    const providers = (await window.api.auth.list()).map(normalizeProvider).filter((item): item is DesktopAuthProvider => item !== undefined)
    setView({ providers, loading: false })
  } catch (error) {
    setView({ loading: false, error: errorText(error) })
  }
}

async function login(providerId: string) {
  setView({ busyProviderId: providerId, error: "", message: "" })
  try {
    const sessionId = await ensureSession(chatProject()?.path || state.chatProjectPath || state.fallbackProjectPath)
    const result = await window.api.auth.login(sessionId, providerId)
    const count = typeof result.models_count === "number" ? ` ${result.models_count} models available.` : ""
    setView({ busyProviderId: "", message: `Signed in.${count}` })
    await loadProviders()
  } catch (error) {
    setView({ busyProviderId: "", error: errorText(error) })
  }
}

async function logout(providerId: string) {
  setView({ busyProviderId: providerId, error: "", message: "" })
  try {
    await window.api.auth.logout(providerId)
    setView({ busyProviderId: "", message: "Signed out." })
    await loadProviders()
  } catch (error) {
    setView({ busyProviderId: "", error: errorText(error) })
  }
}

function promptControl(prompt: DesktopAuthPrompt) {
  if (prompt.kind === "select" && prompt.options.length) {
    const options = prompt.options.map((option) => `<option value="${escapeAttribute(option)}">${escapeHtml(option)}</option>`).join("")
    return `<select id="auth-prompt-input">${options}</select>`
  }
  const type = prompt.kind === "secret" ? "password" : "text"
  return `<input id="auth-prompt-input" type="${type}" autocomplete="off" spellcheck="false" required />`
}

function showPrompt(prompt: DesktopAuthPrompt) {
  if (activePrompt) void window.api.auth.respond(activePrompt.requestId, "").catch(() => undefined)
  activePrompt = prompt
  authPromptMessage.textContent = prompt.message || "Enter a value"
  authPromptField.innerHTML = promptControl(prompt)
  if (!authPromptDialog.open) authPromptDialog.showModal()
  requiredElement<HTMLInputElement | HTMLSelectElement>("auth-prompt-input").focus()
}

async function answerPrompt(value: string) {
  const prompt = activePrompt
  activePrompt = undefined
  if (authPromptDialog.open) authPromptDialog.close()
  authPromptField.innerHTML = ""
  if (!prompt) return
  try {
    await window.api.auth.respond(prompt.requestId, value)
  } catch (error) {
    setView({ error: errorText(error) })
  }
}

export function bindProviderEvents(): void {
  settingsProviders.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null
    if (!target || target.disabled) return
    const loginId = target.dataset.providerLogin
    const logoutId = target.dataset.providerLogout
    if (loginId) void login(loginId)
    if (logoutId) void logout(logoutId)
  })
  authPromptForm.addEventListener("submit", (event) => {
    event.preventDefault()
    const input = requiredElement<HTMLInputElement | HTMLSelectElement>("auth-prompt-input")
    void answerPrompt(input.value)
  })
  requiredElement("auth-prompt-cancel").addEventListener("click", () => { void answerPrompt("") })
  authPromptDialog.addEventListener("cancel", (event) => {
    event.preventDefault()
    void answerPrompt("")
  })
  window.api.auth.onPrompt(showPrompt)
  window.api.auth.onUpdate(() => { if (state.settingsOpen) void loadProviders() })
}
