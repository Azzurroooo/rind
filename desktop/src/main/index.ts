import { app, BrowserWindow, dialog, ipcMain } from "electron"
import log from "electron-log/main"
import windowState from "electron-window-state"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { RuntimeSnapshot } from "../preload/types"
import {
  initializeRuntime,
  shutdownRuntime,
  startRuntime,
  subscribeRuntime,
} from "./runtime"

const appId = "ai.rind.desktop"
const root = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | undefined
let quitting = false

function registerIpc() {
  ipcMain.handle("runtime-initialize", () => initializeRuntime())
  ipcMain.handle("runtime-shutdown", () => shutdownRuntime())
  ipcMain.handle("open-directory", async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
}

function createMainWindow() {
  const state = windowState({ defaultWidth: 1100, defaultHeight: 720 })
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    title: "Rind",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  state.manage(win)
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void win.loadURL(new URL("index.html", rendererUrl).toString())
  } else {
    void win.loadFile(join(root, "../renderer/index.html"))
  }
  win.once("ready-to-show", () => win.show())
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined
  })
  mainWindow = win
  return win
}

function notifyRuntime(snapshot: RuntimeSnapshot) {
  mainWindow?.webContents.send("runtime-status", snapshot)
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  app.whenReady().then(() => {
    log.initialize()
    app.setName("Rind")
    app.setAppUserModelId(appId)
    subscribeRuntime(notifyRuntime)
    registerIpc()
    startRuntime()
    createMainWindow()
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  app.on("before-quit", (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void shutdownRuntime().finally(() => app.quit())
  })
}
