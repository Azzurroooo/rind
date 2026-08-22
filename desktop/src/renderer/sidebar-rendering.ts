import type { DesktopProject, DesktopRecentSession, DesktopSessionSummary } from "../preload/types.ts"

export type SidebarStructureState = {
  projects: DesktopProject[]
  recentSessions: DesktopRecentSession[]
  sessionPages: Record<string, DesktopSessionSummary[]>
  sessionTotals: Record<string, number>
  expandedProjects: Iterable<string>
  projectMenuPath: string
}

export function projectListStructureKey(state: SidebarStructureState) {
  const expandedProjects = new Set(state.expandedProjects)
  return JSON.stringify(state.projects.map((project) => {
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
  }))
}

export function recentListStructureKey(state: SidebarStructureState) {
  return JSON.stringify([...state.recentSessions]
    .sort((left, right) => right.lastInteractedAt.localeCompare(left.lastInteractedAt))
    .map((session) => ({
      ...sessionStructure(session),
      lastInteractedAt: session.lastInteractedAt,
    })))
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
