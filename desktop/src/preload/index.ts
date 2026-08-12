import { contextBridge, ipcRenderer } from "electron"

import type { DesktopApi, RuntimeEvent, RuntimeSnapshot } from "./types"

const api: DesktopApi = {
  runtime: {
    start: (runtimeId, workspace, sessionId) => ipcRenderer.invoke("runtime-start", runtimeId, workspace, sessionId),
    initialize: (runtimeId) => ipcRenderer.invoke("runtime-initialize", runtimeId),
    restart: (runtimeId, workspace, sessionId) => ipcRenderer.invoke("runtime-restart", runtimeId, workspace, sessionId),
    request: (runtimeId, method, params = {}) => ipcRenderer.invoke("runtime-request", runtimeId, method, params),
    shutdown: (runtimeId) => ipcRenderer.invoke("runtime-shutdown", runtimeId),
    shutdownAll: () => ipcRenderer.invoke("runtime-shutdown-all"),
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
    get: () => ipcRenderer.invoke("settings-get"),
    save: (patch) => ipcRenderer.invoke("settings-save", patch),
  },
  projects: {
    get: () => ipcRenderer.invoke("projects-get"),
    add: () => ipcRenderer.invoke("projects-add"),
    select: (path) => ipcRenderer.invoke("projects-select", path),
    remove: (path) => ipcRenderer.invoke("projects-remove", path),
    updateLayout: (patch) => ipcRenderer.invoke("projects-layout-update", patch),
    sessions: (path, offset, limit) => ipcRenderer.invoke("projects-sessions", path, offset, limit),
  },
  sessions: {
    replay: (sessionId) => ipcRenderer.invoke("sessions-replay", sessionId),
  },
  files: {
    list: (projectPath, path = "") => ipcRenderer.invoke("project-files-list", projectPath, path),
    preview: (projectPath, path) => ipcRenderer.invoke("project-files-preview", projectPath, path),
  },
  quit: () => ipcRenderer.invoke("app-quit"),
}

contextBridge.exposeInMainWorld("api", api)
