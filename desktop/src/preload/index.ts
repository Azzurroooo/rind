import { contextBridge, ipcRenderer } from "electron"

import { unwrapRuntimeIpcResult } from "../shared/ipc-error"
import { runtimeMethods, type DesktopApi, type DesktopAuthPrompt, type DesktopAuthUpdate, type DesktopNotificationPayload, type DesktopPrefsPatch, type DesktopTheme, type RuntimeEvent, type RuntimeSnapshot } from "./types"

// The main process returns worker errors as a wrapped envelope (never as a
// rejected ipcMain.handle) — unwrap here so renderer call sites keep their
// try/catch semantics with Error.name carrying the worker error type.
async function runtimeRequest(method: string, params: Record<string, unknown> = {}) {
  return unwrapRuntimeIpcResult(await ipcRenderer.invoke("runtime-request", method, params))
}

const api: DesktopApi = {
  gateway: {
    get: () => ipcRenderer.invoke("gateway-get"),
    start: (options) => ipcRenderer.invoke("gateway-start", options),
    stop: () => ipcRenderer.invoke("gateway-stop"),
    rotate: () => ipcRenderer.invoke("gateway-rotate"),
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on("gateway-changed", handler)
      return () => ipcRenderer.removeListener("gateway-changed", handler)
    },
  },
  runtime: {
    start: (workspace) => ipcRenderer.invoke("runtime-start", workspace),
    initialize: () => ipcRenderer.invoke("runtime-initialize"),
    request: (method, params = {}) => runtimeRequest(method, params),
    shutdown: () => ipcRenderer.invoke("runtime-shutdown"),
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: RuntimeSnapshot) => listener(snapshot)
      ipcRenderer.on("runtime-status", handler)
      return () => ipcRenderer.removeListener("runtime-status", handler)
    },
    subscribeEvents: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, event: RuntimeEvent) => listener(event)
      ipcRenderer.on("runtime-event", handler)
      return () => ipcRenderer.removeListener("runtime-event", handler)
    },
  },
  auth: {
    list: async () => {
      const result = await runtimeRequest(runtimeMethods.authList) as { providers?: unknown }
      return Array.isArray(result?.providers) ? result.providers : []
    },
    login: (sessionId, providerId, method = "api_key") => runtimeRequest(runtimeMethods.authLogin, { session_id: sessionId, provider_id: providerId, method }) as ReturnType<DesktopApi["auth"]["login"]>,
    logout: (providerId) => runtimeRequest(runtimeMethods.authLogout, { provider_id: providerId }),
    respond: async (requestId, value) => unwrapRuntimeIpcResult(await ipcRenderer.invoke("auth-prompt-respond", requestId, value)) as boolean,
    onPrompt: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, prompt: DesktopAuthPrompt) => listener(prompt)
      ipcRenderer.on("auth-prompt", handler)
      return () => ipcRenderer.removeListener("auth-prompt", handler)
    },
    onUpdate: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, update: DesktopAuthUpdate) => listener(update)
      ipcRenderer.on("auth-update", handler)
      return () => ipcRenderer.removeListener("auth-update", handler)
    },
  },
  settings: {
    get: (workspace) => ipcRenderer.invoke("settings-get", workspace),
    save: (patch, workspace) => ipcRenderer.invoke("settings-save", patch, workspace),
  },
  models: {
    list: (workspace) => ipcRenderer.invoke("models-list", workspace),
    setEffort: (sessionId, effort) => runtimeRequest(runtimeMethods.modelEffort, { session_id: sessionId, reasoning_effort: effort }),
  },
  sessions: {
    remove: (sessionId) => runtimeRequest(runtimeMethods.sessionDelete, { session_id: sessionId }),
  },
  workspaceFiles: {
    list: (path = "") => runtimeRequest(runtimeMethods.fileList, { path }),
    read: (path) => runtimeRequest(runtimeMethods.fileRead, { path }),
    write: (projectPath, path, contentBase64) => ipcRenderer.invoke("project-files-upload", projectPath, path, contentBase64),
  },
  background: {
    list: (sessionId) => runtimeRequest(runtimeMethods.backgroundList, { session_id: sessionId }),
    output: (sessionId, bgId, maxOutputChars = 20_000) => runtimeRequest(runtimeMethods.backgroundOutput, { session_id: sessionId, bg_id: bgId, max_output_chars: maxOutputChars }),
  },
  goal: {
    get: (sessionId) => runtimeRequest(runtimeMethods.goalGet, { session_id: sessionId }),
    set: (sessionId, objective) => runtimeRequest(runtimeMethods.goalSet, { session_id: sessionId, objective }),
    status: (sessionId, status) => runtimeRequest(runtimeMethods.goalStatus, { session_id: sessionId, status }),
    clear: (sessionId) => runtimeRequest(runtimeMethods.goalClear, { session_id: sessionId }),
  },
  notifications: {
    show: (payload: DesktopNotificationPayload) => ipcRenderer.invoke("notify", payload),
    onActivate: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => listener(sessionId)
      ipcRenderer.on("notification-activate", handler)
      return () => ipcRenderer.removeListener("notification-activate", handler)
    },
  },
  prefs: {
    update: (patch: DesktopPrefsPatch) => ipcRenderer.invoke("prefs-update", patch),
    onThemeChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, theme: DesktopTheme) => listener(theme)
      ipcRenderer.on("theme-changed", handler)
      return () => ipcRenderer.removeListener("theme-changed", handler)
    },
  },
  version: () => ipcRenderer.invoke("app-version"),
  projects: {
    get: () => ipcRenderer.invoke("projects-get"),
    add: () => ipcRenderer.invoke("projects-add"),
    select: (path) => ipcRenderer.invoke("projects-select", path),
    remove: (path) => ipcRenderer.invoke("projects-remove", path),
    markRecent: (sessionId) => ipcRenderer.invoke("projects-mark-recent", sessionId),
    updateLayout: (patch) => ipcRenderer.invoke("projects-layout-update", patch),
    sessions: (path, offset, limit) => ipcRenderer.invoke("projects-sessions", path, offset, limit),
  },
  files: {
    list: (projectPath, path = "") => ipcRenderer.invoke("project-files-list", projectPath, path),
    preview: (projectPath, path) => ipcRenderer.invoke("project-files-preview", projectPath, path),
  },
  quit: () => ipcRenderer.invoke("app-quit"),
  platform: process.platform,
}

contextBridge.exposeInMainWorld("api", api)
