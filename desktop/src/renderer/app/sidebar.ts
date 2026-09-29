import { type DesktopRecentSession, type DesktopSessionSummary } from "../../preload/types.ts"
import { sameProjectPath as samePath } from "../project-selection.ts"
import { Ellipsis, LoaderCircle, renderIcon } from "../icons.ts"
import { groupByTime } from "../session-groups.ts"
import { withoutSession } from "../session-removal.ts"
import { filterSessions, projectListStructureKey, recentListStructureKey, type SidebarStructureState } from "../sidebar-rendering.ts"
import { relativeTime } from "../timeline-model.ts"
import { projectList, recentList, recentSessions, sessionSearchInput, sidebar } from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { focusFirstMenuItem, handleMenuKeydown } from "./menu-nav.ts"
import { runAction } from "./runtime.ts"
import { exportSessionReplay, forkSession, loadMoreSessions, loadSessions, projectSessions, removeProject, sessionTurnActive, switchSession, toggleProject } from "./sessions.ts"
import { showToast } from "./overlays.ts"
import { render } from "./shell.ts"
import { state, vars } from "./state.ts"



function sidebarStructureState(): SidebarStructureState {
  return {
    projects: state.projects,
    recentSessions: state.recentSessions,
    sessionPages: state.sessionPages,
    sessionTotals: state.sessionTotals,
    expandedProjects: state.expandedProjects,
    projectMenuPath: state.projectMenuPath,
    sessionSearch: state.sessionSearch,
    deleteConfirmId: state.sessionDeleteConfirmId,
    deleteBusyId: state.sessionDeleteBusyId,
    sessionMenuId: state.sessionMenuId,
  }
}

export function renderProjects() {
  const structureKey = projectListStructureKey(sidebarStructureState())
  if (structureKey === vars.renderedProjectListStructureKey) {
    syncSidebarSelection()
    syncSidebarRunningState()
    return
  }
  vars.renderedProjectListStructureKey = structureKey
  projectList.replaceChildren()
  if (!state.projects.length) {
    projectList.innerHTML = `<div class="sidebar-empty"><strong>No projects</strong><span>Add a folder to start a chat.</span></div>`
    syncSidebarSelection()
    syncSidebarRunningState()
    return
  }
  for (const project of state.projects) {
    const expanded = state.expandedProjects.has(project.path)
    const menuOpen = samePath(project.path, state.projectMenuPath)
    const loaded = projectSessions(project)
    const sessions = filterSessions(loaded, state.sessionSearch)
    const searching = Boolean(state.sessionSearch.trim())
    const total = state.sessionTotals[project.path] ?? project.totalSessions
    const showSessions = expanded || (searching && sessions.length)
    const projectNode = document.createElement("section")
    projectNode.className = `project-item${expanded ? " expanded" : ""}`
    projectNode.innerHTML = `
      <div class="project-row">
        <button type="button" class="project-trigger" data-project-path="${escapeAttribute(project.path)}" title="${escapeAttribute(project.path)}">
          <span class="project-name">${escapeHtml(project.name)}</span>
          <span class="project-path">${escapeHtml(project.path)}</span>
        </button>
        <div class="project-menu-wrap">
          <button type="button" class="project-menu-trigger ghost-button" data-project-menu="${escapeAttribute(project.path)}" title="Project actions" aria-label="Project actions for ${escapeAttribute(project.name)}" aria-haspopup="menu" aria-expanded="${String(menuOpen)}"><svg class="project-menu-icon" viewBox="0 0 16 16" focusable="false" aria-hidden="true"><circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" /></svg></button>
          ${menuOpen ? `<div class="project-menu" role="menu"><button type="button" data-remove-project="${escapeAttribute(project.path)}" role="menuitem">Remove</button></div>` : ""}
        </div>
      </div>
      ${project.available ? "" : `<p class="project-missing">Folder is unavailable.</p>`}
      ${showSessions ? `<div class="project-sessions">${sessions.map(renderProjectSession).join("") || `<p class="session-search-empty">No loaded sessions match.</p>`}${!searching && loaded.length < total ? `<button type="button" class="show-more ghost-button" data-show-more="${escapeAttribute(project.path)}">View more sessions</button>` : ""}</div>` : ""}
    `
    projectList.append(projectNode)
  }
  syncSidebarSelection()
  syncSidebarRunningState()
}

const SPINNER = renderIcon(LoaderCircle, "session-spinner")

// Shared session row (spec section 3): a 32px title row plus a hover
// overflow menu with Fork, Export replay and a confirming Delete.
export function renderSessionRow(item: DesktopSessionSummary, whenIso: string) {
  const title = item.title || "Untitled"
  const running = sessionTurnActive(item.id)
  const menuOpen = state.sessionMenuId === item.id
  const when = whenIso ? relativeTime(whenIso) : ""
  return `
    <div class="session-item-row${menuOpen ? " menu-open" : ""}" data-session-row="${escapeAttribute(item.id)}">
      <button type="button" class="session-item${running ? " running" : ""}" data-session-id="${escapeAttribute(item.id)}" data-session-project="${escapeAttribute(item.workspaceRoot)}" title="${escapeAttribute(when ? `${title} - ${when}` : title)}">
        <span class="session-item-title">${running ? SPINNER : ""}<span class="session-item-title-text">${escapeHtml(title)}</span></span>
      </button>
      <div class="session-menu-wrap">
        <button type="button" class="session-menu-trigger" data-session-menu="${escapeAttribute(item.id)}" aria-label="Actions for ${escapeAttribute(title)}" aria-haspopup="menu" aria-expanded="${String(menuOpen)}">${renderIcon(Ellipsis, "session-menu-icon")}</button>
        ${menuOpen ? renderSessionMenu(item, title) : ""}
      </div>
    </div>
  `
}

function renderSessionMenu(item: DesktopSessionSummary, title: string) {
  const id = escapeAttribute(item.id)
  const isCurrent = item.id === state.viewedSessionId
  const confirming = state.sessionDeleteConfirmId === item.id
  const deleting = state.sessionDeleteBusyId === item.id
  const busy = sessionTurnActive(item.id)
  const deleteLabel = isCurrent ? "Delete (open session)" : deleting ? "Deleting…" : confirming ? "Confirm delete" : "Delete"
  return `<div class="session-menu menu${vars.sessionMenuUp ? " menu-up" : ""}" role="menu" aria-label="Actions for ${escapeAttribute(title)}">
    <button type="button" class="menu-item" role="menuitem" data-session-fork="${id}"${busy ? " disabled" : ""}>Fork</button>
    <button type="button" class="menu-item" role="menuitem" data-session-export="${id}" data-session-title="${escapeAttribute(title)}">Export replay</button>
    <div class="menu-separator" role="separator"></div>
    <button type="button" class="menu-item menu-item-danger${confirming ? " confirm" : ""}" role="menuitem" data-session-delete="${id}"${isCurrent || deleting ? " disabled" : ""}${isCurrent ? ` title="The open session cannot be deleted"` : ""}>${deleteLabel}</button>
  </div>`
}

export function renderProjectSession(item: DesktopSessionSummary) {
  return renderSessionRow(item, item.updatedAt)
}

export function renderRecentSessions() {
  const structureKey = recentListStructureKey(sidebarStructureState())
  if (structureKey === vars.renderedRecentListStructureKey) {
    syncSidebarSelection()
    syncSidebarRunningState()
    return
  }
  vars.renderedRecentListStructureKey = structureKey
  const filtered = filterSessions(state.recentSessions, state.sessionSearch)
  if (!filtered.length) {
    recentSessions.hidden = !state.recentSessions.length
    recentList.replaceChildren()
    syncSidebarSelection()
    syncSidebarRunningState()
    return
  }
  const items = [...filtered].sort((left, right) => right.lastInteractedAt.localeCompare(left.lastInteractedAt))
  recentSessions.hidden = false
  recentList.innerHTML = groupByTime(items, (item) => item.lastInteractedAt)
    .map((group) => `<div class="session-group" role="group" aria-label="${escapeAttribute(group.label)}"><div class="session-group-label" aria-hidden="true">${escapeHtml(group.label)}</div>${group.items.map(renderRecentSession).join("")}</div>`)
    .join("")
  syncSidebarSelection()
  syncSidebarRunningState()
}

export function renderRecentSession(item: DesktopRecentSession) {
  return renderSessionRow(item, item.lastInteractedAt)
}

export function syncSidebarSelection() {
  const selectedId = state.viewedSessionId
  for (const button of sidebar.querySelectorAll<HTMLButtonElement>("[data-session-id]")) {
    const selected = button.dataset.sessionId === selectedId
    button.classList.toggle("selected", selected)
    if (selected) button.setAttribute("aria-current", "page")
    else button.removeAttribute("aria-current")
  }
}

export function syncSidebarRunningState() {
  for (const button of sidebar.querySelectorAll<HTMLButtonElement>("[data-session-id]")) {
    const running = sessionTurnActive(button.dataset.sessionId || "")
    button.classList.toggle("running", running)
    const title = button.querySelector<HTMLElement>(".session-item-title")
    if (!title) continue
    const spinner = title.querySelector<SVGElement>(".session-spinner")
    if (running && !spinner) {
      title.insertAdjacentHTML("afterbegin", SPINNER)
    } else if (!running && spinner) {
      spinner.remove()
    }
  }
}

// ---------- session menu and delete ----------

export function resetDeleteConfirm() {
  state.sessionDeleteConfirmId = ""
  if (vars.deleteConfirmTimer) {
    clearTimeout(vars.deleteConfirmTimer)
    vars.deleteConfirmTimer = undefined
  }
}

export function openSessionMenu(sessionId: string) {
  resetDeleteConfirm()
  state.sessionMenuId = sessionId
  vars.sessionMenuUp = false
  render()
  const menu = sidebar.querySelector<HTMLElement>(".session-menu")
  const body = menu?.closest<HTMLElement>(".sidebar-body")
  if (menu && body && menu.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom) {
    vars.sessionMenuUp = true
    menu.classList.add("menu-up")
  }
  focusFirstMenuItem(menu)
}

export function closeSessionMenu(restoreFocus = false) {
  const sessionId = state.sessionMenuId
  if (!sessionId) return
  state.sessionMenuId = ""
  resetDeleteConfirm()
  render()
  if (restoreFocus) sidebar.querySelector<HTMLButtonElement>(`[data-session-menu="${CSS.escape(sessionId)}"]`)?.focus()
}

export function requestSessionDeleteConfirm(sessionId: string) {
  if (state.sessionDeleteBusyId) return
  if (state.sessionDeleteConfirmId === sessionId) {
    resetDeleteConfirm()
    state.sessionMenuId = ""
    runAction(() => deleteSessionRequest(sessionId), sessionId)
    return
  }
  resetDeleteConfirm()
  state.sessionDeleteConfirmId = sessionId
  render()
  sidebar.querySelector<HTMLButtonElement>(`.session-menu [data-session-delete="${CSS.escape(sessionId)}"]`)?.focus()
  vars.deleteConfirmTimer = setTimeout(() => {
    if (state.sessionDeleteConfirmId === sessionId) {
      state.sessionDeleteConfirmId = ""
      render()
    }
  }, 4000)
}

export async function deleteSessionRequest(sessionId: string) {
  if (!sessionId || state.sessionDeleteBusyId) return
  if (sessionId === state.viewedSessionId) {
    state.notice = "The current session cannot be deleted."
    render()
    return
  }
  state.sessionDeleteBusyId = sessionId
  render()
  try {
    await window.api.sessions.remove(sessionId)
    // Update the sidebar in place; every list is replaced, never mutated.
    const next = withoutSession({
      recentSessions: state.recentSessions,
      sessionPages: state.sessionPages,
      sessionTotals: state.sessionTotals,
      projects: state.projects,
      conversationCache: state.conversationCache,
      drafts: state.drafts,
    }, sessionId)
    state.recentSessions = next.recentSessions
    state.sessionPages = next.sessionPages
    state.sessionTotals = next.sessionTotals
    state.projects = next.projects
    state.conversationCache = next.conversationCache
    state.drafts = next.drafts
    vars.renderedProjectListStructureKey = ""
    vars.renderedRecentListStructureKey = ""
    showToast("Session deleted.", "success")
  } finally {
    state.sessionDeleteBusyId = ""
    resetDeleteConfirm()
    render()
  }
  await loadSessions()
}

/** Row menu clicks shared by the recent and project lists. Returns true when handled. */
function handleSessionMenuClick(target: HTMLElement) {
  const menuId = target.closest<HTMLButtonElement>("[data-session-menu]")?.dataset.sessionMenu
  if (menuId) {
    if (state.sessionMenuId === menuId) closeSessionMenu()
    else openSessionMenu(menuId)
    return true
  }
  const forkId = target.closest<HTMLButtonElement>("[data-session-fork]")?.dataset.sessionFork
  if (forkId) {
    closeSessionMenu()
    runAction(() => forkSession(forkId), forkId)
    return true
  }
  const exportButton = target.closest<HTMLButtonElement>("[data-session-export]")
  if (exportButton?.dataset.sessionExport) {
    const exportId = exportButton.dataset.sessionExport
    const title = exportButton.dataset.sessionTitle || "Rind conversation"
    closeSessionMenu()
    runAction(() => exportSessionReplay(exportId, title))
    return true
  }
  const deleteId = target.closest<HTMLButtonElement>("[data-session-delete]")?.dataset.sessionDelete
  if (deleteId) {
    requestSessionDeleteConfirm(deleteId)
    return true
  }
  return false
}

export function bindSidebarEvents(): void {
  projectList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    if (handleSessionMenuClick(target)) return
    const menuProjectPath = target.closest<HTMLButtonElement>("[data-project-menu]")?.dataset.projectMenu
    if (menuProjectPath) {
      state.projectMenuPath = samePath(menuProjectPath, state.projectMenuPath) ? "" : menuProjectPath
      render()
      return
    }
    const projectPath = target.closest<HTMLButtonElement>("[data-project-path]")?.dataset.projectPath
    if (projectPath) {
      runAction(() => toggleProject(projectPath))
      return
    }
    const removeProjectPath = target.closest<HTMLButtonElement>("[data-remove-project]")?.dataset.removeProject
    if (removeProjectPath) {
      state.projectMenuPath = ""
      render()
      runAction(() => removeProject(removeProjectPath))
      return
    }
    const moreProjectPath = target.closest<HTMLButtonElement>("[data-show-more]")?.dataset.showMore
    if (moreProjectPath) {
      runAction(() => loadMoreSessions(moreProjectPath))
      return
    }
    const nextSessionId = target.closest<HTMLButtonElement>("[data-session-id]")?.dataset.sessionId
    if (nextSessionId) runAction(() => switchSession(nextSessionId), nextSessionId)
  })

  recentList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    if (handleSessionMenuClick(target)) return
    const nextSessionId = target.closest<HTMLButtonElement>("[data-session-id]")?.dataset.sessionId
    if (nextSessionId) runAction(() => switchSession(nextSessionId), nextSessionId)
  })

  sidebar.addEventListener("keydown", (event) => {
    const menu = (event.target as HTMLElement).closest<HTMLElement>(".session-menu")
    if (!menu) return
    if (handleMenuKeydown(event, menu) === "close") closeSessionMenu()
  })

  sessionSearchInput.addEventListener("input", () => {
    state.sessionSearch = sessionSearchInput.value
    renderProjects()
    renderRecentSessions()
  })
}
