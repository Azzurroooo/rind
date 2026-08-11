import { contextBridge, ipcRenderer } from "electron"

import type { DesktopApi, RuntimeEvent, RuntimeSnapshot } from "./types"

const api: DesktopApi = {
  runtime: {
    initialize: () => ipcRenderer.invoke("runtime-initialize"),
    restart: () => ipcRenderer.invoke("runtime-restart"),
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
  files: {
    list: (path = "") => ipcRenderer.invoke("project-files-list", path),
    preview: (path) => ipcRenderer.invoke("project-files-preview", path),
  },
  quit: () => ipcRenderer.invoke("app-quit"),
}

contextBridge.exposeInMainWorld("api", api)
