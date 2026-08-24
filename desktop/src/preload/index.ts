import { contextBridge, ipcRenderer } from "electron"

import type { DesktopApi, RuntimeEvent, RuntimeSnapshot } from "./types"

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
