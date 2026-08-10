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
  openDirectory: () => ipcRenderer.invoke("open-directory"),
  quit: () => ipcRenderer.invoke("app-quit"),
}

contextBridge.exposeInMainWorld("api", api)
