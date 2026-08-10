export type RuntimeStatus = "starting" | "ready" | "error" | "stopped"

export type RuntimeSnapshot = {
  status: RuntimeStatus
  message?: string
}

export type DesktopApi = {
  runtime: {
    initialize: () => Promise<unknown>
    shutdown: () => Promise<unknown>
    subscribe: (listener: (snapshot: RuntimeSnapshot) => void) => () => void
  }
  openDirectory: () => Promise<string | null>
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
