import { readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import type { DesktopProject, DesktopProjectOverview, DesktopSessionSummary } from "../preload/types"
import { asObject, readJsonObject, writeJsonObject } from "./json-store.ts"

const recentSessionLimit = 5
const sessionPageLimit = 20
const maxSessionPageLimit = 50

type StoredProjectState = {
  projects: string[]
  activeProjectPath: string
  sidebarOpen: boolean
  sidebarWidth: number
  filesOpen: boolean
  filePanelWidth: number
}

export class DesktopProjectStore {
  private readonly configFile: string
  private readonly sessionIndexFile: string

  constructor(
    configFile: string,
    sessionIndexFile: string,
  ) {
    this.configFile = configFile
    this.sessionIndexFile = sessionIndexFile
  }

  async overview(): Promise<DesktopProjectOverview> {
    const state = await this.readState()
    const projects = await Promise.all(state.projects.map((path) => this.projectSummary(path)))
    return {
      projects,
      activeProjectPath: state.activeProjectPath,
      sidebarOpen: state.sidebarOpen,
      sidebarWidth: state.sidebarWidth,
      filesOpen: state.filesOpen,
      filePanelWidth: state.filePanelWidth,
    }
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
    const sessions = (await this.readSessionIndex())
      .filter((session) => session.hasUserMessage)
      .filter((session) => samePath(session.workspaceRoot, projectPath))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return { sessions: sessions.slice(safeOffset, safeOffset + safeLimit), total: sessions.length }
  }

  async isActive(path: string) {
    const state = await this.readState()
    return Boolean(state.activeProjectPath && samePath(state.activeProjectPath, path))
  }

  async findSession(sessionId: string) {
    const cleanId = sessionId.trim()
    if (!cleanId) return undefined
    const state = await this.readState()
    const projects = new Set(state.projects.map((path) => process.platform === "win32" ? path.toLocaleLowerCase() : path))
    return (await this.readSessionIndex()).find((session) => {
      const workspace = process.platform === "win32" ? session.workspaceRoot.toLocaleLowerCase() : session.workspaceRoot
      return session.id === cleanId && session.hasUserMessage && projects.has(workspace)
    })
  }

  private async projectSummary(path: string): Promise<DesktopProject> {
    const available = await isDirectory(path)
    const sessions = (await this.readSessionIndex())
      .filter((session) => session.hasUserMessage)
      .filter((session) => samePath(session.workspaceRoot, path))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return {
      path,
      name: basename(path) || path,
      available,
      sessions: sessions.slice(0, recentSessionLimit),
      totalSessions: sessions.length,
    }
  }

  private async readState(): Promise<StoredProjectState> {
    const raw = await readJsonObject(this.configFile)
    const rawProjects = Array.isArray(raw.projects) ? raw.projects.filter((item): item is string => typeof item === "string") : []
    const legacyWorkspace = typeof raw.workspace === "string" ? raw.workspace : ""
    const projects = uniquePaths([...rawProjects, legacyWorkspace].filter(Boolean).map(storedPath))
    const requestedActive = typeof raw.activeProjectPath === "string" ? raw.activeProjectPath : legacyWorkspace
    const activeProjectPath = projects.find((path) => samePath(path, requestedActive)) || projects.at(0) || ""
    const state: StoredProjectState = {
      projects,
      activeProjectPath,
      sidebarOpen: raw.sidebarOpen === undefined ? raw.sidebarCollapsed !== true : raw.sidebarOpen === true,
      sidebarWidth: validSidebarWidth(raw.sidebarWidth),
      filesOpen: raw.filesOpen === true,
      filePanelWidth: validFilePanelWidth(storedFilePanelWidth(raw)),
    }
    if (needsMigration(raw, state)) await this.writeState(state)
    return state
  }

  private async writeState(state: StoredProjectState) {
    await writeJsonObject(this.configFile, {
      projects: state.projects,
      activeProjectPath: state.activeProjectPath,
      sidebarOpen: state.sidebarOpen,
      sidebarWidth: state.sidebarWidth,
      filesOpen: state.filesOpen,
      filePanelWidth: state.filePanelWidth,
    })
  }

  private async readSessionIndex(): Promise<DesktopSessionSummary[]> {
    const index = await readJsonObject(this.sessionIndexFile)
    if (!Array.isArray(index.sessions)) return []
    const sessions = index.sessions.flatMap((value) => {
      const session = asObject(value)
      if (!session) return []
      const id = typeof session.id === "string" ? session.id : ""
      const workspaceRoot = typeof session.workspace_root === "string" ? session.workspace_root : ""
      if (!id || !workspaceRoot) return []
      return [{
        id,
        title: typeof session.title === "string" ? session.title : "Untitled",
        preview: typeof session.preview === "string" ? session.preview : "",
        updatedAt: typeof session.updated_at === "string" ? session.updated_at : "",
        workspaceRoot: storedPath(workspaceRoot),
        hasUserMessage: session.has_user_message === true,
        hasUserMessageMarker: typeof session.has_user_message === "boolean",
      }]
    })
    return Promise.all(sessions.map(async (session) => ({
      ...session,
      hasUserMessage: session.hasUserMessageMarker
        ? session.hasUserMessage
        : await hasPersistedUserMessage(dirname(this.sessionIndexFile), session.id),
    }))).then((items) => items.map(({ hasUserMessageMarker: _marker, ...session }) => session))
  }
}

function needsMigration(raw: Record<string, unknown>, state: StoredProjectState) {
  return raw.workspace !== undefined
    || raw.activeProjectPath !== state.activeProjectPath
    || raw.sidebarOpen !== state.sidebarOpen
    || raw.sidebarWidth !== state.sidebarWidth
    || raw.sidebarCollapsed !== undefined
    || raw.filesOpen !== state.filesOpen
    || raw.filePanelWidth !== state.filePanelWidth
    || raw.fileTreeWidth !== undefined
    || raw.filePreviewWidth !== undefined
    || JSON.stringify(raw.projects) !== JSON.stringify(state.projects)
}

function validSidebarWidth(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.max(180, Math.min(420, Math.round(value))) : 248 }
function validFilePanelWidth(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.max(280, Math.min(900, Math.round(value))) : 480 }

function storedFilePanelWidth(raw: Record<string, unknown>) {
  if (typeof raw.filePanelWidth === "number") return raw.filePanelWidth
  const treeWidth = typeof raw.fileTreeWidth === "number" ? raw.fileTreeWidth : 0
  const previewWidth = typeof raw.filePreviewWidth === "number" ? raw.filePreviewWidth : 0
  return treeWidth && previewWidth ? treeWidth + previewWidth + 8 : treeWidth
}

function storedPath(path: string) {
  return resolve(path.trim())
}

function uniquePaths(paths: string[]) {
  return paths.filter((path, index) => paths.findIndex((item) => samePath(item, path)) === index)
}

export function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function canonicalDirectory(path: string) {
  const canonicalPath = await realpath(path)
  if (!(await stat(canonicalPath)).isDirectory()) throw new Error("Project path must be an existing directory.")
  return canonicalPath
}

async function hasPersistedUserMessage(rindHome: string, sessionId: string) {
  try {
    const messages = await readFile(join(rindHome, "sessions", sessionId, "messages.jsonl"), "utf8")
    return messages.split(/\r?\n/).some((line) => {
      if (!line.trim()) return false
      try {
        const message = asObject(JSON.parse(line))
        return message?.role === "user" && typeof message.content === "string" && message.content.trim().length > 0
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}
