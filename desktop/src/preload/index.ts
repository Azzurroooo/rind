import { contextBridge, ipcRenderer } from "electron"

import type { DesktopApi, RuntimeSnapshot } from "./types"

const api: DesktopApi = {
  runtime: {
    initialize: () => ipcRenderer.invoke("runtime-initialize"),
    shutdown: () => ipcRenderer.invoke("runtime-shutdown"),
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: RuntimeSnapshot) => listener(snapshot)
      ipcRenderer.on("runtime-status", handler)
      return () => ipcRenderer.removeListener("runtime-status", handler)
    },
  },
  openDirectory: () => ipcRenderer.invoke("open-directory"),
}

contextBridge.exposeInMainWorld("api", api)
