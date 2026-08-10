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
  openDirectory: () => Promise<string | null>
  quit: () => Promise<void>
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
