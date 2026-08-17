import type { DesktopProject, DesktopRecentSession } from "../preload/types.ts"

export function sameProjectPath(left: string, right: string) {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  const normalizedLeft = normalize(left)
  const normalizedRight = normalize(right)
  const isWindowsPath = /^[A-Za-z]:\//.test(normalizedLeft) || normalizedLeft.startsWith("//")
  return isWindowsPath ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase() : normalizedLeft === normalizedRight
}

export function projectForPath(projects: DesktopProject[], path: string) {
  return projects.find((project) => sameProjectPath(project.path, path))
}

export function defaultNewChatProjectPath(
  projects: DesktopProject[],
  recentSessions: DesktopRecentSession[],
  fallbackProjectPath: string,
) {
  for (const session of recentSessions) {
    const project = projectForPath(projects, session.workspaceRoot)
    if (project?.available) return project.path
  }
  const fallback = projectForPath(projects, fallbackProjectPath)
  if (fallback?.available) return fallback.path
  return projects.find((project) => project.available)?.path || ""
}

export function workingDirectorySelectionEnabled(projectCount: number, viewedSessionId: string) {
  return projectCount > 0 && !viewedSessionId
}
