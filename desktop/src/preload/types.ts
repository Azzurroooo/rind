export type RuntimeStatus = "starting" | "ready" | "error" | "stopped"

export type RuntimeSnapshot = {
  status: RuntimeStatus
  runtimeId?: string
  message?: string
  workspace?: string
  sessionId?: string
}

export type RuntimeEvent = {
  runtimeId: string
  type: string
  sequence: number
  sessionId: string
  turnId: string
  event: Record<string, unknown>
}

export type RuntimeMethod =
  | "session.list"
  | "session.new"
  | "session.switch"
  | "session.replay"
  | "turn.start"
  | "turn.steer"
  | "turn.follow_up"
  | "turn.interrupt"
  | "user_question.respond"
  | "models.list"
  | "model.set"
  | "compact"
  | "slash.execute"

export type DesktopSettings = {
  model: string
  baseUrl: string
  reasoningEffort: string
  hasApiKey: boolean
}

export type DesktopSettingsPatch = {
  apiKey?: string
  model?: string
  baseUrl?: string
  reasoningEffort?: string
}

export type DesktopSessionSummary = {
  id: string
  title: string
  preview: string
  updatedAt: string
  workspaceRoot: string
  hasUserMessage: boolean
}

export type DesktopRecentSession = DesktopSessionSummary & {
  lastInteractedAt: string
}

export type DesktopProject = {
  path: string
  name: string
  available: boolean
  sessions: DesktopSessionSummary[]
  totalSessions: number
}

export type DesktopProjectOverview = {
  projects: DesktopProject[]
  recentSessions: DesktopRecentSession[]
  activeProjectPath: string
  sidebarOpen: boolean
  sidebarWidth: number
  filesOpen: boolean
  filePanelWidth: number
}

export type DesktopFileNode = {
  name: string
  path: string
  kind: "directory" | "file"
}

export type DesktopFileListing = {
  path: string
  entries: DesktopFileNode[]
  truncated: boolean
}

export type DesktopFilePreview = {
  path: string
  name: string
  kind: "text" | "image" | "unsupported"
  size: number
  content?: string
  dataUrl?: string
  mimeType?: string
  truncated?: boolean
  message?: string
}

export type DesktopApi = {
  runtime: {
    start: (runtimeId: string, workspace: string, sessionId?: string) => Promise<RuntimeSnapshot>
    initialize: (runtimeId: string) => Promise<unknown>
    request: (runtimeId: string, method: RuntimeMethod, params?: Record<string, unknown>) => Promise<unknown>
    shutdown: (runtimeId: string) => Promise<unknown>
    shutdownAll: () => Promise<unknown>
    subscribe: (listener: (snapshot: RuntimeSnapshot) => void) => () => void
    subscribeEvents: (listener: (event: RuntimeEvent) => void) => () => void
  }
  settings: {
    get: () => Promise<DesktopSettings>
    save: (patch: DesktopSettingsPatch) => Promise<DesktopSettings>
  }
  projects: {
    get: () => Promise<DesktopProjectOverview>
    add: () => Promise<DesktopProjectOverview | null>
    select: (path: string) => Promise<DesktopProjectOverview>
    remove: (path: string) => Promise<DesktopProjectOverview>
    markRecent: (sessionId: string) => Promise<DesktopProjectOverview>
    updateLayout: (patch: { sidebarOpen?: boolean; sidebarWidth?: number; filesOpen?: boolean; filePanelWidth?: number }) => Promise<DesktopProjectOverview>
    sessions: (path: string, offset: number, limit: number) => Promise<{ sessions: DesktopSessionSummary[]; total: number }>
  }
  sessions: {
    replay: (sessionId: string) => Promise<{ messages: unknown[]; sessionId: string }>
  }
  files: {
    list: (projectPath: string, path?: string) => Promise<DesktopFileListing>
    preview: (projectPath: string, path: string) => Promise<DesktopFilePreview>
  }
  quit: () => Promise<void>
  platform: string
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
