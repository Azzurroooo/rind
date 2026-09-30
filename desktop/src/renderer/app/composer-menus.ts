import { runtimeMethods } from "../../preload/types.ts"
import { findModelOption, formatContextWindow, groupModelOptions, modelChoices, modelSelectionTarget, type ModelOption } from "../composer-select.ts"
import { sameProjectPath as samePath, workingDirectorySelectionEnabled } from "../project-selection.ts"
import { closeSlashCommandMenu } from "./composer.ts"
import { effortMenu, effortMenuLabel, effortMenuTrigger, modelMenu, modelMenuLabel, modelMenuTrigger, projectMenu, projectMenuLabel, projectMenuTrigger } from "./dom.ts"
import { asRecord, asRecordText, escapeAttribute, escapeHtml } from "./html.ts"
import { requestForSession, runtimeTurnActive } from "./runtime.ts"
import { chatProject, currentRuntimeSnapshot } from "./sessions.ts"
import { loadAvailableModels } from "./settings.ts"
import { Check, Eye, Search, renderIcon } from "../icons.ts"
import { render } from "./shell.ts"
import { sessionCompacting, state, vars } from "./state.ts"

let modelQuery = ""
const menuMarkup = new WeakMap<HTMLElement, string>()
function updateMenu(menu: HTMLElement, markup: string) {
  if (menuMarkup.get(menu) === markup) return
  const focused = menu.contains(document.activeElement) ? document.activeElement as HTMLElement : null
  const choice = focused?.getAttribute("data-model-choice") || focused?.getAttribute("data-effort-choice")
  const provider = focused?.getAttribute("data-model-provider")
  const scrollTop = menu.scrollTop
  menu.innerHTML = markup
  menuMarkup.set(menu, markup)
  menu.scrollTop = scrollTop
  if (choice) [...menu.querySelectorAll<HTMLElement>("[role=option]")].find((row) => (row.dataset.modelChoice || row.dataset.effortChoice) === choice && (!provider || row.dataset.modelProvider === provider))?.focus({ preventScroll: true })
}

modelMenu.addEventListener("input", (event) => {
  if (!(event.target instanceof HTMLInputElement)) return
  modelQuery = event.target.value
  renderModels()
})



export function renderProjectControl() {
  const active = chatProject()
  const canOpen = workingDirectorySelectionEnabled(state.projects.length, state.viewedSessionId)
  if (!canOpen) state.projectMenuOpen = false
  projectMenuLabel.textContent = active?.path || "Working folder"
  projectMenuTrigger.title = state.viewedSessionId
    ? `Session working directory: ${active?.path || "Unavailable"}`
    : active?.path || "Choose working directory"
  projectMenuTrigger.disabled = !canOpen
  projectMenuTrigger.setAttribute("aria-expanded", String(state.projectMenuOpen))
  projectMenu.hidden = !state.projectMenuOpen
  if (!state.projectMenuOpen) {
    projectMenu.replaceChildren()
    return
  }
  if (!state.projects.length) {
    projectMenu.innerHTML = `<p class="composer-select-empty">No working directories</p>`
    return
  }
  projectMenu.innerHTML = state.projects.map((project) => {
    const selected = samePath(project.path, state.chatProjectPath)
    return `<button type="button" class="composer-select-option${selected ? " selected" : ""}" role="option" aria-selected="${String(selected)}" data-project-choice="${escapeAttribute(project.path)}"${project.available ? "" : " disabled"}><span class="composer-select-option-main">${escapeHtml(project.name)}</span><span class="composer-select-option-detail">${escapeHtml(project.available ? project.path : "Folder is unavailable")}</span></button>`
  }).join("")
}

// Provider-grouped listbox rows (after Jan's provider groups and LobeHub's
// model panel). The runtime target groups by provider and shows the context
// window; the settings target stays a flat id list.
export function renderModels() {
  const activeModel = displayedModel()
  const choices = modelChoices(state.models, activeModel, state.modelProvider)
  const canOpen = canOpenModelMenu()
  if (!canOpen) closeModelMenu()
  modelMenuLabel.textContent = activeModel || (state.modelMenuLoading ? "Loading models..." : "Model")
  modelMenuTrigger.title = activeModel ? `Choose model: ${activeModel}` : "Choose model"
  modelMenuTrigger.setAttribute("aria-label", `Model: ${activeModel || "not set"}`)
  modelMenuTrigger.disabled = !canOpen
  modelMenuTrigger.setAttribute("aria-expanded", String(state.modelMenuOpen))
  modelMenuTrigger.setAttribute("aria-busy", String(state.modelMenuLoading || state.modelChanging))
  modelMenu.hidden = !state.modelMenuOpen
  if (!state.modelMenuOpen) {
    modelMenu.replaceChildren()
    menuMarkup.delete(modelMenu)
    return
  }
  if (state.modelMenuLoading) {
    updateMenu(modelMenu, `<p class="composer-select-empty">Loading models...</p>`)
    return
  }
  if (!choices.length) {
    updateMenu(modelMenu, `<p class="composer-select-empty">No models available. Sign in to a provider in Settings.</p>`)
    return
  }
  const grouped = modelSelectionTargetForState() === "runtime"
  const option = (model: ModelOption) => {
    const selected = model.id === activeModel && (model.providerId || "") === (state.modelProvider || "")
    const context = grouped ? formatContextWindow(model.contextWindow) : ""
    return `<button type="button" class="composer-select-option composer-model-option${selected ? " selected" : ""}" role="option" aria-selected="${String(selected)}" title="${escapeAttribute(model.id)}" data-model-choice="${escapeAttribute(model.id)}" data-model-provider="${escapeAttribute(model.providerId)}"${state.modelChanging ? " disabled" : ""}><span class="model-option-check">${selected ? renderIcon(Check) : ""}</span><span class="composer-select-option-main">${escapeHtml(model.id)}</span>${model.imageInput ? `<span role="img" aria-label="Supports images" class="model-option-vision">${renderIcon(Eye)}</span>` : ""}${context ? `<span class="composer-select-option-detail">${escapeHtml(context)}</span>` : ""}</button>`
  }
  const filtered = choices.filter((model) => `${model.id} ${model.providerId} ${state.providerNames[model.providerId] || ""}`.toLowerCase().includes(modelQuery.trim().toLowerCase()))
  // Keep the search input mounted while results change or stream events render.
  if (!modelMenu.querySelector(".model-picker-list")) {
    modelMenu.innerHTML = `${choices.length > 8 ? `<label class="model-search">${renderIcon(Search)}<input type="search" aria-label="Filter models" placeholder="Filter models" /></label>` : ""}<div class="model-picker-list"></div>`
  }
  const list = modelMenu.querySelector<HTMLElement>(".model-picker-list")!
  const markup = groupModelOptions(filtered, state.providerNames).map((group) => `
    <div class="composer-select-group" role="group" aria-label="${escapeAttribute(group.name)}">
      <div class="composer-select-group-title">${escapeHtml(group.name)}<span class="composer-select-group-count">${group.models.length}</span></div>
      ${group.models.map(option).join("")}
    </div>
  `).join("") || `<p class="composer-select-empty">No models match.</p>`
  updateMenu(list, markup)
}

export function displayedModel() {
  if (state.viewedSessionId) return state.model
  return currentRuntimeSnapshot().status === "ready" ? state.model || state.settings.model : state.settings.model
}

export function canOpenModelMenu() {
  const target = modelSelectionTargetForState()
  return Boolean(state.settings.hasApiKey && target !== "unavailable" && !state.modelChanging && !sessionCompacting())
}

export function modelSelectionTargetForState() {
  if (!state.viewedSessionId) return "settings" as const
  return modelSelectionTarget(currentRuntimeSnapshot().status, runtimeTurnActive())
}

export function closeModelMenu() {
  if (state.modelMenuOpen || state.modelMenuLoading) vars.modelMenuRequestId += 1
  state.modelMenuOpen = false
  state.modelMenuLoading = false
  modelQuery = ""
}

export function closeComposerSelectMenus() {
  closeModelMenu()
  state.effortMenuOpen = false
  state.projectMenuOpen = false
}

export async function toggleModelMenu() {
  if (!canOpenModelMenu()) return
  if (state.modelMenuOpen) {
    closeModelMenu()
    render()
    return
  }
  const requestId = ++vars.modelMenuRequestId
  state.modelMenuOpen = true
  state.modelMenuLoading = true
  state.projectMenuOpen = false
  state.effortMenuOpen = false
  state.composerMenuOpen = false
  closeSlashCommandMenu()
  render()
  try {
    await loadAvailableModels()
    if (!isCurrentModelMenuRequest(requestId)) return
  } catch (error) {
    if (requestId !== vars.modelMenuRequestId) return
    state.notice = error instanceof Error ? error.message : String(error)
    state.modelMenuOpen = false
  } finally {
    if (requestId === vars.modelMenuRequestId) {
      state.modelMenuLoading = false
      render()
      if (state.modelMenuOpen) (modelMenu.querySelector<HTMLElement>("input") || modelMenu.querySelector<HTMLElement>('[aria-selected="true"]') || modelMenu.querySelector<HTMLElement>("[role=option]"))?.focus()
    }
  }
}

export function isCurrentModelMenuRequest(requestId: number) {
  return requestId === vars.modelMenuRequestId && state.modelMenuOpen
}

// Accepts the menu's ModelOption or a plain model name, which resolves
// against the loaded options so provider_id rides along.
export async function selectModel(selection: ModelOption | string) {
  const option = typeof selection === "string" ? findModelOption(state.models, selection) : selection
  const model = option ? option.id : String(selection || "")
  const providerId = option?.providerId || ""
  if (!model || (model === displayedModel() && (!providerId || providerId === state.modelProvider)) || state.modelChanging) {
    closeModelMenu()
    render()
    return
  }
  const target = modelSelectionTargetForState()
  if (target === "unavailable") return
  const sessionId = state.viewedSessionId
  state.modelChanging = true
  render()
  try {
    if (target === "runtime") {
      const result = asRecord(await requestForSession(runtimeMethods.modelSet, sessionId, {
        model_id: model,
        ...(providerId ? { provider_id: providerId } : {}),
      }))
      if (state.viewedSessionId === sessionId) {
        state.model = asRecordText(result.model) || model
        state.modelProvider = asRecordText(result.provider_id) || providerId
        state.sessionModels = { ...state.sessionModels, [sessionId]: state.model }
      }
    } else {
      state.settings = await window.api.settings.save({ model })
      if (!state.viewedSessionId) state.model = model
    }
    state.models = modelChoices(state.models, displayedModel(), state.modelProvider)
    closeModelMenu()
  } finally {
    state.modelChanging = false
    render()
  }
}

export function toggleProjectMenu() {
  if (!workingDirectorySelectionEnabled(state.projects.length, state.viewedSessionId)) {
    state.projectMenuOpen = false
    render()
    return
  }
  state.projectMenuOpen = !state.projectMenuOpen
  closeModelMenu()
  state.effortMenuOpen = false
  state.composerMenuOpen = false
  closeSlashCommandMenu()
  render()
}

// ---------- reasoning effort switcher (B1) ----------

// Mirrors the kernel's REASONING_EFFORTS (agent/infrastructure/settings.py).
export const reasoningEfforts = ["low", "medium", "high", "xhigh", "max"] as const

export function displayedEffort() {
  if (state.viewedSessionId && state.sessionEfforts[state.viewedSessionId]) return state.sessionEfforts[state.viewedSessionId]
  return state.effort || state.settings.reasoningEffort || ""
}

export function canOpenEffortMenu() {
  return Boolean(state.viewedSessionId && currentRuntimeSnapshot().status === "ready" && !state.effortChanging && !runtimeTurnActive() && !sessionCompacting())
}

const effortLabels: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" }

export function renderEffortMenu() {
  const activeEffort = displayedEffort()
  const canOpen = canOpenEffortMenu()
  if (!canOpen) state.effortMenuOpen = false
  effortMenuLabel.textContent = effortLabels[activeEffort] || "Effort"
  effortMenuTrigger.setAttribute("aria-label", `Reasoning effort: ${activeEffort || "default"}`)
  effortMenuTrigger.title = activeEffort
    ? `Reasoning effort: ${activeEffort}`
    : state.viewedSessionId ? "Choose reasoning effort" : "Start a session to change reasoning effort"
  effortMenuTrigger.disabled = !canOpen
  effortMenuTrigger.setAttribute("aria-expanded", String(state.effortMenuOpen))
  effortMenuTrigger.setAttribute("aria-busy", String(state.effortChanging))
  effortMenu.hidden = !state.effortMenuOpen
  if (!state.effortMenuOpen) {
    effortMenu.replaceChildren()
    menuMarkup.delete(effortMenu)
    return
  }
  updateMenu(effortMenu, reasoningEfforts.map((effort) => {
    const selected = effort === activeEffort
    return `<button type="button" class="composer-select-option composer-effort-option${selected ? " selected" : ""}" role="option" aria-selected="${String(selected)}" data-effort-choice="${escapeAttribute(effort)}"${state.effortChanging ? " disabled" : ""}><span class="model-option-check">${selected ? renderIcon(Check) : ""}</span><span class="composer-select-option-main">${effortLabels[effort]}</span></button>`
  }).join(""))
}

export async function toggleEffortMenu() {
  if (!canOpenEffortMenu()) return
  state.effortMenuOpen = !state.effortMenuOpen
  if (state.effortMenuOpen) {
    closeModelMenu()
    state.projectMenuOpen = false
    state.composerMenuOpen = false
    closeSlashCommandMenu()
  }
  render()
  if (state.effortMenuOpen) (effortMenu.querySelector<HTMLElement>('[aria-selected="true"]') || effortMenu.querySelector<HTMLElement>("[role=option]"))?.focus()
}

export async function selectEffort(effort: string) {
  const sessionId = state.viewedSessionId
  const clean = effort.trim().toLowerCase()
  if (!sessionId || !reasoningEfforts.includes(clean as (typeof reasoningEfforts)[number]) || clean === displayedEffort() || state.effortChanging) {
    state.effortMenuOpen = false
    render()
    return
  }
  state.effortChanging = true
  render()
  try {
    const result = asRecord(await requestForSession(runtimeMethods.modelEffort, sessionId, { reasoning_effort: clean }))
    const next = asRecordText(result.reasoning_effort) || clean
    state.sessionEfforts = { ...state.sessionEfforts, [sessionId]: next }
    if (state.viewedSessionId === sessionId) state.effort = next
    state.effortMenuOpen = false
  } finally {
    state.effortChanging = false
    render()
  }
}
