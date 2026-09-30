import { type DesktopProject, type DesktopSessionSummary, runtimeMethods } from "../../preload/types.ts"
import { defaultNewChatProjectPath, projectForPath as findProjectForPath, sameProjectPath as samePath } from "../project-selection.ts"
import { replayMarkdown } from "../session-actions.ts"
import { createTaskMonitorState } from "../task-monitor.ts"
import { createConversation } from "../timeline-model.ts"
import { closeComposerSelectMenus } from "./composer-menus.ts"
import { autoGrowPrompt } from "./composer.ts"
import { projectList, prompt, requiredElement, sessionTitle } from "./dom.ts"
import { asRecord } from "./html.ts"
import { clampInspectorWidth } from "../inspector-model.ts"
import { refreshInspector, resetInspectorData } from "./inspector.ts"
import { resetGoal } from "./inspector-goal.ts"
import { resetTasks, stopTaskPolling } from "./inspector-tasks.ts"
import { activeTurnIdFor, loadReplay, requestForSession, resetConversationPresentation, runtimeTurnActive } from "./runtime.ts"
import { showToast } from "./overlays.ts"
import { render } from "./shell.ts"
import { state, vars } from "./state.ts"


export async function exportSession() {
  const sessionId = state.viewedSessionId
  if (!sessionId) return
  const button = requiredElement<HTMLButtonElement>("export-session")
  button.disabled = true
  try {
    await exportSessionReplay(sessionId, sessionTitle.textContent || "Rind conversation")
  } finally { button.disabled = false }
}

/** Downloads the complete replay of any session as Markdown. */
export async function exportSessionReplay(sessionId: string, title: string) {
  try {
    const result = asRecord(await requestForSession(runtimeMethods.sessionReplay, sessionId))
    const text = replayMarkdown(Array.isArray(result.messages) ? result.messages : [], title)
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "rind-conversation.md"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) {
    state.notice = `Export failed: ${error instanceof Error ? error.message : String(error)}`
    render()
  }
}

export async function forkCurrentSession() {
  if (!state.viewedSessionId || runtimeTurnActive()) return
  const result = asRecord(await requestForSession(runtimeMethods.sessionFork, state.viewedSessionId))
  await loadSessions()
  if (typeof result.session_id === "string") await switchSession(result.session_id)
}

/** Forks from the sidebar: open the session first so the fork runs in its project. */
export async function forkSession(sessionId: string) {
  if (!sessionId) return
  if (sessionId !== state.viewedSessionId) await switchSession(sessionId)
  await forkCurrentSession()
}

export function viewedProject() {
  return projectForPath(state.viewedProjectPath)
}

export function chatProject() {
  return projectForPath(state.chatProjectPath)
}

export function projectForPath(path: string) {
  return findProjectForPath(state.projects, path)
}

export function currentRuntimeSnapshot() {
  return state.runtime
}

export function sessionTurnActive(sessionId: string) {
  return Boolean(sessionId && (state.runtimeTurnPending[sessionId] || activeTurnIdFor(sessionId)))
}

export function projectSessions(project: DesktopProject) {
  return state.sessionPages[project.path] || project.sessions
}

export function allSessions() {
  return state.projects.flatMap(projectSessions)
}

export function knownSessions() {
  const sessions = new Map<string, DesktopSessionSummary>()
  for (const session of [...state.recentSessions, ...allSessions()]) sessions.set(session.id, session)
  return [...sessions.values()]
}

export async function loadSessions() {
  const version = ++vars.overviewVersion
  const overview = await window.api.projects.get()
  if (version !== vars.overviewVersion) return
  applyOverview(overview)
  await flushRecentSessions()
}

export function applyOverview(overview: Awaited<ReturnType<typeof window.api.projects.get>>) {
  const nextPages: Record<string, DesktopSessionSummary[]> = {}
  const nextTotals: Record<string, number> = {}
  for (const project of overview.projects) {
    nextPages[project.path] = mergeSessions(project.sessions, state.sessionPages[project.path] || [])
    nextTotals[project.path] = project.totalSessions
  }
  state.projects = overview.projects
  const recent = new Map(state.recentSessions.filter((session) => overview.projects.some((project) => samePath(project.path, session.workspaceRoot))).map((session) => [session.id, session]))
  for (const session of overview.recentSessions) recent.set(session.id, session)
  state.recentSessions = [...recent.values()].sort((a, b) => b.lastInteractedAt.localeCompare(a.lastInteractedAt)).slice(0, state.recentLimit)
  state.recentSessionTotal = overview.recentSessionTotal ?? overview.recentSessions.length
  state.fallbackProjectPath = overview.activeProjectPath
  state.chatProjectPath = projectForPath(state.chatProjectPath)?.path
    || defaultNewChatProjectPath(state.projects, state.recentSessions, state.fallbackProjectPath)
  state.viewedProjectPath = projectForPath(state.viewedProjectPath)?.path || state.chatProjectPath
  if (!projectForPath(state.projectMenuPath)) state.projectMenuPath = ""
  state.sidebarOpen = overview.sidebarOpen
  state.sidebarWidth = overview.sidebarWidth
  state.inspectorOpen = overview.filesOpen
  state.inspectorWidth = clampInspectorWidth(overview.filePanelWidth)
  state.theme = overview.theme
  state.notificationsEnabled = overview.notificationsEnabled
  state.sessionPages = nextPages
  state.sessionTotals = nextTotals
}

export function mergeSessions(primary: DesktopSessionSummary[], secondary: DesktopSessionSummary[]) {
  const sessions = new Map<string, DesktopSessionSummary>()
  for (const session of [...primary, ...secondary]) sessions.set(session.id, session)
  return [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function recordRecentSession(sessionId: string) {
  if (!sessionId) return
  state.pendingRecentSessionIds.add(sessionId)
  await flushRecentSessions()
}

export async function flushRecentSessions() {
  if (vars.recentFlushPromise) return vars.recentFlushPromise
  vars.recentFlushPromise = (async () => {
    while (state.pendingRecentSessionIds.size) {
      const sessionIds = [...state.pendingRecentSessionIds]
      for (const sessionId of sessionIds) {
        // Drafts have no persisted user message yet. Attempt each queued mark
        // once; reopening/starting a turn will enqueue it again when appropriate.
        state.pendingRecentSessionIds.delete(sessionId)
        const overview = await window.api.projects.markRecent(sessionId)
        applyOverview(overview)
      }
    }
  })().finally(() => {
    vars.recentFlushPromise = undefined
  })
  return vars.recentFlushPromise
}

export function resetProjectView() {
  closeComposerSelectMenus()
  state.viewedSessionId = ""
  state.conversationCache = {}
  state.sessionModels = {}
  state.sessionEfforts = {}
  state.conversation = createConversation()
  resetConversationPresentation()
  state.expandedDirectories = new Set([""])
  state.fileListings = {}
  state.filePreview = undefined
  resetSessionPanels()
  stopTaskPolling()
  vars.lastRenderedEntries = 0
}

/** Clears inspector data that belongs to the previously viewed session. */
function resetSessionPanels() {
  resetGoal()
  resetTasks()
  resetInspectorData()
  state.taskMonitor = createTaskMonitorState()
}

export function currentDraftKey() { return state.viewedSessionId ? `${state.viewedSessionId}:draft` : state.chatProjectPath }

export function restoreProjectDraft() {
  prompt.value = state.drafts[currentDraftKey()] || ""
  autoGrowPrompt()
}

export function resolveNewChatProjectPath() {
  return defaultNewChatProjectPath(state.projects, state.recentSessions, state.fallbackProjectPath)
}

export async function addProject() {
  const overview = await window.api.projects.add()
  if (!overview) return
  applyOverview(overview)
  resetProjectView()
  state.chatProjectPath = overview.activeProjectPath
  state.viewedProjectPath = overview.activeProjectPath
  restoreProjectDraft()
  state.notice = ""
  render()
  await refreshInspector()
}

export async function toggleProject(path: string) {
  const project = state.projects.find((item) => item.path === path)
  if (!project) return
  if (state.expandedProjects.has(path)) {
    const trigger = [...projectList.querySelectorAll<HTMLButtonElement>("[data-project-path]")]
      .find((item) => item.dataset.projectPath === path)
    const sessions = trigger?.closest<HTMLElement>(".project-item")?.querySelector<HTMLElement>(".project-sessions")
    if (sessions && !sessions.classList.contains("collapsing") && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          window.clearTimeout(timeoutId)
          sessions.removeEventListener("animationend", finish)
          resolve()
        }
        sessions.style.height = `${sessions.offsetHeight}px`
        sessions.classList.add("collapsing")
        sessions.addEventListener("animationend", finish, { once: true })
        requestAnimationFrame(() => { sessions.style.height = "0px" })
        const timeoutId = window.setTimeout(finish, 260)
      })
    }
    state.expandedProjects.delete(path)
    projectList.classList.add("skip-project-animation")
  } else {
    state.expandedProjects.add(path)
  }
  state.notice = ""
  render()
  if (projectList.classList.contains("skip-project-animation")) {
    requestAnimationFrame(() => projectList.classList.remove("skip-project-animation"))
  }
}

export async function removeProject(path: string) {
  const project = state.projects.find((item) => item.path === path)
  if (!project) return
  if (!window.confirm(`Remove ${project.name} from Rind Desktop? Its folder and sessions will be kept.`)) return
  const removesViewedProject = samePath(path, state.viewedProjectPath)
  const removesChatProject = samePath(path, state.chatProjectPath)
  const overview = await window.api.projects.remove(path)
  applyOverview(overview)
  delete state.drafts[path]
  if (removesViewedProject || removesChatProject) {
    state.chatProjectPath = resolveNewChatProjectPath()
    state.viewedProjectPath = state.chatProjectPath
    resetProjectView()
    restoreProjectDraft()
  }
  showToast("Project removed from Desktop.", "success")
  render()
  await refreshInspector()
}

export async function startNewChat() {
  closeComposerSelectMenus()
  if (state.chatProjectPath) state.drafts[currentDraftKey()] = prompt.value
  state.chatProjectPath = resolveNewChatProjectPath()
  state.viewedProjectPath = state.chatProjectPath
  const project = chatProject()
  if (!project?.available) {
    await addProject()
    return
  }
  state.viewedSessionId = ""
  state.model = state.settings.model
  state.filePreview = undefined
  state.fileListings = {}
  state.conversation = createConversation()
  resetConversationPresentation()
  resetSessionPanels()
  restoreProjectDraft()
  state.notice = ""
  render()
  await refreshInspector()
}

export async function loadMoreSessions(path: string) {
  const loaded = state.sessionPages[path] || []
  const result = await window.api.projects.sessions(path, loaded.length, 20)
  state.sessionPages[path] = mergeSessions(loaded, result.sessions)
  state.sessionTotals[path] = result.total
  render()
}

export async function switchSession(nextSessionId: string) {
  if (nextSessionId === state.viewedSessionId) return
  const session = knownSessions().find((item) => item.id === nextSessionId)
  if (!session) {
    state.notice = "This session is unavailable in the registered Desktop projects."
    render()
    return
  }
  const project = projectForPath(session.workspaceRoot)
  if (!project) return
  closeComposerSelectMenus()
  showCachedSession(nextSessionId)
  state.viewedSessionId = nextSessionId
  state.model = state.sessionModels[nextSessionId] || ""
  state.effort = state.sessionEfforts[nextSessionId] || ""
  state.viewedProjectPath = project.path
  state.chatProjectPath = project.path
  state.expandedDirectories = new Set([""])
  state.fileListings = {}
  state.filePreview = undefined
  restoreProjectDraft()
  resetSessionPanels()
  stopTaskPolling()
  render()
  await loadReplay(nextSessionId)
  if (state.viewedSessionId !== nextSessionId) return
  await refreshInspector()
  render()
}

export async function selectChatProject(path: string) {
  if (state.viewedSessionId) return
  const project = state.projects.find((item) => item.path === path)
  if (!project) return
  closeComposerSelectMenus()
  if (state.chatProjectPath) state.drafts[currentDraftKey()] = prompt.value
  state.chatProjectPath = project.path
  state.viewedProjectPath = project.path
  state.viewedSessionId = ""
  state.model = state.settings.model
  state.conversation = createConversation()
  state.expandedDirectories = new Set([""])
  state.fileListings = {}
  state.filePreview = undefined
  resetConversationPresentation()
  restoreProjectDraft()
  resetSessionPanels()
  render()
  await refreshInspector()
}

export function showCachedSession(sessionId: string) {
  if (sessionId === state.viewedSessionId) return
  state.drafts[currentDraftKey()] = prompt.value
  const cache = { ...state.conversationCache }
  if (state.viewedSessionId) cache[state.viewedSessionId] = state.conversation
  state.viewedSessionId = sessionId
  state.conversation = cache[sessionId] || createConversation()
  state.conversationCache = cache
  resetConversationPresentation()
}
