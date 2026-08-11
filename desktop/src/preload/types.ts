export type RuntimeStatus = "starting" | "ready" | "error" | "stopped"

export type RuntimeSnapshot = {
  status: RuntimeStatus
  message?: string
  workspace?: string
}

export type RuntimeEvent = {
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

export type DesktopProject = {
  path: string
  name: string
  available: boolean
  sessions: DesktopSessionSummary[]
  totalSessions: number
}

export type DesktopProjectOverview = {
  projects: DesktopProject[]
  activeProjectPath: string
  sidebarOpen: boolean
  sidebarWidth: number
  filesOpen: boolean
  fileTreeWidth: number
  filePreviewWidth: number
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
    initialize: () => Promise<unknown>
    restart: () => Promise<void>
    request: (method: RuntimeMethod, params?: Record<string, unknown>) => Promise<unknown>
    shutdown: () => Promise<unknown>
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
    updateLayout: (patch: { sidebarOpen?: boolean; sidebarWidth?: number; filesOpen?: boolean; fileTreeWidth?: number; filePreviewWidth?: number }) => Promise<DesktopProjectOverview>
    sessions: (path: string, offset: number, limit: number) => Promise<{ sessions: DesktopSessionSummary[]; total: number }>
  }
  files: {
    list: (path?: string) => Promise<DesktopFileListing>
    preview: (path: string) => Promise<DesktopFilePreview>
  }
  quit: () => Promise<void>
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
