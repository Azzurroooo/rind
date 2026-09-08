import { contextBridge, ipcRenderer } from "electron"

import { unwrapRuntimeIpcResult } from "../shared/ipc-error"
import { runtimeMethods, type DesktopApi, type DesktopFindResult, type DesktopNotificationPayload, type DesktopPrefsPatch, type DesktopTheme, type RuntimeEvent, type RuntimeSnapshot } from "./types"

// The main process returns worker errors as a wrapped envelope (never as a
// rejected ipcMain.handle) — unwrap here so renderer call sites keep their
// try/catch semantics with Error.name carrying the worker error type.
function runtimeRequest(method: string, params: Record<string, unknown> = {}) {
  return unwrapRuntimeIpcResult(ipcRenderer.invoke("runtime-request", method, params))
}

const api: DesktopApi = {
  runtime: {
    start: (workspace) => ipcRenderer.invoke("runtime-start", workspace),
    initialize: () => ipcRenderer.invoke("runtime-initialize"),
    request: (method, params = {}) => runtimeRequest(method, params),
    shutdown: () => ipcRenderer.invoke("runtime-shutdown"),
    subscribe: (listener) => {
      // Pull the current snapshot first (covers reloads and late subscribers),
      // then apply live pushes on top; both paths are idempotent.
      const handler = (_event: Electron.IpcRendererEvent, snapshot: RuntimeSnapshot) => listener(snapshot)
      ipcRenderer.on("runtime-status", handler)
      void ipcRenderer.invoke("runtime-snapshot").then((snapshot) => {
        if (snapshot) listener(snapshot as RuntimeSnapshot)
      })
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
    setEffort: (sessionId, effort) => runtimeRequest(runtimeMethods.modelEffort, { session_id: sessionId, reasoning_effort: effort }),
  },
  sessions: {
    remove: (sessionId) => runtimeRequest(runtimeMethods.sessionDelete, { session_id: sessionId }),
  },
  workspaceFiles: {
    list: (path = "") => runtimeRequest(runtimeMethods.fileList, { path }),
    read: (path) => runtimeRequest(runtimeMethods.fileRead, { path }),
    write: (path, contentBase64) => runtimeRequest(runtimeMethods.fileWrite, { path, content_base64: contentBase64 }),
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
  view: {
    zoom: (mode) => ipcRenderer.invoke("view-zoom", mode),
    find: (query, options) => ipcRenderer.invoke("view-find", query, options),
    findStop: () => ipcRenderer.invoke("view-find-stop"),
    onFindResult: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, result: DesktopFindResult) => listener(result)
      ipcRenderer.on("view-find-result", handler)
      return () => ipcRenderer.removeListener("view-find-result", handler)
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
    index: (projectPath) => ipcRenderer.invoke("project-files-index", projectPath),
  },
  quit: () => ipcRenderer.invoke("app-quit"),
  platform: process.platform,
}

contextBridge.exposeInMainWorld("api", api)
