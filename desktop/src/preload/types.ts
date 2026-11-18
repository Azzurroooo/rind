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
  /** Id of the worker process generation: sequence numbers reset per spawn. */
  generation?: number
}

import {
  clientRuntimeMethods as runtimeMethods,
  localOnlyRuntimeMethods,
  runtimeProtocolVersion,
  sessionScopedMethods,
  turnScopedMethods,
  type ClientRuntimeMethod as RuntimeMethod,
  type RuntimeErrorObject as RuntimeError,
  type RuntimeEventEnvelope,
  type RuntimeLifecycleMethod,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type RuntimeServerMethod,
} from "../../../runtime/dist/protocol/runtime-protocol.js"

export {
  localOnlyRuntimeMethods,
  runtimeMethods,
  runtimeProtocolVersion,
  sessionScopedMethods,
  turnScopedMethods,
  type RuntimeError,
  type RuntimeEventEnvelope,
  type RuntimeLifecycleMethod,
  type RuntimeMethod,
  type RuntimeRequestEnvelope,
  type RuntimeResponseEnvelope,
  type RuntimeServerMethod,
}

export type DesktopProviderAuthDetail = {
  type: "oauth" | "api_key"
  maskedKey?: string
  expiresAt?: number | null
}

export type DesktopCustomProvider = {
  id: string
  name: string
  api: string
  baseUrl: string
  envKey?: string
  models: string[]
}

export type DesktopSettings = {
  provider?: string
  model: string
  baseUrl: string
  reasoningEffort: string
  hasApiKey: boolean
  authDetails?: Record<string, DesktopProviderAuthDetail>
  customProviders?: DesktopCustomProvider[]
}

export type DesktopSettingsPatch = {
  provider?: string
  apiKey?: string
  model?: string
  baseUrl?: string
  reasoningEffort?: string
  customProvider?: {
    id?: string
    name: string
    api: string
    baseUrl: string
    defaultModel?: string
    apiKey?: string
    envKey?: string
  }
  deleteCustomProviderId?: string
  providerCredential?: {
    providerId: string
    apiKey: string
  }
  removeProviderCredentialId?: string
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
  recentSessionTotal: number
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
  /** True once the agent yielded the call; the process keeps running. */
  handoff?: boolean
  notify?: string
  command?: string
  elapsed_ms?: number
  exit_code?: number
  cwd?: string
  stdout?: string
  stderr?: string
  truncated?: boolean
  next_cursor?: string
  start_cursor?: string
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

export type DesktopAuthProvider = {
  id: string
  name: string
  methods: string[]
  configured: boolean
  source: string
}

export type DesktopAuthPromptKind = "select" | "secret" | "text"

export type DesktopAuthPrompt = {
  requestId: string
  kind: DesktopAuthPromptKind
  message: string
  options: readonly string[]
}

export type DesktopAuthUpdate = Record<string, unknown> & { type: string }

export type DesktopAuthLoginResult = {
  ok: boolean
  provider_id: string
  models_count?: number
  selection?: unknown
}

export type GatewayOptions = { scope: "loopback" | "lan"; port?: number; externalOrigin?: string }
export type GatewayState = { running: boolean; scope: "loopback" | "lan"; port: number; addresses: string[]; accessCode: string; clients: number }
export type DesktopUpdateState = { status: "idle" | "available" | "downloading" | "installing" | "error"; currentVersion: string; latestVersion: string; progress?: number; error?: string }

export type DesktopApi = {
  gateway: {
    get: () => Promise<GatewayState>
    start: (options: GatewayOptions) => Promise<GatewayState>
    stop: () => Promise<GatewayState>
    rotate: () => Promise<GatewayState>
    allowNetwork: () => Promise<GatewayState>
    subscribe: (listener: (state: GatewayState) => void) => () => void
  }
  runtime: {
    start: (workspace: string) => Promise<RuntimeSnapshot>
    initialize: () => Promise<unknown>
    request: (method: RuntimeMethod, params?: Record<string, unknown>) => Promise<unknown>
    shutdown: () => Promise<unknown>
    subscribe: (listener: (snapshot: RuntimeSnapshot) => void) => () => void
    subscribeEvents: (listener: (event: RuntimeEvent) => void) => () => void
  }
  auth: {
    list: () => Promise<DesktopAuthProvider[]>
    login: (sessionId: string, providerId: string, method?: string) => Promise<DesktopAuthLoginResult>
    logout: (providerId: string) => Promise<unknown>
    respond: (requestId: string, value: string) => Promise<boolean>
    onPrompt: (listener: (prompt: DesktopAuthPrompt) => void) => () => void
    onUpdate: (listener: (update: DesktopAuthUpdate) => void) => () => void
  }
  settings: {
    get: () => Promise<DesktopSettings>
    save: (patch: DesktopSettingsPatch) => Promise<DesktopSettings>
  }
  models: {
    list: () => Promise<string[]>
    setEffort: (sessionId: string, effort: string) => Promise<unknown>
  }
  sessions: {
    remove: (sessionId: string) => Promise<unknown>
  }
  workspaceFiles: {
    write: (projectPath: string, path: string, contentBase64: string) => Promise<unknown>
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
    recentPage: (offset: number, limit?: number) => Promise<{ sessions: DesktopRecentSession[]; total: number }>
    updateLayout: (patch: { sidebarOpen?: boolean; sidebarWidth?: number; filesOpen?: boolean; filePanelWidth?: number }) => Promise<DesktopProjectOverview>
    sessions: (path: string, offset: number, limit: number) => Promise<{ sessions: DesktopSessionSummary[]; total: number }>
  }
  files: {
    list: (projectPath: string, path?: string) => Promise<DesktopFileListing>
    preview: (projectPath: string, path: string) => Promise<DesktopFilePreview>
  }
  agents: {
    request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
    openSession: (params: Record<string, unknown>) => Promise<unknown>
    createSession: (params: Record<string, unknown>) => Promise<unknown>
    subscribe: (listener: (state: Record<string, unknown>) => void) => () => void
  }
  quit: () => Promise<void>
  update: { getState: () => Promise<DesktopUpdateState>; check: () => Promise<DesktopUpdateState>; apply: () => Promise<DesktopUpdateState>; subscribe: (listener: (state: DesktopUpdateState) => void) => () => void }
  platform: string
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
