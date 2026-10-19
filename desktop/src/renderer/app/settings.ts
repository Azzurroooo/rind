import { type DesktopTheme, runtimeMethods } from "../../preload/types.ts"
import { modelSelectionTarget, normalizeModelList, stringModelOptions } from "../composer-select.ts"
import {
  requiredElement,
  saveSettingsButton,
  settingsApiKey,
  settingsBaseUrl,
  settingsDialog,
  settingsForm,
  settingsKeyStatus,
  settingsModel,
  settingsNotifications,
  settingsProvider,
  settingsReasoning,
} from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import {
  bindProviderEvents,
  getMergedProviders,
  loadProviders,
  providerStatus,
  renderProviders,
  setOnProvidersUpdated,
} from "./providers-ui.ts"
import { requestForSession, runAction, runtimeTurnActive } from "./runtime.ts"
import { applyOverview, chatProject, currentRuntimeSnapshot } from "./sessions.ts"
import { render, setTheme, shortcutRows } from "./shell.ts"
import { state } from "./state.ts"

const settingsTabs = ["general", "providers", "preferences"] as const
type SettingsTab = (typeof settingsTabs)[number]
let activeSettingsTab: SettingsTab = "general"

const TAB_HEADINGS: Record<SettingsTab, { title: string; desc: string }> = {
  general: {
    title: "General",
    desc: "Global runtime defaults (~/.rind/settings.json) and active workspace overrides.",
  },
  providers: {
    title: "Providers & Subscriptions",
    desc: "Manage OAuth subscriptions, API keys (~/.rind/auth.json), and custom endpoints (~/.rind/providers.json).",
  },
  preferences: {
    title: "Preferences",
    desc: "Appearance, desktop notifications, and keyboard shortcuts.",
  },
}

type FolderDefaultsSnapshot = {
  workspaceRoot: string
  folder: { provider_id?: string; model_id?: string; reasoning_effort?: string } | null
  resolved: { provider_id?: string; model_id?: string; reasoning_effort?: string } | null
  inherited: boolean
}

let folderDefaultsState: FolderDefaultsSnapshot | null = null
let folderDefaultsBusy = false

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
  // Provider sign-in and Preferences apply immediately; General uses Save changes.
  saveSettingsButton.hidden = activeSettingsTab !== "general"
}

export function selectSettingsTab(tab: SettingsTab, focus = false) {
  activeSettingsTab = tab
  renderSettingsTabs()
  if (tab === "providers") void loadProviders()
  if (tab === "general") {
    populateGeneralProviderControls()
    void loadWorkspaceFolderDefaults()
  }
  if (focus) settingsDialog.querySelector<HTMLButtonElement>(`[data-settings-tab="${tab}"]`)?.focus()
}

function populateGeneralProviderControls() {
  const merged = getMergedProviders()
  const currentProvider = settingsProvider.value || state.settings.provider || "openai"
  const optionsHtml: string[] = []
  const seen = new Set<string>()

  // Sort configured providers first, then alphabetical
  const sorted = [...merged].sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1
    return (a.name || a.id).localeCompare(b.name || b.id)
  })

  for (const p of sorted) {
    seen.add(p.id)
    const statusSuffix = p.configured
      ? p.authType === "oauth"
        ? " · OAuth Subscription"
        : " · Connected"
      : ""
    const selected = p.id === currentProvider ? " selected" : ""
    optionsHtml.push(
      `<option value="${escapeAttribute(p.id)}"${selected}>${escapeHtml(p.name || p.id)} (${escapeHtml(p.id)})${escapeHtml(statusSuffix)}</option>`,
    )
  }

  if (currentProvider && !seen.has(currentProvider)) {
    optionsHtml.unshift(
      `<option value="${escapeAttribute(currentProvider)}" selected>${escapeHtml(currentProvider)}</option>`,
    )
  }

  settingsProvider.innerHTML = optionsHtml.join("")
  settingsProvider.value = currentProvider
  updateProviderKeyStatus()
  populateModelDatalist(currentProvider)
}

function populateModelDatalist(providerId: string) {
  const datalist = document.getElementById("settings-model-datalist")
  if (!datalist) return
  const modelIds = new Set<string>()

  for (const m of state.models) {
    if (!m.providerId || m.providerId === providerId) {
      if (m.id) modelIds.add(m.id)
    }
  }
  const custom = (state.settings.customProviders || []).find((c) => c.id === providerId)
  if (custom) {
    for (const m of custom.models) modelIds.add(m)
  }
  for (const m of state.models) {
    if (m.id) modelIds.add(m.id)
  }
  if (state.settings.model) modelIds.add(state.settings.model)

  datalist.innerHTML = [...modelIds]
    .slice(0, 60)
    .map((id) => `<option value="${escapeAttribute(id)}"></option>`)
    .join("")
}

function updateProviderKeyStatus() {
  const selectedId = settingsProvider.value || state.settings.provider || "openai"
  const merged = getMergedProviders()
  const found = merged.find((p) => p.id === selectedId)
  if (found && found.configured) {
    settingsKeyStatus.textContent = `${found.name || found.id}: ${providerStatus(found)}`
    settingsKeyStatus.dataset.configured = "true"
  } else if (state.settings.hasApiKey) {
    settingsKeyStatus.textContent = `No stored key for ${selectedId} yet. Enter a key or configure in Providers.`
    settingsKeyStatus.dataset.configured = "false"
  } else {
    settingsKeyStatus.textContent = "No provider credentials configured yet."
    settingsKeyStatus.dataset.configured = "false"
  }
}

async function loadWorkspaceFolderDefaults() {
  const workspaceRoot = chatProject()?.path || state.chatProjectPath || ""
  if (!workspaceRoot || state.runtime.status !== "ready") {
    folderDefaultsState = null
    renderWorkspaceFolderDefaults()
    return
  }
  try {
    const res = (await window.api.runtime.request(runtimeMethods.folderDefaultsGet, {
      workspace_root: workspaceRoot,
    })) as Record<string, unknown> | null
    if (res && typeof res === "object") {
      folderDefaultsState = {
        workspaceRoot,
        folder: (res.folder as FolderDefaultsSnapshot["folder"]) || null,
        resolved: (res.resolved as FolderDefaultsSnapshot["resolved"]) || null,
        inherited: res.inherited !== false && !res.folder,
      }
    }
  } catch {
    folderDefaultsState = null
  }
  renderWorkspaceFolderDefaults()
}

function renderWorkspaceFolderDefaults() {
  const container = document.getElementById("settings-workspace-defaults")
  if (!container) return
  const workspaceRoot = chatProject()?.path || state.chatProjectPath || ""
  if (!workspaceRoot) {
    container.hidden = true
    container.innerHTML = ""
    return
  }
  container.hidden = false
  const folderName = workspaceRoot.replace(/\\/g, "/").split("/").filter(Boolean).pop() || workspaceRoot
  const hasOverride = Boolean(
    folderDefaultsState?.folder &&
      (folderDefaultsState.folder.provider_id ||
        folderDefaultsState.folder.model_id ||
        folderDefaultsState.folder.reasoning_effort),
  )
  const overrideSummary = hasOverride
    ? [
        folderDefaultsState?.folder?.provider_id,
        folderDefaultsState?.folder?.model_id,
        folderDefaultsState?.folder?.reasoning_effort
          ? `effort: ${folderDefaultsState.folder.reasoning_effort}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "Inheriting global defaults from ~/.rind/settings.json"

  const disabledAttr = state.runtime.status !== "ready" || folderDefaultsBusy ? " disabled" : ""

  container.innerHTML = `
    <div class="settings-group-head">
      <span class="settings-group-title">Workspace Override · ${escapeHtml(folderName)}</span>
      <span class="settings-group-badge">${hasOverride ? "Custom override" : "Inherited"}</span>
    </div>
    <div class="settings-row">
      <div class="settings-row-text">
        <span class="settings-row-label">${escapeHtml(overrideSummary)}</span>
        <span class="settings-row-desc">${escapeHtml(workspaceRoot)}</span>
      </div>
      <div class="settings-row-control provider-actions">
        <button type="button" class="secondary-button" data-folder-default-action="pin"${disabledAttr}>Pin form values to workspace</button>
        ${hasOverride ? `<button type="button" class="ghost-button" data-folder-default-action="reset"${disabledAttr}>Reset to global</button>` : ""}
      </div>
    </div>
  `
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
  updateProviderKeyStatus()
  saveSettingsButton.disabled = state.settingsSaving
  saveSettingsButton.textContent = state.settingsSaving ? "Saving..." : "Save changes"
  renderPreferencesControls()
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
    const listing = normalizeModelList(
      await (sessionId
        ? requestForSession(runtimeMethods.modelList, sessionId)
        : window.api.runtime.request(runtimeMethods.modelList, {})),
    )
    if (sessionId !== state.viewedSessionId || workspace !== state.chatProjectPath) return
    state.models = listing.models
    if (state.settingsOpen) populateModelDatalist(settingsProvider.value || state.settings.provider || "openai")
    // Catalog refresh must not overwrite a new-session draft selection.
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
  void loadProviders().then(() => {
    populateGeneralProviderControls()
  })
  settingsProvider.value = state.settings.provider || "openai"
  settingsApiKey.value = ""
  settingsBaseUrl.value = state.settings.baseUrl || ""
  settingsModel.value = state.settings.model || ""
  settingsReasoning.value = state.settings.reasoningEffort || ""
  populateGeneralProviderControls()
  renderProviders()
  void loadWorkspaceFolderDefaults()
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
  const apiKey = settingsApiKey.value.trim()

  state.settingsSaving = true
  state.notice = "Saving settings..."
  render()
  try {
    state.settings = await window.api.settings.save({
      provider,
      model,
      reasoningEffort,
      ...(apiKey ? { providerCredential: { providerId: provider, apiKey } } : {}),
    })

    // Sync global defaults with running runtime if ready
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

    settingsApiKey.value = ""
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
    if (state.settingsOpen) populateGeneralProviderControls()
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
    updateProviderKeyStatus()
    populateModelDatalist(settingsProvider.value)
  })

  document.getElementById("settings-go-providers")?.addEventListener("click", () => {
    selectSettingsTab("providers", true)
  })

  document.getElementById("settings-workspace-defaults")?.addEventListener("click", (event) => {
    const btn = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-folder-default-action]") : null
    if (!btn || btn.disabled) return
    const action = btn.dataset.folderDefaultAction
    const workspaceRoot = chatProject()?.path || state.chatProjectPath || ""
    if (!workspaceRoot || state.runtime.status !== "ready") return
    folderDefaultsBusy = true
    renderWorkspaceFolderDefaults()
    void (async () => {
      try {
        if (action === "pin") {
          const provider = settingsProvider.value.trim() || state.settings.provider || "openai"
          const model = settingsModel.value.trim() || state.settings.model || "gpt-4o-mini"
          const effort = settingsReasoning.value.trim()
          await window.api.runtime.request(runtimeMethods.folderDefaultsSet, {
            scope: "folder",
            workspace_root: workspaceRoot,
            provider_id: provider,
            model_id: model,
            reasoning_effort: effort,
          })
          state.notice = "Pinned model defaults to current workspace."
        } else if (action === "reset") {
          await window.api.runtime.request(runtimeMethods.folderDefaultsUnset, {
            workspace_root: workspaceRoot,
          })
          state.notice = "Reset workspace defaults to global settings."
        }
        await loadWorkspaceFolderDefaults()
      } catch (error) {
        state.notice = error instanceof Error ? error.message : String(error)
      } finally {
        folderDefaultsBusy = false
        renderWorkspaceFolderDefaults()
        render()
      }
    })()
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
