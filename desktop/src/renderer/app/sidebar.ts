import { type DesktopRecentSession, type DesktopSessionSummary } from "../../preload/types.ts"
import { sameProjectPath as samePath } from "../project-selection.ts"
import { filterSessions, projectListStructureKey, recentListStructureKey } from "../sidebar-rendering.ts"
import { clipLine, relativeTime } from "../timeline-model.ts"
import { projectList, recentList, recentSessions, sessionSearchInput, sidebar } from "./dom.ts"
import { escapeAttribute, escapeHtml } from "./html.ts"
import { runAction } from "./runtime.ts"
import { loadMoreSessions, loadSessions, projectSessions, removeProject, sessionTurnActive, switchSession, toggleProject } from "./sessions.ts"
import { render } from "./shell.ts"
import { state, vars } from "./state.ts"



export function renderProjects() {
  const structureKey = projectListStructureKey({
    projects: state.projects,
    recentSessions: state.recentSessions,
    sessionPages: state.sessionPages,
    sessionTotals: state.sessionTotals,
    expandedProjects: state.expandedProjects,
    projectMenuPath: state.projectMenuPath,
    sessionSearch: state.sessionSearch,
    deleteConfirmId: state.sessionDeleteConfirmId,
    deleteBusyId: state.sessionDeleteBusyId,
  })
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

// Shared session row: selectable item + inline delete action (two-press
// confirm, opencode pattern). The current session cannot be deleted.
export function renderSessionRow(item: DesktopSessionSummary, whenIso: string) {
  const when = whenIso ? relativeTime(whenIso) : ""
  const running = sessionTurnActive(item.id)
  const isCurrent = item.id === state.viewedSessionId
  const confirming = state.sessionDeleteConfirmId === item.id
  const deleting = state.sessionDeleteBusyId === item.id
  const deleteState = isCurrent
    ? `<button type="button" class="session-delete ghost-button" data-session-delete="${escapeAttribute(item.id)}" title="Current session cannot be deleted" aria-label="Current session cannot be deleted" disabled>${DELETE_ICON}</button>`
    : confirming
      ? `<button type="button" class="session-delete ghost-button confirm" data-session-delete="${escapeAttribute(item.id)}" title="Press again to confirm delete" aria-label="Press again to confirm deleting this session"${deleting ? " disabled" : ""}>${deleting ? "…" : DELETE_ICON}</button>`
      : `<button type="button" class="session-delete ghost-button" data-session-delete="${escapeAttribute(item.id)}" title="Delete session" aria-label="Delete session ${escapeAttribute(item.title || item.id)}"${deleting ? " disabled" : ""}>${DELETE_ICON}</button>`
  return `
    <div class="session-item-row${confirming ? " confirming" : ""}" data-session-row="${escapeAttribute(item.id)}">
      <button type="button" class="session-item${running ? " running" : ""}" data-session-id="${escapeAttribute(item.id)}" data-session-project="${escapeAttribute(item.workspaceRoot)}" title="${escapeAttribute(item.title || "Untitled")}">
        <span class="session-item-title">${running ? `<span class="status-pip pip-running"></span>` : ""}<span class="session-item-title-text">${escapeHtml(item.title || "Untitled")}</span></span>
        <small>${escapeHtml(clipLine(item.preview || "", 48))}</small>
        <small class="session-item-meta">${escapeHtml(when)}</small>
      </button>
      ${deleteState}
    </div>
  `
}

export const DELETE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="session-delete-icon" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`

export function renderProjectSession(item: DesktopSessionSummary) {
  return renderSessionRow(item, item.updatedAt)
}

export function renderRecentSessions() {
  const structureKey = recentListStructureKey({
    projects: state.projects,
    recentSessions: state.recentSessions,
    sessionPages: state.sessionPages,
    sessionTotals: state.sessionTotals,
    expandedProjects: state.expandedProjects,
    projectMenuPath: state.projectMenuPath,
    sessionSearch: state.sessionSearch,
    deleteConfirmId: state.sessionDeleteConfirmId,
    deleteBusyId: state.sessionDeleteBusyId,
  })
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
  recentList.innerHTML = items.map(renderRecentSession).join("")
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
    const pip = title.querySelector<HTMLElement>(".status-pip")
    if (running && !pip) {
      title.insertAdjacentHTML("afterbegin", `<span class="status-pip pip-running"></span>`)
    } else if (!running && pip) {
      pip.remove()
    }
  }
}

// ---------- session delete (B3) ----------

export function resetDeleteConfirm() {
  state.sessionDeleteConfirmId = ""
  if (vars.deleteConfirmTimer) {
    clearTimeout(vars.deleteConfirmTimer)
    vars.deleteConfirmTimer = undefined
  }
}

export function requestSessionDeleteConfirm(sessionId: string) {
  if (state.sessionDeleteBusyId) return
  if (state.sessionDeleteConfirmId === sessionId) {
    resetDeleteConfirm()
    runAction(() => deleteSessionRequest(sessionId), sessionId)
    return
  }
  resetDeleteConfirm()
  state.sessionDeleteConfirmId = sessionId
  render()
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
    // Update the sidebar in place: drop the session from every local list.
    state.recentSessions = state.recentSessions.filter((item) => item.id !== sessionId)
    for (const [projectPath, sessions] of Object.entries(state.sessionPages)) {
      state.sessionPages[projectPath] = sessions.filter((item) => item.id !== sessionId)
    }
    for (const project of state.projects) {
      project.sessions = project.sessions.filter((item) => item.id !== sessionId)
      if (project.totalSessions > 0) project.totalSessions -= 1
    }
    const cache = { ...state.conversationCache }
    delete cache[sessionId]
    state.conversationCache = cache
    delete state.drafts[`${sessionId}:draft`]
    vars.renderedProjectListStructureKey = ""
    vars.renderedRecentListStructureKey = ""
    state.notice = "Session deleted."
  } finally {
    state.sessionDeleteBusyId = ""
    resetDeleteConfirm()
    render()
  }
  await loadSessions()
}

export function bindSidebarEvents(): void {
  projectList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
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
    const deleteSessionId = target.closest<HTMLButtonElement>("[data-session-delete]")?.dataset.sessionDelete
    if (deleteSessionId) {
      requestSessionDeleteConfirm(deleteSessionId)
      return
    }
    const sessionButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-session-id]")
    const nextSessionId = sessionButton?.dataset.sessionId
    if (nextSessionId) runAction(() => switchSession(nextSessionId), nextSessionId)
  })

  recentList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement
    const deleteSessionId = target.closest<HTMLButtonElement>("[data-session-delete]")?.dataset.sessionDelete
    if (deleteSessionId) {
      requestSessionDeleteConfirm(deleteSessionId)
      return
    }
    const nextSessionId = target.closest<HTMLButtonElement>("[data-session-id]")?.dataset.sessionId
    if (nextSessionId) runAction(() => switchSession(nextSessionId), nextSessionId)
  })

  sessionSearchInput.addEventListener("input", () => {
    state.sessionSearch = sessionSearchInput.value
    renderProjects()
    renderRecentSessions()
  })
}
