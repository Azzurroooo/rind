import type { DesktopAuthPrompt, DesktopAuthProvider, DesktopCustomProvider } from "../../preload/types.ts"
import { authPromptDialog, authPromptField, authPromptForm, authPromptMessage, requiredElement, settingsProviders } from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { loadAvailableModels } from "./settings.ts"
import { render } from "./shell.ts"
import { state } from "./state.ts"

export const BUILTIN_PROVIDER_CATALOG: ReadonlyArray<{
  id: string
  name: string
  methods: string[]
  envKey?: string
}> = [
  { id: "openai", name: "OpenAI", methods: ["api_key", "oauth"], envKey: "OPENAI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", methods: ["api_key"], envKey: "DEEPSEEK_API_KEY" },
  { id: "anthropic", name: "Anthropic", methods: ["api_key"], envKey: "ANTHROPIC_API_KEY" },
  { id: "google", name: "Google Gemini", methods: ["api_key"], envKey: "GEMINI_API_KEY" },
  { id: "openrouter", name: "OpenRouter", methods: ["api_key"], envKey: "OPENROUTER_API_KEY" },
  { id: "xai", name: "xAI (Grok)", methods: ["api_key"], envKey: "XAI_API_KEY" },
  { id: "qwen", name: "Qwen (DashScope)", methods: ["api_key"], envKey: "DASHSCOPE_API_KEY" },
  { id: "kimi-coding", name: "Kimi for Coding", methods: ["api_key"], envKey: "KIMI_API_KEY" },
  { id: "moonshot", name: "Moonshot AI", methods: ["api_key"], envKey: "MOONSHOT_API_KEY" },
  { id: "zai", name: "Z.AI", methods: ["api_key"], envKey: "ZAI_API_KEY" },
  { id: "zhipu", name: "Zhipu AI (GLM)", methods: ["api_key"], envKey: "ZHIPU_API_KEY" },
  { id: "minimax", name: "MiniMax", methods: ["api_key"], envKey: "MINIMAX_API_KEY" },
  { id: "volcengine", name: "Volcengine (Ark)", methods: ["api_key"], envKey: "ARK_API_KEY" },
  { id: "xiaomi", name: "Xiaomi MiMo", methods: ["api_key"], envKey: "MIMO_API_KEY" },
  { id: "hunyuan", name: "Tencent Hunyuan", methods: ["api_key"], envKey: "HUNYUAN_API_KEY" },
  { id: "groq", name: "Groq", methods: ["api_key"], envKey: "GROQ_API_KEY" },
  { id: "mistral", name: "Mistral", methods: ["api_key"], envKey: "MISTRAL_API_KEY" },
  { id: "siliconflow", name: "SiliconFlow", methods: ["api_key"], envKey: "SILICONFLOW_API_KEY" },
  { id: "together", name: "Together AI", methods: ["api_key"], envKey: "TOGETHER_API_KEY" },
  { id: "fireworks", name: "Fireworks AI", methods: ["api_key"], envKey: "FIREWORKS_API_KEY" },
  { id: "cerebras", name: "Cerebras", methods: ["api_key"], envKey: "CEREBRAS_API_KEY" },
  { id: "perplexity", name: "Perplexity", methods: ["api_key"], envKey: "PERPLEXITY_API_KEY" },
  { id: "cohere", name: "Cohere", methods: ["api_key"], envKey: "COHERE_API_KEY" },
  { id: "nvidia", name: "NVIDIA NIM", methods: ["api_key"], envKey: "NVIDIA_API_KEY" },
  { id: "longcat", name: "LongCat", methods: ["api_key"], envKey: "LONGCAT_API_KEY" },
]

type ProviderFilter = "all" | "configured" | "oauth" | "custom"

type EnrichedProvider = DesktopAuthProvider & {
  envKey?: string
  custom?: DesktopCustomProvider
  authType?: "oauth" | "api_key" | "env" | ""
  maskedKey?: string
}

type ProvidersView = {
  providers: readonly DesktopAuthProvider[]
  loading: boolean
  busyProviderId: string
  error: string
  message: string
  search: string
  filter: ProviderFilter
  editingKeyProviderId: string
  customFormOpen: boolean
  editingCustomId: string
  customDraft: {
    name: string
    api: string
    baseUrl: string
    defaultModel: string
    apiKey: string
    envKey: string
  }
  oauthUrl: string
}

const emptyCustomDraft = () => ({
  name: "",
  api: "openai-chat",
  baseUrl: "",
  defaultModel: "",
  apiKey: "",
  envKey: "",
})

let view: ProvidersView = {
  providers: [],
  loading: false,
  busyProviderId: "",
  error: "",
  message: "",
  search: "",
  filter: "all",
  editingKeyProviderId: "",
  customFormOpen: false,
  editingCustomId: "",
  customDraft: emptyCustomDraft(),
  oauthUrl: "",
}

let activePrompt: DesktopAuthPrompt | undefined
let onProvidersUpdatedCallback: (() => void) | undefined

export function setOnProvidersUpdated(cb: () => void) {
  onProvidersUpdatedCallback = cb
}

function setView(patch: Partial<ProvidersView>) {
  view = { ...view, ...patch }
  renderProviders()
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function getMergedProviders(): EnrichedProvider[] {
  const authDetails = state.settings.authDetails || {}
  const customMap = new Map<string, DesktopCustomProvider>()
  for (const custom of state.settings.customProviders || []) {
    customMap.set(custom.id, custom)
  }

  const baseList: Array<DesktopAuthProvider & { envKey?: string }> = view.providers.length > 0
    ? view.providers.map((p) => {
        const builtin = BUILTIN_PROVIDER_CATALOG.find((b) => b.id === p.id)
        return { ...p, envKey: (p as any).env_key || builtin?.envKey }
      })
    : BUILTIN_PROVIDER_CATALOG.map((b) => ({
        id: b.id,
        name: b.name,
        methods: [...b.methods],
        configured: Boolean(authDetails[b.id]),
        source: authDetails[b.id] ? "auth.json" : "",
        envKey: b.envKey,
      }))

  const seenIds = new Set(baseList.map((p) => p.id))
  for (const custom of customMap.values()) {
    if (!seenIds.has(custom.id)) {
      baseList.push({
        id: custom.id,
        name: custom.name || custom.id,
        methods: ["api_key"],
        configured: Boolean(authDetails[custom.id]),
        source: authDetails[custom.id] ? "auth.json" : "",
        envKey: custom.envKey,
      })
      seenIds.add(custom.id)
    }
  }

  return baseList.map((p) => {
    const detail = authDetails[p.id]
    const custom = customMap.get(p.id)
    const configured = Boolean(p.configured || detail)
    const authType: "oauth" | "api_key" | "env" | "" = detail?.type === "oauth"
      ? "oauth"
      : detail?.type === "api_key"
        ? "api_key"
        : p.source === "env"
          ? "env"
          : configured
            ? "api_key"
            : ""
    return {
      ...p,
      name: custom?.name || p.name || p.id,
      configured,
      source: detail ? "auth.json" : p.source,
      custom,
      authType,
      maskedKey: detail?.maskedKey,
    }
  })
}

export function providerStatus(provider: DesktopAuthProvider | EnrichedProvider) {
  const enriched = provider as EnrichedProvider
  if (!enriched.configured) return "Not configured"
  if (enriched.authType === "oauth") return "OAuth subscription (auth.json)"
  if (enriched.authType === "api_key") {
    return enriched.maskedKey
      ? `API key · ${enriched.maskedKey}`
      : "API key (auth.json)"
  }
  if (enriched.source === "env") {
    return enriched.envKey ? `Environment (${enriched.envKey})` : "Environment variable"
  }
  return enriched.source ? `Signed in (${enriched.source})` : "Signed in"
}

function renderCustomProviderForm() {
  if (!view.customFormOpen) return ""
  const d = view.customDraft
  const isEdit = Boolean(view.editingCustomId)
  return `
    <div class="provider-custom-card">
      <div class="provider-custom-head">
        <div>
          <h4>${isEdit ? `Edit provider "${escapeHtml(d.name || view.editingCustomId)}"` : "Add custom provider"}</h4>
          <p class="subtle">Saved to ~/.rind/providers.json and ~/.rind/auth.json.</p>
        </div>
        <button type="button" class="ghost-button" data-provider-cancel-custom="1">Cancel</button>
      </div>
      <div class="provider-custom-grid">
        <label>
          <span>Connection name</span>
          <input id="custom-provider-name" type="text" value="${escapeAttribute(d.name)}" placeholder="e.g. Xiaomi, Ollama, vLLM" autocomplete="off" />
        </label>
        <label>
          <span>API protocol</span>
          <select id="custom-provider-api">
            <option value="openai-chat"${d.api === "openai-chat" ? " selected" : ""}>openai-chat · OpenAI Chat Completions</option>
            <option value="openai-responses"${d.api === "openai-responses" ? " selected" : ""}>openai-responses · OpenAI Responses</option>
            <option value="anthropic-messages"${d.api === "anthropic-messages" ? " selected" : ""}>anthropic-messages · Anthropic Messages</option>
            <option value="google-generative-ai"${d.api === "google-generative-ai" ? " selected" : ""}>google-generative-ai · Google Generative AI</option>
          </select>
        </label>
        <label class="provider-custom-span-2">
          <span>Base URL</span>
          <input id="custom-provider-url" type="url" value="${escapeAttribute(d.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off" />
        </label>
        <label>
          <span>Default model ID (optional)</span>
          <input id="custom-provider-model" type="text" value="${escapeAttribute(d.defaultModel)}" placeholder="e.g. mimo-v2-flash" autocomplete="off" />
        </label>
        <label>
          <span>API key ${isEdit ? "(leave blank to keep)" : "(optional for local endpoints)"}</span>
          <input id="custom-provider-key" type="password" value="${escapeAttribute(d.apiKey)}" placeholder="sk-..." autocomplete="new-password" />
        </label>
      </div>
      <div class="provider-custom-actions">
        <button type="button" class="primary-button" data-provider-save-custom="1">${isEdit ? "Update provider" : "Save provider"}</button>
      </div>
    </div>
  `
}

function renderProviderRow(provider: EnrichedProvider) {
  const busy = view.busyProviderId === provider.id
  const disabled = view.busyProviderId !== "" ? " disabled" : ""
  const methods = provider.methods.length ? provider.methods : ["api_key"]
  const supportsOauth = methods.includes("oauth")
  const isEditingKey = view.editingKeyProviderId === provider.id
  const isDefault = (state.settings.provider || "openai") === provider.id

  const badges: string[] = [
    `<span class="provider-id-chip">${escapeHtml(provider.id)}</span>`,
  ]
  if (isDefault) {
    badges.push(`<span class="provider-badge provider-badge-default">Default</span>`)
  }
  if (provider.authType === "oauth") {
    badges.push(`<span class="provider-badge provider-badge-oauth">Subscription · OAuth</span>`)
  } else if (provider.authType === "api_key") {
    badges.push(`<span class="provider-badge provider-badge-key">API Key</span>`)
  } else if (provider.authType === "env") {
    badges.push(`<span class="provider-badge provider-badge-env">Env</span>`)
  }
  if (provider.custom) {
    badges.push(`<span class="provider-badge provider-badge-custom">${escapeHtml(provider.custom.api)}</span>`)
  }

  const actionButtons: string[] = []
  if (supportsOauth) {
    const oauthLabel = busy
      ? "Connecting..."
      : provider.authType === "oauth"
        ? "Reconnect OAuth"
        : "Sign in (OAuth)"
    actionButtons.push(
      `<button type="button" class="${provider.authType === "oauth" ? "ghost-button" : "secondary-button"}" data-provider-login="${escapeAttribute(provider.id)}" data-provider-method="oauth"${disabled}>${escapeHtml(oauthLabel)}</button>`,
    )
  }

  actionButtons.push(
    `<button type="button" class="${provider.configured && !isEditingKey ? "ghost-button" : "secondary-button"}" data-provider-toggle-key="${escapeAttribute(provider.id)}"${disabled}>${isEditingKey ? "Cancel" : provider.authType === "api_key" ? "Update key" : "API key"}</button>`,
  )

  if (provider.custom) {
    actionButtons.push(
      `<button type="button" class="ghost-button" data-provider-edit-custom="${escapeAttribute(provider.id)}"${disabled}>Edit</button>`,
      `<button type="button" class="ghost-button danger-text-btn" data-provider-delete-custom="${escapeAttribute(provider.id)}"${disabled}>Delete</button>`,
    )
  } else if (provider.configured && provider.source !== "env") {
    actionButtons.push(
      `<button type="button" class="ghost-button" data-provider-logout="${escapeAttribute(provider.id)}"${disabled}>${busy ? "Signing out..." : "Sign out"}</button>`,
    )
  }

  const endpointSubtitle = provider.custom?.baseUrl
    ? `<span class="provider-endpoint-meta">${escapeHtml(provider.custom.baseUrl)}</span>`
    : ""

  const keyEditor = isEditingKey
    ? `<div class="provider-key-editor">
        <input id="provider-inline-key-${escapeAttribute(provider.id)}" class="provider-inline-key-input" type="password" placeholder="Paste ${escapeAttribute(provider.name || provider.id)} API key..." autocomplete="new-password" spellcheck="false" />
        <button type="button" class="primary-button" data-provider-save-key="${escapeAttribute(provider.id)}">Save key</button>
      </div>`
    : ""

  return `<div class="settings-row provider-row${provider.configured ? " is-configured" : ""}">
    <div class="provider-row-main">
      <div class="settings-row-text">
        <div class="provider-title-line">
          <span class="settings-row-label">${escapeHtml(provider.name || provider.id)}</span>
          ${badges.join("")}
        </div>
        <span class="settings-row-desc">
          <span class="status-dot" data-configured="${provider.configured}" aria-hidden="true"></span>
          <span>${escapeHtml(providerStatus(provider))}</span>
          ${endpointSubtitle}
        </span>
      </div>
      <div class="settings-row-control provider-actions">${actionButtons.join("")}</div>
    </div>
    ${keyEditor}
  </div>`
}

export function renderProviders() {
  const activeElement = document.activeElement
  const wasFocusedSearch = activeElement instanceof HTMLInputElement && activeElement.id === "providers-search-input"
  const selectionStart = wasFocusedSearch ? activeElement.selectionStart : null
  const selectionEnd = wasFocusedSearch ? activeElement.selectionEnd : null

  const allProviders = getMergedProviders()
  const configuredCount = allProviders.filter((p) => p.configured).length
  const oauthCount = allProviders.filter((p) => p.methods.includes("oauth") || p.authType === "oauth").length
  const customCount = allProviders.filter((p) => Boolean(p.custom)).length

  const query = view.search.trim().toLowerCase()
  const filtered = allProviders
    .filter((p) => {
      if (view.filter === "configured" && !p.configured) return false
      if (view.filter === "oauth" && !p.methods.includes("oauth") && p.authType !== "oauth") return false
      if (view.filter === "custom" && !p.custom) return false
      if (!query) return true
      return (
        p.id.toLowerCase().includes(query) ||
        (p.name || "").toLowerCase().includes(query) ||
        (p.envKey || "").toLowerCase().includes(query) ||
        (p.custom?.baseUrl || "").toLowerCase().includes(query)
      )
    })
    .sort((a, b) => {
      const aDefault = (state.settings.provider || "openai") === a.id ? 1 : 0
      const bDefault = (state.settings.provider || "openai") === b.id ? 1 : 0
      if (aDefault !== bDefault) return bDefault - aDefault
      if (a.configured !== b.configured) return a.configured ? -1 : 1
      return (a.name || a.id).localeCompare(b.name || b.id)
    })

  const notice = view.error
    ? `<p class="settings-inline-error" role="alert">${escapeHtml(view.error)}</p>`
    : view.message
      ? `<p class="settings-inline-note">${escapeHtml(view.message)}</p>`
      : ""

  const toolbar = `
    <div class="providers-toolbar">
      <div class="providers-search-row">
        <input id="providers-search-input" type="search" value="${escapeAttribute(view.search)}" placeholder="Search providers by name, ID, or env var..." autocomplete="off" />
        <button type="button" class="secondary-button providers-add-btn" data-provider-open-custom="1">+ Custom provider</button>
      </div>
      <div class="providers-filter-pills" role="tablist" aria-label="Filter providers">
        <button type="button" class="provider-filter-pill${view.filter === "all" ? " is-active" : ""}" data-provider-filter="all">All (${allProviders.length})</button>
        <button type="button" class="provider-filter-pill${view.filter === "configured" ? " is-active" : ""}" data-provider-filter="configured">Connected (${configuredCount})</button>
        <button type="button" class="provider-filter-pill${view.filter === "oauth" ? " is-active" : ""}" data-provider-filter="oauth">Subscription (${oauthCount})</button>
        <button type="button" class="provider-filter-pill${view.filter === "custom" ? " is-active" : ""}" data-provider-filter="custom">Custom (${customCount})</button>
      </div>
    </div>
  `

  const rows = filtered.length
    ? filtered.map(renderProviderRow).join("")
    : `<p class="subtle provider-empty">No providers match the current filter.</p>`

  settingsProviders.innerHTML = `${toolbar}${renderCustomProviderForm()}${notice}<div class="provider-rows-wrap">${rows}</div>`

  if (wasFocusedSearch) {
    const nextSearch = document.getElementById("providers-search-input") as HTMLInputElement | null
    if (nextSearch) {
      nextSearch.focus()
      if (selectionStart !== null && selectionEnd !== null) {
        nextSearch.setSelectionRange(selectionStart, selectionEnd)
      }
    }
  }
}

function normalizeProvider(value: unknown): DesktopAuthProvider | undefined {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
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
  setView({ loading: true, error: "" })
  try {
    state.settings = await window.api.settings.get()
    if (state.runtime.status === "ready") {
      const providers = (await window.api.auth.list())
        .map(normalizeProvider)
        .filter((item): item is DesktopAuthProvider => item !== undefined)
      state.providerNames = Object.fromEntries(providers.map((provider) => [provider.id, provider.name]))
      setView({ providers, loading: false })
    } else {
      const merged = getMergedProviders()
      state.providerNames = Object.fromEntries(merged.map((provider) => [provider.id, provider.name]))
      setView({ loading: false })
    }
    onProvidersUpdatedCallback?.()
  } catch (error) {
    setView({ loading: false, error: errorText(error) })
  }
}

async function login(providerId: string, method?: string) {
  setView({ busyProviderId: providerId, error: "", message: "", oauthUrl: "" })
  try {
    // Pass state.viewedSessionId || "" so the worker never creates a junk session just for login.
    const sessionId = state.viewedSessionId || ""
    const result = await window.api.auth.login(sessionId, providerId, method)
    const count = typeof result.models_count === "number" ? ` ${result.models_count} models available.` : ""
    setView({ busyProviderId: "", message: `Connected ${providerId}.${count}`, oauthUrl: "" })
    await loadProviders()
    await loadAvailableModels().catch(() => undefined)
    render()
  } catch (error) {
    setView({ busyProviderId: "", error: errorText(error), oauthUrl: "" })
  }
}

async function saveInlineKey(providerId: string) {
  const input = document.getElementById(`provider-inline-key-${providerId}`) as HTMLInputElement | null
  const apiKey = input?.value.trim() || ""
  if (!apiKey) {
    setView({ error: "Enter a non-empty API key." })
    input?.focus()
    return
  }
  setView({ busyProviderId: providerId, error: "", message: "" })
  try {
    state.settings = await window.api.settings.save({
      providerCredential: { providerId, apiKey },
    })
    setView({
      busyProviderId: "",
      editingKeyProviderId: "",
      message: `Saved API key for ${providerId}.`,
    })
    await loadProviders()
    await loadAvailableModels().catch(() => undefined)
    render()
  } catch (error) {
    setView({ busyProviderId: "", error: errorText(error) })
  }
}

async function saveCustomProviderFromForm() {
  const nameInput = document.getElementById("custom-provider-name") as HTMLInputElement | null
  const apiSelect = document.getElementById("custom-provider-api") as HTMLSelectElement | null
  const urlInput = document.getElementById("custom-provider-url") as HTMLInputElement | null
  const modelInput = document.getElementById("custom-provider-model") as HTMLInputElement | null
  const keyInput = document.getElementById("custom-provider-key") as HTMLInputElement | null

  const name = nameInput?.value.trim() || ""
  const api = apiSelect?.value.trim() || "openai-chat"
  const baseUrl = urlInput?.value.trim() || ""
  const defaultModel = modelInput?.value.trim() || ""
  const apiKey = keyInput?.value.trim() || ""

  view.customDraft = { ...view.customDraft, name, api, baseUrl, defaultModel, apiKey }

  if (!name) {
    setView({ error: "Enter a connection name." })
    nameInput?.focus()
    return
  }
  if (!baseUrl) {
    setView({ error: "Enter a valid http(s) Base URL." })
    urlInput?.focus()
    return
  }

  setView({ busyProviderId: view.editingCustomId || name, error: "", message: "" })
  try {
    state.settings = await window.api.settings.save({
      customProvider: {
        ...(view.editingCustomId ? { id: view.editingCustomId } : {}),
        name,
        api,
        baseUrl,
        ...(defaultModel ? { defaultModel } : {}),
        ...(apiKey ? { apiKey } : {}),
      },
    })
    setView({
      busyProviderId: "",
      customFormOpen: false,
      editingCustomId: "",
      customDraft: emptyCustomDraft(),
      message: `Saved custom provider "${name}".`,
    })
    await loadProviders()
    await loadAvailableModels().catch(() => undefined)
    render()
  } catch (error) {
    setView({ busyProviderId: "", error: errorText(error) })
  }
}

async function deleteCustomProvider(providerId: string) {
  setView({ busyProviderId: providerId, error: "", message: "" })
  try {
    if (state.runtime.status === "ready") {
      await window.api.auth.logout(providerId).catch(() => undefined)
    }
    state.settings = await window.api.settings.save({
      deleteCustomProviderId: providerId,
    })
    setView({ busyProviderId: "", message: `Removed custom provider "${providerId}".` })
    await loadProviders()
    await loadAvailableModels().catch(() => undefined)
    render()
  } catch (error) {
    setView({ busyProviderId: "", error: errorText(error) })
  }
}

async function logout(providerId: string) {
  setView({ busyProviderId: providerId, error: "", message: "" })
  try {
    if (state.runtime.status === "ready") {
      await window.api.auth.logout(providerId).catch(() => undefined)
    }
    state.settings = await window.api.settings.save({
      removeProviderCredentialId: providerId,
    })
    setView({ busyProviderId: "", message: `Signed out of ${providerId}.` })
    await loadProviders()
    await loadAvailableModels().catch(() => undefined)
    render()
  } catch (error) {
    setView({ busyProviderId: "", error: errorText(error) })
  }
}

function promptControl(prompt: DesktopAuthPrompt) {
  if (prompt.kind === "select" && prompt.options.length) {
    const options = prompt.options
      .map((option) => `<option value="${escapeAttribute(option)}">${escapeHtml(option)}</option>`)
      .join("")
    return `<select id="auth-prompt-input">${options}</select>`
  }
  const type = prompt.kind === "secret" ? "password" : "text"
  return `<input id="auth-prompt-input" type="${type}" autocomplete="off" spellcheck="false" required />`
}

function renderOauthBox() {
  const box = document.getElementById("auth-prompt-oauth-box")
  if (!box) return
  if (!view.oauthUrl) {
    box.hidden = true
    box.innerHTML = ""
    return
  }
  box.hidden = false
  box.innerHTML = `
    <div class="auth-oauth-banner">
      <span class="subtle">Browser sign-in link:</span>
      <code class="auth-oauth-url">${escapeHtml(view.oauthUrl)}</code>
      <button type="button" class="ghost-button" id="copy-oauth-url-btn">Copy link</button>
    </div>
  `
  document.getElementById("copy-oauth-url-btn")?.addEventListener("click", () => {
    void navigator.clipboard?.writeText(view.oauthUrl)
  })
}

function showPrompt(prompt: DesktopAuthPrompt) {
  if (activePrompt) void window.api.auth.respond(activePrompt.requestId, "").catch(() => undefined)
  activePrompt = prompt
  authPromptMessage.textContent = prompt.message || "Enter a value"
  authPromptField.innerHTML = promptControl(prompt)
  renderOauthBox()
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
  settingsProviders.addEventListener("input", (event) => {
    const target = event.target
    if (target instanceof HTMLInputElement && target.id === "providers-search-input") {
      setView({ search: target.value })
    }
  })

  settingsProviders.addEventListener("keydown", (event) => {
    const target = event.target
    if (target instanceof HTMLInputElement && target.classList.contains("provider-inline-key-input") && event.key === "Enter") {
      event.preventDefault()
      const providerId = target.id.replace(/^provider-inline-key-/, "")
      if (providerId) void saveInlineKey(providerId)
    }
  })

  settingsProviders.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null
    if (!target || target.disabled) return

    const filter = target.dataset.providerFilter as ProviderFilter | undefined
    if (filter) {
      setView({ filter })
      return
    }
    if (target.dataset.providerOpenCustom) {
      setView({
        customFormOpen: true,
        editingCustomId: "",
        customDraft: emptyCustomDraft(),
        error: "",
      })
      return
    }
    if (target.dataset.providerCancelCustom) {
      setView({
        customFormOpen: false,
        editingCustomId: "",
        customDraft: emptyCustomDraft(),
      })
      return
    }
    if (target.dataset.providerSaveCustom) {
      void saveCustomProviderFromForm()
      return
    }
    const editCustomId = target.dataset.providerEditCustom
    if (editCustomId) {
      const custom = (state.settings.customProviders || []).find((c) => c.id === editCustomId)
      if (custom) {
        setView({
          customFormOpen: true,
          editingCustomId: custom.id,
          customDraft: {
            name: custom.name,
            api: custom.api,
            baseUrl: custom.baseUrl,
            defaultModel: custom.models[0] || "",
            apiKey: "",
            envKey: custom.envKey || "",
          },
          error: "",
        })
      }
      return
    }
    const deleteCustomId = target.dataset.providerDeleteCustom
    if (deleteCustomId) {
      void deleteCustomProvider(deleteCustomId)
      return
    }
    const toggleKeyId = target.dataset.providerToggleKey
    if (toggleKeyId) {
      const nextId = view.editingKeyProviderId === toggleKeyId ? "" : toggleKeyId
      setView({ editingKeyProviderId: nextId, error: "" })
      if (nextId) {
        requestAnimationFrame(() => {
          const input = document.getElementById(`provider-inline-key-${nextId}`) as HTMLInputElement | null
          input?.focus()
        })
      }
      return
    }
    const saveKeyId = target.dataset.providerSaveKey
    if (saveKeyId) {
      void saveInlineKey(saveKeyId)
      return
    }

    const loginId = target.dataset.providerLogin
    const loginMethod = target.dataset.providerMethod
    const logoutId = target.dataset.providerLogout
    if (loginId) void login(loginId, loginMethod)
    if (logoutId) void logout(logoutId)
  })

  authPromptForm.addEventListener("submit", (event) => {
    event.preventDefault()
    const input = requiredElement<HTMLInputElement | HTMLSelectElement>("auth-prompt-input")
    void answerPrompt(input.value)
  })
  requiredElement("auth-prompt-cancel").addEventListener("click", () => {
    void answerPrompt("")
  })
  document.getElementById("auth-prompt-close")?.addEventListener("click", () => {
    void answerPrompt("")
  })
  authPromptDialog.addEventListener("cancel", (event) => {
    event.preventDefault()
    void answerPrompt("")
  })
  window.api.auth.onPrompt(showPrompt)
  window.api.auth.onUpdate((update) => {
    if (update.type === "auth_url" && typeof update.url === "string") {
      view = { ...view, oauthUrl: update.url }
      renderOauthBox()
    }
    if (state.settingsOpen) void loadProviders()
  })
}
