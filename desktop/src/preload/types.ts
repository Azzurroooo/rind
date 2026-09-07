export type RuntimeStatus = "starting" | "ready" | "stopping" | "error" | "stopped"

export type RuntimeSnapshot = {
  status: RuntimeStatus
  message?: string
}

export type RuntimeEvent = {
  type: string
  sequence: number
  durability: "durable" | "incremental"
  sessionId: string
  turnId: string
  event: Record<string, unknown>
}

export const runtimeProtocolVersion = "2"

export const runtimeMethods = {
  sessionNew: "session/new",
  sessionReplay: "session/replay",
  sessionPrompt: "session/prompt",
  sessionDelete: "session/delete",
  sessionSteer: "rind/session/steer",
  sessionFollowUp: "rind/session/follow_up",
  sessionPromoteFollowUp: "rind/session/promote_follow_up",
  sessionUnsteer: "rind/session/unsteer",
  sessionDequeueFollowUp: "rind/session/dequeue_follow_up",
  sessionCancel: "session/cancel",
  userQuestionRespond: "rind/user-question/respond",
  modelList: "model/list",
  modelSet: "model/set",
  modelEffort: "model/effort",
  fileRead: "file/read",
  fileList: "file/list",
  fileWrite: "file/write",
  sessionCompact: "rind/session/compact",
  commandExecute: "rind/command/execute",
  backgroundList: "rind/background/list",
  backgroundOutput: "rind/background/output",
  goalGet: "rind/goal/get",
  goalSet: "rind/goal/set",
  goalStatus: "rind/goal/status",
  goalClear: "rind/goal/clear",
} as const

export type RuntimeMethod = typeof runtimeMethods[keyof typeof runtimeMethods]
export type RuntimeLifecycleMethod = "initialize" | "shutdown"
export type RuntimeServerMethod = RuntimeMethod | RuntimeLifecycleMethod

export const sessionScopedMethods = new Set<RuntimeMethod>([
  runtimeMethods.sessionPrompt,
  runtimeMethods.sessionReplay,
  runtimeMethods.sessionCancel,
  runtimeMethods.sessionDelete,
  runtimeMethods.modelSet,
  runtimeMethods.modelEffort,
  runtimeMethods.sessionSteer,
  runtimeMethods.sessionFollowUp,
  runtimeMethods.sessionPromoteFollowUp,
  runtimeMethods.sessionUnsteer,
  runtimeMethods.sessionDequeueFollowUp,
  runtimeMethods.sessionCompact,
  runtimeMethods.commandExecute,
  runtimeMethods.userQuestionRespond,
  runtimeMethods.backgroundList,
  runtimeMethods.backgroundOutput,
  runtimeMethods.goalGet,
  runtimeMethods.goalSet,
  runtimeMethods.goalStatus,
  runtimeMethods.goalClear,
])

export const turnScopedMethods = new Set<RuntimeMethod>([
  runtimeMethods.sessionCancel,
  runtimeMethods.sessionSteer,
])

export type RuntimeRequestEnvelope = {
  kind: "request"
  request_id: string | number
  method: RuntimeServerMethod
  params: Record<string, unknown>
}

export type RuntimeError = {
  type: string
  message: string
}

export type RuntimeResponseEnvelope = {
  kind: "response"
  request_id: string | number
  result?: unknown
  error?: RuntimeError
}

export type RuntimeEventEnvelope = {
  kind: "event"
  method: "session/update"
  sequence: number
  durability: "durable" | "incremental"
  session_id: string
  turn_id: string
  event: Record<string, unknown>
}

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

export type DesktopTheme = "system" | "dark" | "light"

export type DesktopPrefsPatch = {
  theme?: DesktopTheme
  notificationsEnabled?: boolean
}

export type DesktopNotificationPayload = {
  title: string
  body?: string
  sessionId?: string
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
  theme: DesktopTheme
  notificationsEnabled: boolean
}

export type DesktopGoal = {
  objective: string
  status: string
}

export type DesktopBackgroundTask = {
  bg_id: string
  status: string
  exit_code?: number
  cwd?: string
  stdout?: string
  stderr?: string
  truncated?: boolean
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
    start: (workspace: string) => Promise<RuntimeSnapshot>
    initialize: () => Promise<unknown>
    request: (method: RuntimeMethod, params?: Record<string, unknown>) => Promise<unknown>
    shutdown: () => Promise<unknown>
    subscribe: (listener: (snapshot: RuntimeSnapshot) => void) => () => void
    subscribeEvents: (listener: (event: RuntimeEvent) => void) => () => void
  }
  settings: {
    get: (workspace?: string) => Promise<DesktopSettings>
    save: (patch: DesktopSettingsPatch, workspace?: string) => Promise<DesktopSettings>
  }
  models: {
    list: (workspace?: string) => Promise<string[]>
    setEffort: (sessionId: string, effort: string) => Promise<unknown>
  }
  sessions: {
    remove: (sessionId: string) => Promise<unknown>
  }
  workspaceFiles: {
    list: (path?: string) => Promise<unknown>
    read: (path: string) => Promise<unknown>
    write: (path: string, contentBase64: string) => Promise<unknown>
  }
  background: {
    list: (sessionId: string) => Promise<unknown>
    output: (sessionId: string, bgId: string, maxOutputChars?: number) => Promise<unknown>
  }
  goal: {
    get: (sessionId: string) => Promise<unknown>
    set: (sessionId: string, objective: string) => Promise<unknown>
    status: (sessionId: string, status: "active" | "paused") => Promise<unknown>
    clear: (sessionId: string) => Promise<unknown>
  }
  notifications: {
    show: (payload: DesktopNotificationPayload) => Promise<boolean>
    onActivate: (listener: (sessionId: string) => void) => () => void
  }
  prefs: {
    update: (patch: DesktopPrefsPatch) => Promise<DesktopProjectOverview>
    onThemeChanged: (listener: (theme: DesktopTheme) => void) => () => void
  }
  version: () => Promise<string>
  projects: {
    get: () => Promise<DesktopProjectOverview>
    add: () => Promise<DesktopProjectOverview | null>
    select: (path: string) => Promise<DesktopProjectOverview>
    remove: (path: string) => Promise<DesktopProjectOverview>
    markRecent: (sessionId: string) => Promise<DesktopProjectOverview>
    updateLayout: (patch: { sidebarOpen?: boolean; sidebarWidth?: number; filesOpen?: boolean; filePanelWidth?: number }) => Promise<DesktopProjectOverview>
    sessions: (path: string, offset: number, limit: number) => Promise<{ sessions: DesktopSessionSummary[]; total: number }>
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
