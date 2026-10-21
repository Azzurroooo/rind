import { stat, unlink } from "node:fs/promises"
import { dirname } from "node:path"

import type { DesktopProject, DesktopProjectOverview, DesktopRecentSession, DesktopSessionSummary, DesktopTheme, DesktopPrefsPatch } from "../preload/types"
import { asObject, readJsonObject, writeJsonObject } from "./json-store.ts"
import {
  canonicalDirectory,
  projectSummaryForPath,
  readSessionIndex,
  readSharedWorkspaces,
  samePath,
  storedPath,
  uniquePaths,
  writeSharedWorkspaces,
} from "../../../rind-runtime-client/remote/workspaces.js"

export { samePath }

const recentDesktopSessionLimit = 200
const sessionPageLimit = 20
const maxSessionPageLimit = 50
const themes: DesktopTheme[] = ["system", "dark", "light"]

type StoredRecentSession = {
  session_id: string
  last_interacted_at: string
}

type StoredProjectState = {
  projects: string[]
  activeProjectPath: string
  recentSessions: StoredRecentSession[]
  sidebarOpen: boolean
  sidebarWidth: number
  filesOpen: boolean
  filePanelWidth: number
  theme: DesktopTheme
  notificationsEnabled: boolean
}

export class DesktopProjectStore {
  private readonly configFile: string
  private readonly sessionIndexFile: string
  private readonly legacyRecentSessionsFile: string
  private recentWrite = Promise.resolve()

  constructor(
    configFile: string,
    sessionIndexFile: string,
    legacyRecentSessionsFile: string,
  ) {
    this.configFile = configFile
    this.sessionIndexFile = sessionIndexFile
    this.legacyRecentSessionsFile = legacyRecentSessionsFile
  }

  private get rindHome(): string {
    return dirname(this.sessionIndexFile)
  }

  async overview(): Promise<DesktopProjectOverview> {
    const [state, sessions] = await Promise.all([this.readState(), readSessionIndex(this.sessionIndexFile)])
    const projects = await Promise.all(state.projects.map((path): Promise<DesktopProject> => projectSummaryForPath(path, sessions)))
    const recent = await this.recentSessions(state, sessions)
    return {
      projects,
      recentSessions: recent.slice(0, 10),
      recentSessionTotal: recent.length,
      activeProjectPath: state.activeProjectPath,
      sidebarOpen: state.sidebarOpen,
      sidebarWidth: state.sidebarWidth,
      filesOpen: state.filesOpen,
      filePanelWidth: state.filePanelWidth,
      theme: state.theme,
      notificationsEnabled: state.notificationsEnabled,
    }
  }

  async updatePrefs(patch: DesktopPrefsPatch): Promise<DesktopProjectOverview> {
    const state = await this.readState()
    const next = { ...state }
    if (patch.theme && themes.includes(patch.theme)) next.theme = patch.theme
    if (typeof patch.notificationsEnabled === "boolean") next.notificationsEnabled = patch.notificationsEnabled
    await this.writeState(next)
    return this.overview()
  }

  async add(path: string): Promise<DesktopProjectOverview> {
    const canonicalPath = await canonicalDirectory(path)
    const state = await this.readState()
    const projects = uniquePaths([...state.projects, canonicalPath])
    await this.writeState({ ...state, projects, activeProjectPath: canonicalPath })
    return this.overview()
  }

  async select(path: string): Promise<DesktopProjectOverview> {
    const state = await this.readState()
    const projectPath = state.projects.find((item) => samePath(item, path))
    if (!projectPath) throw new Error("Project is not registered in Rind Desktop.")
    await canonicalDirectory(projectPath)
    await this.writeState({ ...state, activeProjectPath: projectPath })
    return this.overview()
  }

  async remove(path: string): Promise<DesktopProjectOverview> {
    const state = await this.readState()
    const projects = state.projects.filter((item) => !samePath(item, path))
    if (projects.length === state.projects.length) throw new Error("Project is not registered in Rind Desktop.")
    const activeProjectPath = samePath(state.activeProjectPath, path)
      ? projects.at(0) || ""
      : state.activeProjectPath
    await this.writeState({ ...state, projects, activeProjectPath })
    return this.overview()
  }

  async updateLayout(patch: { sidebarOpen?: boolean; sidebarWidth?: number; filesOpen?: boolean; filePanelWidth?: number }) {
    const state = await this.readState()
    const next = { ...state }
    if (typeof patch.sidebarOpen === "boolean") next.sidebarOpen = patch.sidebarOpen
    if (typeof patch.sidebarWidth === "number" && Number.isFinite(patch.sidebarWidth)) next.sidebarWidth = validSidebarWidth(patch.sidebarWidth)
    if (typeof patch.filesOpen === "boolean") next.filesOpen = patch.filesOpen
    if (typeof patch.filePanelWidth === "number" && Number.isFinite(patch.filePanelWidth)) next.filePanelWidth = validFilePanelWidth(patch.filePanelWidth)
    await this.writeState(next)
    return this.overview()
  }

  async sessions(path: string, offset: number, limit: number) {
    const state = await this.readState()
    const projectPath = state.projects.find((item) => samePath(item, path))
    if (!projectPath) throw new Error("Project is not registered in Rind Desktop.")
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0
    const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(maxSessionPageLimit, limit)) : sessionPageLimit
    const sessions = (await readSessionIndex(this.sessionIndexFile))
      .filter((session) => session.hasUserMessage)
      .filter((session) => samePath(session.workspaceRoot, projectPath))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return { sessions: sessions.slice(safeOffset, safeOffset + safeLimit), total: sessions.length }
  }

  async markRecent(sessionId: string): Promise<DesktopProjectOverview> {
    const next = this.recentWrite.then(() => this.markRecentNow(sessionId))
    this.recentWrite = next.then(() => undefined, () => undefined)
    return next
  }

  async recentPage(offset = 0, limit = 10) {
    const [state, sessions] = await Promise.all([this.readState(), readSessionIndex(this.sessionIndexFile)])
    const recent = await this.recentSessions(state, sessions)
    const start = Number.isInteger(offset) ? Math.max(0, offset) : 0
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 10
    return { sessions: recent.slice(start, start + count), total: recent.length }
  }

  private async markRecentNow(sessionId: string): Promise<DesktopProjectOverview> {
    const cleanId = sessionId.trim()
    if (!cleanId) return this.overview()
    const [state, sessions] = await Promise.all([this.readState(), readSessionIndex(this.sessionIndexFile)])
    const session = sessions.find((item) => item.id === cleanId && this.sessionBelongsToProjects(item, state.projects))
    if (!session) return this.overview()
    const next = [{ session_id: session.id, last_interacted_at: new Date().toISOString() }]
    for (const item of this.normalizeRecentRecords(state.recentSessions, state.projects, sessions)) {
      if (item.session_id !== session.id) next.push(item)
    }
    await this.writeState({ ...state, recentSessions: next.slice(0, recentDesktopSessionLimit) })
    return this.overview()
  }

  async isActive(path: string) {
    const state = await this.readState()
    return Boolean(state.activeProjectPath && samePath(state.activeProjectPath, path))
  }

  async findSession(sessionId: string) {
    const cleanId = sessionId.trim()
    if (!cleanId) return undefined
    const state = await this.readState()
    return (await readSessionIndex(this.sessionIndexFile)).find((session) => session.id === cleanId && this.sessionBelongsToProjects(session, state.projects))
  }

  private async readState(): Promise<StoredProjectState> {
    const [raw, shared, legacyRecentSessions] = await Promise.all([
      readJsonObject(this.configFile),
      readSharedWorkspaces(this.rindHome, this.configFile),
      this.readLegacyRecentSessions(),
    ])
    const rawProjects = Array.isArray(raw.projects) ? raw.projects.filter((item): item is string => typeof item === "string") : []
    const legacyWorkspace = typeof raw.workspace === "string" ? raw.workspace : ""
    const configProjects = uniquePaths([...rawProjects, legacyWorkspace].filter(Boolean).map(storedPath))
    const projects = shared.exists ? shared.projects : configProjects
    const requestedActive = shared.exists
      ? shared.activeProjectPath
      : typeof raw.activeProjectPath === "string"
        ? raw.activeProjectPath
        : legacyWorkspace
    const activeProjectPath = projects.find((path) => samePath(path, requestedActive)) || projects.at(0) || ""
    const state: StoredProjectState = {
      projects,
      activeProjectPath,
      recentSessions: mergeRecentRecords([
        ...parseRecentRecords(raw.recentSessions),
        ...(legacyRecentSessions || []),
      ]),
      sidebarOpen: raw.sidebarOpen === undefined ? raw.sidebarCollapsed !== true : raw.sidebarOpen === true,
      sidebarWidth: validSidebarWidth(raw.sidebarWidth),
      filesOpen: raw.filesOpen === true,
      filePanelWidth: validFilePanelWidth(storedFilePanelWidth(raw)),
      theme: themes.includes(raw.theme as DesktopTheme) ? raw.theme as DesktopTheme : "system",
      notificationsEnabled: raw.notificationsEnabled === undefined ? true : raw.notificationsEnabled === true,
    }
    if (needsMigration(raw, state) || legacyRecentSessions || !shared.exists) {
      await this.writeState(state)
      if (legacyRecentSessions) await unlink(this.legacyRecentSessionsFile)
    }
    return state
  }

  private async writeState(state: StoredProjectState) {
    await Promise.all([
      writeJsonObject(this.configFile, {
        projects: state.projects,
        activeProjectPath: state.activeProjectPath,
        recentSessions: state.recentSessions,
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        filesOpen: state.filesOpen,
        filePanelWidth: state.filePanelWidth,
        theme: state.theme,
        notificationsEnabled: state.notificationsEnabled,
      }),
      writeSharedWorkspaces(this.rindHome, {
        projects: state.projects,
        activeProjectPath: state.activeProjectPath,
      }),
    ])
  }

  private sessionBelongsToProjects(session: DesktopSessionSummary, projects: string[]) {
    return session.hasUserMessage && projects.some((path) => samePath(path, session.workspaceRoot))
  }

  private async recentSessions(state: StoredProjectState, sessions: DesktopSessionSummary[]): Promise<DesktopRecentSession[]> {
    const normalized = this.normalizeRecentRecords(state.recentSessions, state.projects, sessions)
    if (JSON.stringify(state.recentSessions) !== JSON.stringify(normalized)) {
      await this.writeState({ ...state, recentSessions: normalized })
    }
    const visited = new Map(normalized.map((record) => [record.session_id, record.last_interacted_at]))
    return sessions.filter((session) => this.sessionBelongsToProjects(session, state.projects))
      .map((session) => ({ ...session, lastInteractedAt: [Number.isFinite(Date.parse(session.updatedAt)) ? session.updatedAt : "", visited.get(session.id) || ""].sort().at(-1) || "" }))
      .sort((left, right) => right.lastInteractedAt.localeCompare(left.lastInteractedAt))
  }

  private async readLegacyRecentSessions(): Promise<StoredRecentSession[] | undefined> {
    try {
      await stat(this.legacyRecentSessionsFile)
    } catch {
      return undefined
    }
    const raw = await readJsonObject(this.legacyRecentSessionsFile)
    return parseRecentRecords(raw.sessions)
  }

  private normalizeRecentRecords(records: StoredRecentSession[], projects: string[], sessions: DesktopSessionSummary[]) {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    const newestBySession = new Map<string, StoredRecentSession>()
    for (const record of records) {
      const session = sessionsById.get(record.session_id)
      if (!session || !this.sessionBelongsToProjects(session, projects)) continue
      const previous = newestBySession.get(record.session_id)
      if (!previous || record.last_interacted_at > previous.last_interacted_at) newestBySession.set(record.session_id, record)
    }
    return [...newestBySession.values()]
      .sort((left, right) => right.last_interacted_at.localeCompare(left.last_interacted_at) || left.session_id.localeCompare(right.session_id))
      .slice(0, recentDesktopSessionLimit)
  }
}

function needsMigration(raw: Record<string, unknown>, state: StoredProjectState) {
  return raw.workspace !== undefined
    || raw.activeProjectPath !== state.activeProjectPath
    || JSON.stringify(raw.recentSessions) !== JSON.stringify(state.recentSessions)
    || raw.sidebarOpen !== state.sidebarOpen
    || raw.sidebarWidth !== state.sidebarWidth
    || raw.sidebarCollapsed !== undefined
    || raw.filesOpen !== state.filesOpen
    || raw.filePanelWidth !== state.filePanelWidth
    || raw.fileTreeWidth !== undefined
    || raw.filePreviewWidth !== undefined
    || raw.theme !== state.theme
    || raw.notificationsEnabled !== state.notificationsEnabled
    || JSON.stringify(raw.projects) !== JSON.stringify(state.projects)
}

function parseRecentRecords(value: unknown): StoredRecentSession[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const session = asObject(item)
    const sessionId = typeof session?.session_id === "string" ? session.session_id.trim() : ""
    const lastInteractedAt = typeof session?.last_interacted_at === "string" ? session.last_interacted_at : ""
    if (sessionId && Number.isFinite(Date.parse(lastInteractedAt))) return [{ session_id: sessionId, last_interacted_at: lastInteractedAt }]
    return []
  })
}

function mergeRecentRecords(records: StoredRecentSession[]) {
  const newestBySession = new Map<string, StoredRecentSession>()
  for (const record of records) {
    const previous = newestBySession.get(record.session_id)
    if (!previous || record.last_interacted_at > previous.last_interacted_at) newestBySession.set(record.session_id, record)
  }
  return [...newestBySession.values()]
    .sort((left, right) => right.last_interacted_at.localeCompare(left.last_interacted_at) || left.session_id.localeCompare(right.session_id))
}

const SIDEBAR_MIN = 232
const SIDEBAR_MAX = 360
const SIDEBAR_DEFAULT = 264
function validSidebarWidth(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(value))) : SIDEBAR_DEFAULT }
function validFilePanelWidth(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.max(280, Math.min(900, Math.round(value))) : 480 }

function storedFilePanelWidth(raw: Record<string, unknown>) {
  if (typeof raw.filePanelWidth === "number") return raw.filePanelWidth
  const treeWidth = typeof raw.fileTreeWidth === "number" ? raw.fileTreeWidth : 0
  const previewWidth = typeof raw.filePreviewWidth === "number" ? raw.filePreviewWidth : 0
  return treeWidth && previewWidth ? treeWidth + previewWidth + 8 : treeWidth
}
