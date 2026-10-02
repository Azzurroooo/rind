// Immutable removal of a deleted session from every sidebar list and cache.

type Identified = { id: string }
type ProjectLike<S extends Identified> = { path: string; sessions: S[]; totalSessions: number }

export type SessionLists<S extends Identified, R extends Identified, P extends ProjectLike<S>, C> = {
  recentSessions: R[]
  sessionPages: Record<string, S[]>
  sessionTotals: Record<string, number>
  projects: P[]
  conversationCache: Record<string, C>
  drafts: Record<string, string>
}

const has = (items: readonly Identified[] | undefined, id: string) => Boolean(items?.some((item) => item.id === id))
const without = <T extends Identified>(items: readonly T[], id: string) => items.filter((item) => item.id !== id)
const decrement = (value: number) => Math.max(0, value - 1)

/** Returns new lists without the session. Totals drop only for projects that listed it. */
export function withoutSession<S extends Identified, R extends Identified, P extends ProjectLike<S>, C>(
  lists: SessionLists<S, R, P, C>,
  sessionId: string,
): SessionLists<S, R, P, C> {
  const owners = new Set(lists.projects
    .filter((project) => has(project.sessions, sessionId) || has(lists.sessionPages[project.path], sessionId))
    .map((project) => project.path))
  const { [sessionId]: _cached, ...conversationCache } = lists.conversationCache
  const { [`${sessionId}:draft`]: _draft, ...drafts } = lists.drafts
  return {
    recentSessions: without(lists.recentSessions, sessionId),
    sessionPages: Object.fromEntries(Object.entries(lists.sessionPages).map(([path, sessions]) => [path, without(sessions, sessionId)])),
    sessionTotals: Object.fromEntries(Object.entries(lists.sessionTotals).map(([path, total]) => [path, owners.has(path) ? decrement(total) : total])),
    projects: lists.projects.map((project) => owners.has(project.path)
      ? { ...project, sessions: without(project.sessions, sessionId), totalSessions: decrement(project.totalSessions) }
      : project),
    conversationCache,
    drafts,
  }
}
