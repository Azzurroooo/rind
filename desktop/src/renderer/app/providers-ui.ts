import type { DesktopAuthPrompt, DesktopAuthProvider, DesktopCustomProvider } from "../../preload/types.ts"
import { authPromptDialog, authPromptField, authPromptForm, authPromptMessage, requiredElement, settingsProviders } from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { loadAvailableModels } from "./settings.ts"
import { render } from "./shell.ts"
import { state } from "./state.ts"

export type CatalogModelSpec = {
  id: string
  efforts: readonly string[]
}

export type BuiltinProviderSpec = {
  id: string
  name: string
  api: string
  methods: readonly string[]
  envKey?: string
  models: readonly CatalogModelSpec[]
}

export const BUILTIN_PROVIDER_CATALOG: readonly BuiltinProviderSpec[] = [
  {
    id: "openai",
    name: "OpenAI",
    api: "openai-responses",
    methods: ["api_key", "oauth"],
    envKey: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.4", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.4-mini", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-4o-mini", efforts: [] },
      { id: "gpt-4.1", efforts: [] },
      { id: "gpt-4o", efforts: [] },
      { id: "o3", efforts: ["low", "medium", "high"] },
      { id: "o4-mini", efforts: ["low", "medium", "high"] },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-flash", efforts: ["low", "high", "max"] },
      { id: "deepseek-v4-pro", efforts: ["low", "high", "max"] },
      { id: "deepseek-v4-flash", efforts: ["low", "high", "max"] },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic-messages",
    methods: ["api_key"],
    envKey: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-sonnet-5-5", efforts: [] },
      { id: "claude-opus-5-5", efforts: [] },
      { id: "claude-sonnet-4-6", efforts: [] },
      { id: "claude-opus-4-6", efforts: [] },
      { id: "claude-haiku-4-5", efforts: [] },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    api: "google-generative-ai",
    methods: ["api_key"],
    envKey: "GEMINI_API_KEY",
    models: [
      { id: "gemini-3.5-flash", efforts: [] },
      { id: "gemini-3.1-pro-preview", efforts: [] },
      { id: "gemini-2.5-pro", efforts: [] },
      { id: "gemini-2.5-flash", efforts: [] },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "OPENROUTER_API_KEY",
    models: [
      { id: "openai/gpt-5.5", efforts: [] },
      { id: "anthropic/claude-sonnet-4.6", efforts: [] },
      { id: "deepseek/deepseek-v4.1-flash", efforts: [] },
    ],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    api: "openai-responses",
    methods: ["api_key"],
    envKey: "XAI_API_KEY",
    models: [
      { id: "grok-4.7", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "grok-4.6", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "grok-4.5", efforts: ["low", "medium", "high"] },
    ],
  },
  {
    id: "qwen",
    name: "Qwen (DashScope)",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "DASHSCOPE_API_KEY",
    models: [
      { id: "qwen3-coder-plus", efforts: [] },
      { id: "qwen3.8-max", efforts: ["low", "medium", "xhigh"] },
      { id: "qwen3.8-flash", efforts: ["low", "medium", "xhigh"] },
      { id: "qwen-max", efforts: [] },
    ],
  },
  {
    id: "kimi-coding",
    name: "Kimi for Coding",
    api: "anthropic-messages",
    methods: ["api_key"],
    envKey: "KIMI_API_KEY",
    models: [
      { id: "kimi-for-coding", efforts: [] },
      { id: "k3", efforts: [] },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot AI",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "MOONSHOT_API_KEY",
    models: [
      { id: "kimi-k3", efforts: ["low", "high", "max"] },
      { id: "kimi-k2.7-code", efforts: [] },
      { id: "kimi-k2.6", efforts: [] },
    ],
  },
  {
    id: "zai",
    name: "Z.AI",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "ZAI_API_KEY",
    models: [
      { id: "glm-5.3", efforts: ["low", "high", "max"] },
      { id: "glm-5.3-flash", efforts: ["low", "high", "max"] },
      { id: "glm-4.7", efforts: [] },
    ],
  },
  {
    id: "zhipu",
    name: "Zhipu AI (GLM)",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "ZHIPU_API_KEY",
    models: [
      { id: "glm-5.3", efforts: ["low", "high", "max"] },
      { id: "glm-5.3-flash", efforts: ["low", "high", "max"] },
      { id: "glm-4.7", efforts: [] },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    api: "anthropic-messages",
    methods: ["api_key"],
    envKey: "MINIMAX_API_KEY",
    models: [{ id: "MiniMax-M3", efforts: [] }],
  },
  {
    id: "volcengine",
    name: "Volcengine (Ark)",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "ARK_API_KEY",
    models: [{ id: "doubao-seed-2-1-pro-260628", efforts: [] }],
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "MIMO_API_KEY",
    models: [
      { id: "mimo-v2.6-pro", efforts: [] },
      { id: "mimo-v2.6-flash", efforts: [] },
    ],
  },
  {
    id: "hunyuan",
    name: "Tencent Hunyuan",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "HUNYUAN_API_KEY",
    models: [{ id: "hunyuan-turbos-latest", efforts: [] }],
  },
  {
    id: "groq",
    name: "Groq",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "GROQ_API_KEY",
    models: [
      { id: "llama-3.3-70b-versatile", efforts: [] },
      { id: "openai/gpt-oss-120b", efforts: ["low", "medium", "high"] },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "MISTRAL_API_KEY",
    models: [
      { id: "mistral-large-latest", efforts: [] },
      { id: "codestral-latest", efforts: [] },
    ],
  },
  {
    id: "longcat",
    name: "LongCat",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "LONGCAT_API_KEY",
    models: [
      { id: "LongCat-2.5-Preview", efforts: [] },
      { id: "LongCat-2.0", efforts: [] },
    ],
  },
]

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

export type EnrichedProvider = DesktopAuthProvider & {
  envKey?: string
  custom?: DesktopCustomProvider
  authType?: "oauth" | "api_key" | "env" | "custom" | ""
  maskedKey?: string
}

type ProvidersView = {
  providers: readonly DesktopAuthProvider[]
  loading: boolean
  busyProviderId: string
  error: string
  message: string
  search: string
  openMenuId: string
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
  openMenuId: "",
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
        configured: true,
        source: authDetails[custom.id] ? "auth.json" : "providers.json",
        envKey: custom.envKey,
      })
      seenIds.add(custom.id)
    }
  }

  return baseList.map((p) => {
    const detail = authDetails[p.id]
    const custom = customMap.get(p.id)
    const configured = Boolean(p.configured || detail || custom)
    const authType: EnrichedProvider["authType"] = detail?.type === "oauth"
      ? "oauth"
      : detail?.type === "api_key"
        ? "api_key"
        : p.source === "env"
          ? "env"
          : custom
            ? "custom"
            : configured
              ? "api_key"
              : ""
    return {
      ...p,
      name: custom?.name || p.name || p.id,
      configured,
      source: detail ? "auth.json" : p.source || (custom ? "providers.json" : ""),
      custom,
      authType,
      maskedKey: detail?.maskedKey,
    }
  })
}

export function getProviderModels(providerId: string): string[] {
  const models = new Set<string>()
  for (const m of state.models) {
    if (m.providerId === providerId && m.id) {
      models.add(m.id)
    }
  }
  const custom = (state.settings.customProviders || []).find((c) => c.id === providerId)
  if (custom) {
    for (const m of custom.models) {
      if (m) models.add(m)
    }
  }
  const builtin = BUILTIN_PROVIDER_CATALOG.find((b) => b.id === providerId)
  if (builtin) {
    for (const m of builtin.models) {
      models.add(m.id)
    }
  }
  if (state.settings.provider === providerId && state.settings.model) {
    models.add(state.settings.model)
  }
  return [...models]
}

export function getModelReasoningEfforts(providerId: string, modelId: string): readonly string[] {
  const runtimeMatch = state.models.find((m) => m.providerId === providerId && m.id === modelId)
  if (runtimeMatch && Array.isArray((runtimeMatch as any).reasoningEfforts)) {
    return (runtimeMatch as any).reasoningEfforts
  }
  const builtin = BUILTIN_PROVIDER_CATALOG.find((b) => b.id === providerId)
  const builtinModel = builtin?.models.find((m) => m.id === modelId)
  if (builtinModel) {
    return builtinModel.efforts
  }
  const custom = (state.settings.customProviders || []).find((c) => c.id === providerId)
  const api = custom?.api || builtin?.api || "openai-chat"
  if (api === "anthropic-messages" || api === "google-generative-ai") {
    return []
  }
  return ALL_EFFORTS
}

export function getProviderSourceLabel(provider: EnrichedProvider | undefined): "OAuth" | "Custom" | "Built-in" {
  if (provider?.custom || provider?.authType === "custom") return "Custom"
  if (provider?.authType === "oauth") return "OAuth"
  return "Built-in"
}

export function getProviderSourceLabelById(providerId: string): "OAuth" | "Custom" | "Built-in" {
  const match = getMergedProviders().find((p) => p.id === providerId)
  return getProviderSourceLabel(match)
}

export function providerStatus(provider: DesktopAuthProvider | EnrichedProvider) {
  const enriched = provider as EnrichedProvider
  if (!enriched.configured) return "Not connected"
  if (enriched.authType === "oauth") return "Subscription · OAuth"
  if (enriched.authType === "api_key") {
    return enriched.maskedKey ? `API key · ${enriched.maskedKey}` : "API key connected"
  }
  if (enriched.source === "env") {
    return enriched.envKey ? `Environment (${enriched.envKey})` : "Environment variable"
  }
  if (enriched.custom) {
    return enriched.maskedKey ? `Custom · ${enriched.maskedKey}` : "Custom endpoint"
  }
  return "Connected"
}

function renderCustomProviderForm() {
  if (!view.customFormOpen) return ""
  const d = view.customDraft
  const isEdit = Boolean(view.editingCustomId)
  return `
    <div class="provider-custom-card">
      <div class="provider-custom-head">
        <div>
          <h4>${isEdit ? `Edit "${escapeHtml(d.name || view.editingCustomId)}"` : "New custom API"}</h4>
          <p class="subtle">Saved to ~/.rind/providers.json</p>
        </div>
        <button type="button" class="ghost-button" data-provider-cancel-custom="1">Cancel</button>
      </div>
      <div class="provider-custom-grid">
        <label>
          <span>Name</span>
          <input id="custom-provider-name" type="text" value="${escapeAttribute(d.name)}" placeholder="e.g. Xiaomi, Ollama, vLLM" autocomplete="off" />
        </label>
        <label>
          <span>Protocol</span>
          <select id="custom-provider-api">
            <option value="openai-chat"${d.api === "openai-chat" ? " selected" : ""}>OpenAI Chat Completions</option>
            <option value="openai-responses"${d.api === "openai-responses" ? " selected" : ""}>OpenAI Responses</option>
            <option value="anthropic-messages"${d.api === "anthropic-messages" ? " selected" : ""}>Anthropic Messages</option>
            <option value="google-generative-ai"${d.api === "google-generative-ai" ? " selected" : ""}>Google Generative AI</option>
          </select>
        </label>
        <label class="provider-custom-span-2">
          <span>Base URL</span>
          <input id="custom-provider-url" type="url" value="${escapeAttribute(d.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off" />
        </label>
        <label>
          <span>Default model</span>
          <input id="custom-provider-model" type="text" value="${escapeAttribute(d.defaultModel)}" placeholder="e.g. mimo-v2-flash" autocomplete="off" />
        </label>
        <label>
          <span>API key (optional)</span>
          <input id="custom-provider-key" type="password" value="${escapeAttribute(d.apiKey)}" placeholder="sk-..." autocomplete="new-password" />
        </label>
      </div>
      <div class="provider-custom-actions">
        <button type="button" class="primary-button" data-provider-save-custom="1">${isEdit ? "Update" : "Save"}</button>
      </div>
    </div>
  `
}

function renderSingleActionControl(
  provider: EnrichedProvider,
  section: "oauth" | "custom" | "builtin",
) {
  const busy = view.busyProviderId === provider.id
  const disabled = view.busyProviderId !== "" ? " disabled" : ""
  const isEditingKey = section !== "oauth" && view.editingKeyProviderId === provider.id
  const menuKey = `${section}:${provider.id}`
  const isMenuOpen = view.openMenuId === menuKey

  if (isEditingKey) {
    return `<button type="button" class="ghost-button" data-provider-toggle-key="${escapeAttribute(provider.id)}"${disabled}>Cancel</button>`
  }

  if (section === "oauth") {
    const isOauthConnected = provider.authType === "oauth"
    if (!isOauthConnected) {
      return `<button type="button" class="secondary-button" data-provider-login="${escapeAttribute(provider.id)}" data-provider-method="oauth"${disabled}>${busy ? "Working..." : "Connect"}</button>`
    }
    const menuItems = [
      `<button type="button" class="provider-menu-item" data-provider-login="${escapeAttribute(provider.id)}" data-provider-method="oauth">Reconnect OAuth</button>`,
      `<button type="button" class="provider-menu-item is-danger" data-provider-logout="${escapeAttribute(provider.id)}">Disconnect</button>`,
    ]
    return `
      <div class="provider-menu-wrap">
        <button type="button" class="ghost-button provider-menu-trigger" aria-expanded="${isMenuOpen}" data-provider-menu-toggle="${escapeAttribute(menuKey)}"${disabled}>${busy ? "Working..." : "Manage"}</button>
        ${isMenuOpen ? `<div class="provider-action-menu" role="menu">${menuItems.join("")}</div>` : ""}
      </div>
    `
  }

  if (section === "custom") {
    const menuItems = [
      `<button type="button" class="provider-menu-item" data-provider-edit-custom="${escapeAttribute(provider.id)}">Edit endpoint</button>`,
      `<button type="button" class="provider-menu-item" data-provider-toggle-key="${escapeAttribute(provider.id)}">${provider.maskedKey ? "Update API key" : "Set API key"}</button>`,
      `<button type="button" class="provider-menu-item is-danger" data-provider-delete-custom="${escapeAttribute(provider.id)}">Delete</button>`,
    ]
    return `
      <div class="provider-menu-wrap">
        <button type="button" class="ghost-button provider-menu-trigger" aria-expanded="${isMenuOpen}" data-provider-menu-toggle="${escapeAttribute(menuKey)}"${disabled}>${busy ? "Working..." : "Manage"}</button>
        ${isMenuOpen ? `<div class="provider-action-menu" role="menu">${menuItems.join("")}</div>` : ""}
      </div>
    `
  }

  // section === "builtin"
  const isKeyConfigured = provider.configured && provider.authType !== "oauth"
  if (!isKeyConfigured) {
    return `<button type="button" class="secondary-button" data-provider-toggle-key="${escapeAttribute(provider.id)}"${disabled}>${busy ? "Saving..." : "Connect"}</button>`
  }

  const menuItems = [
    `<button type="button" class="provider-menu-item" data-provider-toggle-key="${escapeAttribute(provider.id)}">Update API key</button>`,
  ]
  if (provider.source !== "env") {
    menuItems.push(
      `<button type="button" class="provider-menu-item is-danger" data-provider-logout="${escapeAttribute(provider.id)}">Disconnect</button>`,
    )
  }

  return `
    <div class="provider-menu-wrap">
      <button type="button" class="ghost-button provider-menu-trigger" aria-expanded="${isMenuOpen}" data-provider-menu-toggle="${escapeAttribute(menuKey)}"${disabled}>${busy ? "Working..." : "Manage"}</button>
      ${isMenuOpen ? `<div class="provider-action-menu" role="menu">${menuItems.join("")}</div>` : ""}
    </div>
  `
}

function renderProviderRow(provider: EnrichedProvider, section: "oauth" | "custom" | "builtin") {
  const isEditingKey = section !== "oauth" && view.editingKeyProviderId === provider.id
  const isConfiguredInSection =
    section === "oauth"
      ? provider.authType === "oauth"
      : section === "custom"
        ? true
        : provider.configured && provider.authType !== "oauth"

  const isDefault = (state.settings.provider || "openai") === provider.id && isConfiguredInSection
  const defaultBadge = isDefault
    ? `<span class="provider-badge provider-badge-default">Default</span>`
    : ""

  let statusLabel: string
  if (section === "oauth") {
    statusLabel = isConfiguredInSection ? "Subscription · OAuth" : "Account subscription (OAuth)"
  } else if (section === "custom") {
    statusLabel = provider.maskedKey ? `Custom · ${provider.maskedKey}` : "Custom endpoint"
  } else {
    if (provider.authType === "api_key") {
      statusLabel = provider.maskedKey ? `API key · ${provider.maskedKey}` : "API key connected"
    } else if (provider.source === "env") {
      statusLabel = provider.envKey ? `Environment (${provider.envKey})` : "Environment variable"
    } else if (provider.authType === "oauth") {
      statusLabel = "API key not set (connected via OAuth)"
    } else {
      statusLabel = "Not connected"
    }
  }

  const subtitleParts: string[] = [escapeHtml(statusLabel)]
  if (section === "custom" && provider.custom?.baseUrl) {
    subtitleParts.push(`<span class="provider-endpoint-meta">${escapeHtml(provider.custom.baseUrl)}</span>`)
  }

  const keyEditor = isEditingKey
    ? `<div class="provider-key-editor">
        <input id="provider-inline-key-${escapeAttribute(provider.id)}" class="provider-inline-key-input" type="password" placeholder="Paste ${escapeAttribute(provider.name || provider.id)} API key..." autocomplete="new-password" spellcheck="false" />
        <button type="button" class="primary-button" data-provider-save-key="${escapeAttribute(provider.id)}">Save</button>
      </div>`
    : ""

  return `<div class="settings-row provider-row${isConfiguredInSection ? " is-configured" : ""}">
    <div class="provider-row-main">
      <div class="settings-row-text">
        <div class="provider-title-line">
          <span class="settings-row-label">${escapeHtml(provider.name || provider.id)}</span>
          ${defaultBadge}
        </div>
        <span class="settings-row-desc">
          <span class="status-dot" data-configured="${isConfiguredInSection}" aria-hidden="true"></span>
          ${subtitleParts.join(" · ")}
        </span>
      </div>
      <div class="settings-row-control provider-actions">${renderSingleActionControl(provider, section)}</div>
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
  const oauthProviders = allProviders.filter(
    (p) => !p.custom && (p.methods.includes("oauth") || p.authType === "oauth"),
  )
  const customProviders = allProviders.filter((p) => Boolean(p.custom))
  const query = view.search.trim().toLowerCase()
  const builtinProviders = allProviders
    .filter((p) => !p.custom)
    .filter((p) => {
      if (!query) return true
      return (
        p.id.toLowerCase().includes(query) ||
        (p.name || "").toLowerCase().includes(query) ||
        (p.envKey || "").toLowerCase().includes(query)
      )
    })
    .sort((a, b) => {
      const aConfigured = a.configured && a.authType !== "oauth"
      const bConfigured = b.configured && b.authType !== "oauth"
      const aDefault = (state.settings.provider || "openai") === a.id && aConfigured ? 1 : 0
      const bDefault = (state.settings.provider || "openai") === b.id && bConfigured ? 1 : 0
      if (aDefault !== bDefault) return bDefault - aDefault
      if (aConfigured !== bConfigured) return aConfigured ? -1 : 1
      return (a.name || a.id).localeCompare(b.name || b.id)
    })

  const notice = view.error
    ? `<p class="settings-inline-error" role="alert">${escapeHtml(view.error)}</p>`
    : view.message
      ? `<p class="settings-inline-note">${escapeHtml(view.message)}</p>`
      : ""

  const oauthRows = oauthProviders.length
    ? oauthProviders.map((p) => renderProviderRow(p, "oauth")).join("")
    : `<p class="subtle provider-empty">No OAuth providers available.</p>`

  const customRows = customProviders.length
    ? customProviders.map((p) => renderProviderRow(p, "custom")).join("")
    : !view.customFormOpen
      ? `<p class="subtle provider-empty">No custom API endpoints configured.</p>`
      : ""

  const builtinRows = builtinProviders.length
    ? builtinProviders.map((p) => renderProviderRow(p, "builtin")).join("")
    : `<p class="subtle provider-empty">No matching built-in providers.</p>`

  settingsProviders.innerHTML = `
    ${notice}
    <div class="settings-group-card">
      <div class="settings-group-head">
        <span class="settings-group-title">OAuth &amp; Accounts</span>
        <span class="settings-group-badge">Subscription</span>
      </div>
      <div class="provider-section-rows">${oauthRows}</div>
    </div>

    <div class="settings-group-card">
      <div class="settings-group-head">
        <span class="settings-group-title">Custom APIs</span>
        <button type="button" class="secondary-button providers-add-btn" data-provider-open-custom="1">+ Add API</button>
      </div>
      ${renderCustomProviderForm()}
      <div class="provider-section-rows">${customRows}</div>
    </div>

    <div class="settings-group-card">
      <div class="settings-group-head">
        <span class="settings-group-title">Built-in Providers</span>
        <input id="providers-search-input" class="providers-compact-search" type="search" value="${escapeAttribute(view.search)}" placeholder="Search..." autocomplete="off" />
      </div>
      <div class="provider-section-rows">${builtinRows}</div>
    </div>
  `

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
  setView({ busyProviderId: providerId, openMenuId: "", error: "", message: "", oauthUrl: "" })
  try {
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
      openMenuId: "",
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
      openMenuId: "",
      customDraft: emptyCustomDraft(),
      message: `Saved custom API "${name}".`,
    })
    await loadProviders()
    await loadAvailableModels().catch(() => undefined)
    render()
  } catch (error) {
    setView({ busyProviderId: "", error: errorText(error) })
  }
}

async function deleteCustomProvider(providerId: string) {
  setView({ busyProviderId: providerId, openMenuId: "", error: "", message: "" })
  try {
    if (state.runtime.status === "ready") {
      await window.api.auth.logout(providerId).catch(() => undefined)
    }
    state.settings = await window.api.settings.save({
      deleteCustomProviderId: providerId,
    })
    setView({ busyProviderId: "", message: `Removed custom API "${providerId}".` })
    await loadProviders()
    await loadAvailableModels().catch(() => undefined)
    render()
  } catch (error) {
    setView({ busyProviderId: "", error: errorText(error) })
  }
}

async function logout(providerId: string) {
  setView({ busyProviderId: providerId, openMenuId: "", error: "", message: "" })
  try {
    if (state.runtime.status === "ready") {
      await window.api.auth.logout(providerId).catch(() => undefined)
    }
    state.settings = await window.api.settings.save({
      removeProviderCredentialId: providerId,
    })
    setView({ busyProviderId: "", message: `Disconnected ${providerId}.` })
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
    if (!target) {
      if (view.openMenuId) setView({ openMenuId: "" })
      return
    }
    if (target.disabled) return

    const menuToggleId = target.dataset.providerMenuToggle
    if (menuToggleId) {
      setView({ openMenuId: view.openMenuId === menuToggleId ? "" : menuToggleId })
      return
    }

    if (target.dataset.providerOpenCustom) {
      setView({
        customFormOpen: true,
        editingCustomId: "",
        openMenuId: "",
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
          openMenuId: "",
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
      setView({ editingKeyProviderId: nextId, openMenuId: "", error: "" })
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
