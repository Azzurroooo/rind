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
  sessionList: "session/list",
  sessionNew: "session/new",
  sessionSwitch: "session/switch",
  sessionReplay: "session/replay",
  sessionPrompt: "session/prompt",
  sessionSteer: "rind/session/steer",
  sessionFollowUp: "rind/session/follow_up",
  sessionPromoteFollowUp: "rind/session/promote_follow_up",
  sessionUnsteer: "rind/session/unsteer",
  sessionDequeueFollowUp: "rind/session/dequeue_follow_up",
  sessionCancel: "session/cancel",
  userQuestionRespond: "rind/user-question/respond",
  modelList: "model/list",
  modelSet: "model/set",
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
  runtimeMethods.sessionSwitch,
  runtimeMethods.sessionCancel,
  runtimeMethods.modelSet,
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
    start: (workspace: string) => Promise<RuntimeSnapshot>
    initialize: () => Promise<unknown>
    request: (method: RuntimeMethod, params?: Record<string, unknown>) => Promise<unknown>
    shutdown: () => Promise<unknown>
    subscribe: (listener: (snapshot: RuntimeSnapshot) => void) => () => void
    subscribeEvents: (listener: (event: RuntimeEvent) => void) => () => void
  }
  settings: {
    get: () => Promise<DesktopSettings>
    save: (patch: DesktopSettingsPatch) => Promise<DesktopSettings>
  }
  models: {
    list: () => Promise<string[]>
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
