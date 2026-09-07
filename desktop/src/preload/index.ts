import { contextBridge, ipcRenderer } from "electron"

import { runtimeMethods, type DesktopApi, type DesktopNotificationPayload, type DesktopPrefsPatch, type DesktopTheme, type RuntimeEvent, type RuntimeSnapshot } from "./types"

const api: DesktopApi = {
  runtime: {
    start: (workspace) => ipcRenderer.invoke("runtime-start", workspace),
    initialize: () => ipcRenderer.invoke("runtime-initialize"),
    request: (method, params = {}) => ipcRenderer.invoke("runtime-request", method, params),
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
  settings: {
    get: (workspace) => ipcRenderer.invoke("settings-get", workspace),
    save: (patch, workspace) => ipcRenderer.invoke("settings-save", patch, workspace),
  },
  models: {
    list: (workspace) => ipcRenderer.invoke("models-list", workspace),
    setEffort: (sessionId, effort) => ipcRenderer.invoke("runtime-request", runtimeMethods.modelEffort, { session_id: sessionId, reasoning_effort: effort }),
  },
  sessions: {
    remove: (sessionId) => ipcRenderer.invoke("runtime-request", runtimeMethods.sessionDelete, { session_id: sessionId }),
  },
  workspaceFiles: {
    list: (path = "") => ipcRenderer.invoke("runtime-request", runtimeMethods.fileList, { path }),
    read: (path) => ipcRenderer.invoke("runtime-request", runtimeMethods.fileRead, { path }),
    write: (path, contentBase64) => ipcRenderer.invoke("runtime-request", runtimeMethods.fileWrite, { path, content_base64: contentBase64 }),
  },
  background: {
    list: (sessionId) => ipcRenderer.invoke("runtime-request", runtimeMethods.backgroundList, { session_id: sessionId }),
    output: (sessionId, bgId, maxOutputChars = 20_000) => ipcRenderer.invoke("runtime-request", runtimeMethods.backgroundOutput, { session_id: sessionId, bg_id: bgId, max_output_chars: maxOutputChars }),
  },
  goal: {
    get: (sessionId) => ipcRenderer.invoke("runtime-request", runtimeMethods.goalGet, { session_id: sessionId }),
    set: (sessionId, objective) => ipcRenderer.invoke("runtime-request", runtimeMethods.goalSet, { session_id: sessionId, objective }),
    status: (sessionId, status) => ipcRenderer.invoke("runtime-request", runtimeMethods.goalStatus, { session_id: sessionId, status }),
    clear: (sessionId) => ipcRenderer.invoke("runtime-request", runtimeMethods.goalClear, { session_id: sessionId }),
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
