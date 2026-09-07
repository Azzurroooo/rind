import type { DesktopProject, DesktopRecentSession, DesktopSessionSummary } from "../preload/types.ts"

export type SidebarStructureState = {
  projects: DesktopProject[]
  recentSessions: DesktopRecentSession[]
  sessionPages: Record<string, DesktopSessionSummary[]>
  sessionTotals: Record<string, number>
  expandedProjects: Iterable<string>
  projectMenuPath: string
  sessionSearch: string
  deleteConfirmId: string
  deleteBusyId: string
}

// Client-side search over the sessions already loaded in the sidebar (B8).
// Empty queries pass through untouched so pagination is unaffected.
export function filterSessions<T extends DesktopSessionSummary>(sessions: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return sessions
  return sessions.filter((session) =>
    session.title.toLocaleLowerCase().includes(needle)
    || session.preview.toLocaleLowerCase().includes(needle)
    || session.id.toLocaleLowerCase().includes(needle))
}

export function projectListStructureKey(state: SidebarStructureState) {
  const expandedProjects = new Set(state.expandedProjects)
  const search = (state.sessionSearch || "").trim().toLocaleLowerCase()
  return JSON.stringify({
    search,
    deleteConfirmId: state.deleteConfirmId || "",
    deleteBusyId: state.deleteBusyId || "",
    projects: state.projects.map((project) => {
      const sessions = state.sessionPages[project.path] || project.sessions
      return {
        path: project.path,
        name: project.name,
        available: project.available,
        expanded: expandedProjects.has(project.path),
        menuOpen: sameProjectPath(state.projectMenuPath, project.path),
        total: state.sessionTotals[project.path] ?? project.totalSessions,
        sessions: sessions.map((session) => sessionStructure(session)),
      }
    }),
  })
}

export function recentListStructureKey(state: SidebarStructureState) {
  return JSON.stringify({
    search: (state.sessionSearch || "").trim().toLocaleLowerCase(),
    deleteConfirmId: state.deleteConfirmId || "",
    deleteBusyId: state.deleteBusyId || "",
    sessions: [...state.recentSessions]
      .sort((left, right) => right.lastInteractedAt.localeCompare(left.lastInteractedAt))
      .map((session) => ({
        ...sessionStructure(session),
        lastInteractedAt: session.lastInteractedAt,
      })),
  })
}

function sessionStructure(session: DesktopSessionSummary) {
  return {
    id: session.id,
    title: session.title,
    preview: session.preview,
    updatedAt: session.updatedAt,
    workspaceRoot: session.workspaceRoot,
    hasUserMessage: session.hasUserMessage,
  }
}

function sameProjectPath(left: string, right: string) {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  const normalizedLeft = normalize(left)
  const normalizedRight = normalize(right)
  const isWindowsPath = /^[A-Za-z]:\//.test(normalizedLeft) || normalizedLeft.startsWith("//")
  return isWindowsPath ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase() : normalizedLeft === normalizedRight
}
