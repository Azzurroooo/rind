import { type DesktopTheme, runtimeMethods } from "../../preload/types.ts"
import { modelSelectionTarget, normalizeModelList, stringModelOptions } from "../composer-select.ts"
import {
  requiredElement,
  saveSettingsButton,
  settingsDialog,
  settingsForm,
  settingsModel,
  settingsNotifications,
  settingsProvider,
  settingsReasoning,
} from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import {
  bindProviderEvents,
  getMergedProviders,
  getModelReasoningEfforts,
  getProviderModels,
  loadProviders,
  renderProviders,
  setOnProvidersUpdated,
} from "./providers-ui.ts"
import { requestForSession, runAction, runtimeTurnActive } from "./runtime.ts"
import { applyOverview, currentRuntimeSnapshot } from "./sessions.ts"
import { render, setTheme, shortcutRows } from "./shell.ts"
import { state } from "./state.ts"

const settingsTabs = ["general", "providers", "preferences"] as const
type SettingsTab = (typeof settingsTabs)[number]
let activeSettingsTab: SettingsTab = "general"

const TAB_HEADINGS: Record<SettingsTab, { title: string; desc: string }> = {
  general: {
    title: "General",
    desc: "Default provider and model for new conversations (~/.rind/settings.json).",
  },
  providers: {
    title: "Providers",
    desc: "Manage custom API endpoints (~/.rind/providers.json) and built-in provider credentials (~/.rind/auth.json).",
  },
  preferences: {
    title: "Preferences",
    desc: "Appearance, desktop notifications, and keyboard shortcuts.",
  },
}

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
}

function isSettingsTab(value: unknown): value is SettingsTab {
  return settingsTabs.includes(value as SettingsTab)
}

function renderSettingsTabs() {
  for (const button of settingsDialog.querySelectorAll<HTMLButtonElement>("[data-settings-tab]")) {
    const selected = button.dataset.settingsTab === activeSettingsTab
    button.setAttribute("aria-selected", String(selected))
    button.tabIndex = selected ? 0 : -1
  }
  for (const panel of settingsDialog.querySelectorAll<HTMLElement>("[data-settings-panel]")) {
    panel.hidden = panel.dataset.settingsPanel !== activeSettingsTab
  }
  const heading = TAB_HEADINGS[activeSettingsTab]
  const titleEl = document.getElementById("settings-active-title")
  const descEl = document.getElementById("settings-active-desc")
  if (titleEl) titleEl.textContent = heading.title
  if (descEl) descEl.textContent = heading.desc
  const hasConfigured = getMergedProviders().some((p) => p.configured)
  saveSettingsButton.hidden = activeSettingsTab !== "general" || !hasConfigured
}

export function selectSettingsTab(tab: SettingsTab, focus = false) {
  activeSettingsTab = tab
  renderSettingsTabs()
  if (tab === "providers") void loadProviders()
  if (tab === "general") populateGeneralControls()
  if (focus) settingsDialog.querySelector<HTMLButtonElement>(`[data-settings-tab="${tab}"]`)?.focus()
}

function populateGeneralControls(preferredProvider?: string, preferredModel?: string, preferredEffort?: string) {
  const configured = getMergedProviders()
    .filter((p) => p.configured)
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))

  const emptyEl = document.getElementById("settings-general-empty")
  const cardEl = document.getElementById("settings-general-card")

  if (configured.length === 0) {
    if (emptyEl) emptyEl.hidden = false
    if (cardEl) cardEl.hidden = true
    saveSettingsButton.hidden = true
    return
  }

  if (emptyEl) emptyEl.hidden = true
  if (cardEl) cardEl.hidden = false
  if (activeSettingsTab === "general") saveSettingsButton.hidden = false

  const desiredProvider = preferredProvider ?? settingsProvider.value ?? state.settings.provider ?? ""
  const activeProvider = configured.some((p) => p.id === desiredProvider)
    ? desiredProvider
    : configured[0].id

  settingsProvider.innerHTML = configured
    .map((p) => {
      const selected = p.id === activeProvider ? " selected" : ""
      return `<option value="${escapeAttribute(p.id)}"${selected}>${escapeHtml(p.name || p.id)}</option>`
    })
    .join("")
  settingsProvider.value = activeProvider

  populateModelSelect(activeProvider, preferredModel ?? settingsModel.value ?? state.settings.model)
  populateReasoningSelect(
    activeProvider,
    settingsModel.value,
    preferredEffort ?? settingsReasoning.value ?? state.settings.reasoningEffort,
  )
}

function populateModelSelect(providerId: string, preferredModel = "") {
  const models = getProviderModels(providerId)
  const activeModel = models.includes(preferredModel)
    ? preferredModel
    : models[0] || preferredModel || ""

  const optionIds = models.length > 0 ? models : activeModel ? [activeModel] : []
  settingsModel.innerHTML = optionIds
    .map((id) => {
      const selected = id === activeModel ? " selected" : ""
      return `<option value="${escapeAttribute(id)}"${selected}>${escapeHtml(id)}</option>`
    })
    .join("")
  settingsModel.value = activeModel
}

function populateReasoningSelect(providerId: string, modelId: string, preferredEffort = "") {
  const row = document.getElementById("settings-reasoning-row")
  const efforts = getModelReasoningEfforts(providerId, modelId)
  if (!efforts || efforts.length === 0) {
    if (row) row.hidden = true
    settingsReasoning.innerHTML = `<option value="" selected>Default</option>`
    settingsReasoning.value = ""
    return
  }

  if (row) row.hidden = false
  const activeEffort = efforts.includes(preferredEffort) ? preferredEffort : ""
  const optionsHtml = [
    `<option value=""${activeEffort === "" ? " selected" : ""}>Default</option>`,
    ...efforts.map((effort) => {
      const selected = effort === activeEffort ? " selected" : ""
      const label = EFFORT_LABELS[effort] || effort
      return `<option value="${escapeAttribute(effort)}"${selected}>${escapeHtml(label)}</option>`
    }),
  ]
  settingsReasoning.innerHTML = optionsHtml.join("")
  settingsReasoning.value = activeEffort
}

function renderPreferencesControls() {
  const themeGroup = document.getElementById("settings-theme-group")
  if (themeGroup) {
    for (const btn of themeGroup.querySelectorAll<HTMLButtonElement>("[data-theme-option]")) {
      const active = btn.dataset.themeOption === state.theme
      btn.setAttribute("aria-checked", String(active))
      btn.classList.toggle("is-active", active)
    }
  }
  settingsNotifications.checked = state.notificationsEnabled

  const shortcutsList = document.getElementById("settings-shortcuts-list")
  if (shortcutsList && !shortcutsList.dataset.rendered) {
    shortcutsList.dataset.rendered = "1"
    shortcutsList.innerHTML = shortcutRows
      .map(
        ([combo, label]) =>
          `<div class="shortcut-row"><span>${escapeHtml(label)}</span><code>${escapeHtml(combo)}</code></div>`,
      )
      .join("")
  }
}

export function renderSettings() {
  if (state.settingsOpen && !settingsDialog.open) settingsDialog.showModal()
  if (!state.settingsOpen && settingsDialog.open) settingsDialog.close()
  saveSettingsButton.disabled = state.settingsSaving
  saveSettingsButton.textContent = state.settingsSaving ? "Saving..." : "Save changes"
  renderPreferencesControls()
  renderSettingsTabs()
}

export async function loadAvailableModels() {
  const target = modelSelectionTarget(currentRuntimeSnapshot().status, runtimeTurnActive())
  if (target === "runtime") {
    const sessionId = state.viewedSessionId
    const workspace = state.chatProjectPath
    const listing = normalizeModelList(
      await (sessionId
        ? requestForSession(runtimeMethods.modelList, sessionId)
        : window.api.runtime.request(runtimeMethods.modelList, {})),
    )
    if (sessionId !== state.viewedSessionId || workspace !== state.chatProjectPath) return
    state.models = listing.models
    if (state.settingsOpen) populateGeneralControls()
    if (!sessionId) {
      if (!state.modelProvider && state.model === listing.currentModelId) {
        state.modelProvider = listing.currentProviderId
      }
      return
    }
    if (listing.currentProviderId) state.modelProvider = listing.currentProviderId
    if (listing.currentModelId && listing.currentModelId !== state.model) {
      state.model = listing.currentModelId
      state.sessionModels = { ...state.sessionModels, [sessionId]: listing.currentModelId }
    }
    return
  }
  state.models = stringModelOptions(await window.api.models.list())
}

export async function loadSettings() {
  try {
    state.settings = await window.api.settings.get()
    if (!state.model && state.settings.model) state.model = state.settings.model
    if (!state.modelProvider && state.settings.provider) state.modelProvider = state.settings.provider
    if (!state.effort && state.settings.reasoningEffort) state.effort = state.settings.reasoningEffort
    render()
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
    render()
  }
}

export function openSettings(tab: SettingsTab = "general") {
  state.settingsOpen = true
  activeSettingsTab = tab
  const initialProvider = state.settings.provider || "openai"
  const initialModel = state.settings.model || "gpt-4o-mini"
  const initialEffort = state.settings.reasoningEffort || ""
  populateGeneralControls(initialProvider, initialModel, initialEffort)
  void loadProviders().then(() => {
    populateGeneralControls(state.settings.provider, state.settings.model, state.settings.reasoningEffort)
  })
  renderProviders()
  render()
}

export async function saveSettings() {
  if (activeSettingsTab !== "general") {
    state.settingsOpen = false
    render()
    return
  }
  const provider = settingsProvider.value.trim() || state.settings.provider || "openai"
  const model = settingsModel.value.trim() || state.settings.model || "gpt-4o-mini"
  const reasoningEffort = settingsReasoning.value.trim()

  state.settingsSaving = true
  state.notice = "Saving settings..."
  render()
  try {
    state.settings = await window.api.settings.save({
      provider,
      model,
      reasoningEffort,
    })

    if (state.runtime.status === "ready") {
      await window.api.runtime
        .request(runtimeMethods.folderDefaultsSet, {
          scope: "global",
          provider_id: provider,
          model_id: model,
          reasoning_effort: reasoningEffort,
        })
        .catch(() => undefined)
      await loadAvailableModels().catch(() => undefined)
    }

    if (!state.viewedSessionId) {
      state.modelProvider = provider
      state.model = model
      state.effort = reasoningEffort
    }

    state.settingsOpen = false
    state.settingsAutoOpened = true
    state.notice = `Saved global defaults (${provider} / ${model}).`
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    state.settingsSaving = false
    render()
  }
}

export function bindSettingsEvents(): void {
  setOnProvidersUpdated(() => {
    if (state.settingsOpen) populateGeneralControls()
  })

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault()
    runAction(saveSettings)
  })

  requiredElement("close-settings").addEventListener("click", () => {
    state.settingsOpen = false
    render()
  })

  requiredElement("cancel-settings").addEventListener("click", () => {
    state.settingsOpen = false
    render()
  })

  settingsDialog.addEventListener("cancel", () => {
    state.settingsOpen = false
    render()
  })

  settingsProvider.addEventListener("change", () => {
    const providerId = settingsProvider.value
    populateModelSelect(providerId, "")
    populateReasoningSelect(providerId, settingsModel.value, "")
  })

  settingsModel.addEventListener("change", () => {
    populateReasoningSelect(settingsProvider.value, settingsModel.value, settingsReasoning.value)
  })

  document.getElementById("settings-go-providers")?.addEventListener("click", () => {
    selectSettingsTab("providers", true)
  })

  document.getElementById("settings-theme-group")?.addEventListener("click", (event) => {
    const btn = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-theme-option]") : null
    const theme = btn?.dataset.themeOption as DesktopTheme | undefined
    if (theme) {
      setTheme(theme)
      renderPreferencesControls()
    }
  })

  settingsNotifications.addEventListener("change", () => {
    const enabled = settingsNotifications.checked
    state.notificationsEnabled = enabled
    runAction(async () => {
      applyOverview(await window.api.prefs.update({ notificationsEnabled: enabled }))
      render()
    })
  })

  const tablist = settingsDialog.querySelector<HTMLElement>("[role=tablist]")
  tablist?.addEventListener("click", (event) => {
    const tab =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-settings-tab]")?.dataset.settingsTab
        : undefined
    if (isSettingsTab(tab)) selectSettingsTab(tab)
  })
  tablist?.addEventListener("keydown", (event) => {
    const offset = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
    if (!offset) return
    event.preventDefault()
    const index = settingsTabs.indexOf(activeSettingsTab)
    selectSettingsTab(settingsTabs[(index + offset + settingsTabs.length) % settingsTabs.length], true)
  })
  bindProviderEvents()
}
