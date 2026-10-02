import { requiredElement, saveSettingsButton, settingsApiKey, settingsBaseUrl, settingsDialog, settingsForm, settingsKeyStatus, settingsModel, settingsNotifications, settingsReasoning } from "./dom.ts"
import { bindProviderEvents, loadProviders, renderProviders } from "./providers-ui.ts"
import { modelSelectionTarget, normalizeModelList, stringModelOptions } from "../composer-select.ts"
import { requestForSession, runAction, runtimeTurnActive } from "./runtime.ts"
import { currentRuntimeSnapshot } from "./sessions.ts"
import { runtimeMethods } from "../../preload/types.ts"
import { render } from "./shell.ts"
import { state } from "./state.ts"

const settingsTabs = ["general", "providers", "preferences"] as const
type SettingsTab = typeof settingsTabs[number]
let activeSettingsTab: SettingsTab = "general"

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
  // Provider sign-in applies immediately; only the other sections need Save.
  saveSettingsButton.hidden = activeSettingsTab === "providers"
}

export function selectSettingsTab(tab: SettingsTab, focus = false) {
  activeSettingsTab = tab
  renderSettingsTabs()
  if (tab === "providers") void loadProviders()
  if (focus) settingsDialog.querySelector<HTMLButtonElement>(`[data-settings-tab="${tab}"]`)?.focus()
}

export function renderSettings() {
  if (state.settingsOpen && !settingsDialog.open) settingsDialog.showModal()
  if (!state.settingsOpen && settingsDialog.open) settingsDialog.close()
  settingsKeyStatus.textContent = state.settings.hasApiKey ? "An API key is available." : "No API key is configured."
  saveSettingsButton.disabled = state.settingsSaving
  saveSettingsButton.textContent = state.settingsSaving ? "Saving..." : "Save"
  settingsNotifications.checked = state.notificationsEnabled
  renderSettingsTabs()
}

// The runtime target reads model/list (provider-aware, all signed-in
// providers); the settings target falls back to the main-process catalog
// fetch of the configured OpenAI-compatible endpoint.
export async function loadAvailableModels() {
  const target = modelSelectionTarget(currentRuntimeSnapshot().status, runtimeTurnActive())
  if (target === "runtime") {
    const sessionId = state.viewedSessionId
    const workspace = state.chatProjectPath
    const listing = normalizeModelList(await (sessionId
      ? requestForSession(runtimeMethods.modelList, sessionId)
      : window.api.runtime.request(runtimeMethods.modelList, {})))
    if (sessionId !== state.viewedSessionId || workspace !== state.chatProjectPath) return
    state.models = listing.models
    // Catalog refresh must not overwrite a new-session draft selection.
    if (!sessionId) {
      if (!state.modelProvider && state.model === listing.currentModelId) state.modelProvider = listing.currentProviderId
      return
    }
    if (listing.currentProviderId) state.modelProvider = listing.currentProviderId
    if (listing.currentModelId && listing.currentModelId !== state.model) {
      state.model = listing.currentModelId
      state.sessionModels = { ...state.sessionModels, [sessionId]: listing.currentModelId }
    }
    return
  }
  state.models = stringModelOptions(await window.api.models.list(state.chatProjectPath || state.fallbackProjectPath))
}

export async function loadSettings() {
  try {
    state.settings = await window.api.settings.get(state.chatProjectPath || state.fallbackProjectPath)
    if (!state.model) state.model = state.settings.model
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

export function openSettings(tab: SettingsTab = "general") {
  state.settingsOpen = true
  activeSettingsTab = tab
  renderProviders()
  if (tab === "providers") void loadProviders()
  settingsApiKey.value = ""
  settingsBaseUrl.value = state.settings.baseUrl
  settingsModel.value = state.settings.model
  settingsReasoning.value = state.settings.reasoningEffort
  render()
}

export async function saveSettings() {
  const apiKey = settingsApiKey.value.trim()
  if (!state.settings.hasApiKey && !apiKey) {
    state.notice = "Enter an API key to start the runtime."
    render()
    settingsApiKey.focus()
    return
  }
  state.settingsSaving = true
  state.notice = "Saving settings..."
  render()
  try {
    const runtimeConfigChanged = Boolean(apiKey)
      || settingsBaseUrl.value.trim() !== state.settings.baseUrl
      || settingsModel.value.trim() !== state.settings.model
      || settingsReasoning.value.trim() !== state.settings.reasoningEffort
    const hasRunningRuntime = state.runtime.status === "starting" || state.runtime.status === "ready"
    state.settings = await window.api.settings.save({
      ...(apiKey ? { apiKey } : {}),
      model: settingsModel.value.trim(),
      baseUrl: settingsBaseUrl.value.trim(),
      reasoningEffort: settingsReasoning.value.trim(),
    }, state.chatProjectPath || state.fallbackProjectPath)
    state.settingsOpen = false
    state.settingsAutoOpened = true
    state.notice = runtimeConfigChanged && hasRunningRuntime
      ? "Settings saved. Existing runtimes keep their current configuration until they restart."
      : "Settings saved."
  } catch (error) {
    state.notice = error instanceof Error ? error.message : String(error)
  } finally {
    state.settingsSaving = false
    render()
  }
}

export function bindSettingsEvents(): void {
  settingsForm.addEventListener("submit", (event) => { event.preventDefault(); runAction(saveSettings) })

  requiredElement("close-settings").addEventListener("click", () => { state.settingsOpen = false; render() })

  requiredElement("cancel-settings").addEventListener("click", () => { state.settingsOpen = false; render() })

  settingsDialog.addEventListener("cancel", () => { state.settingsOpen = false; render() })

  const tablist = settingsDialog.querySelector<HTMLElement>("[role=tablist]")
  tablist?.addEventListener("click", (event) => {
    const tab = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-settings-tab]")?.dataset.settingsTab : undefined
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
