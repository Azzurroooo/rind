import { app, BrowserWindow, dialog, ipcMain } from "electron"
import log from "electron-log/main"
import windowState from "electron-window-state"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFile, writeFile } from "node:fs/promises"

import type { RuntimeEvent, RuntimeSnapshot } from "../preload/types"
import {
  getWorkspaceRoot,
  getRuntimeSnapshot,
  initializeRuntime,
  requestRuntime,
  shutdownRuntime,
  startRuntime,
  subscribeRuntime,
  subscribeRuntimeEvents,
} from "./runtime"

const appId = "ai.rind.desktop"
const root = dirname(fileURLToPath(import.meta.url))
const allowedRuntimeMethods = new Set([
  "session.list",
  "session.new",
  "session.switch",
  "session.replay",
  "turn.start",
  "turn.steer",
  "turn.follow_up",
  "turn.interrupt",
  "user_question.respond",
  "models.list",
  "model.set",
  "compact",
  "slash.execute",
])
let mainWindow: BrowserWindow | undefined
let quitting = false
let configuredWorkspace = ""

function configPath() {
  return join(app.getPath("userData"), "desktop-settings.json")
}

function runtimeHome() {
  return join(app.getPath("userData"), "rind-data")
}

async function loadWorkspace() {
  try {
    const raw = JSON.parse(await readFile(configPath(), "utf8")) as { workspace?: unknown }
    return typeof raw.workspace === "string" ? raw.workspace : ""
  } catch {
    return ""
  }
}

async function saveWorkspace(workspace: string) {
  await writeFile(configPath(), JSON.stringify({ workspace }, null, 2) + "\n", "utf8")
}

async function selectWorkspace() {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
  if (result.canceled || !result.filePaths[0]) return null
  const workspace = result.filePaths[0]
  await saveWorkspace(workspace)
  configuredWorkspace = workspace
  if (getWorkspaceRoot()) await shutdownRuntime()
  startRuntime(workspace, runtimeHome())
  return workspace
}

function registerIpc() {
  ipcMain.handle("runtime-initialize", () => initializeRuntime())
  ipcMain.handle("runtime-restart", async () => {
    if (!configuredWorkspace) throw new Error("Choose a workspace before starting Rind.")
    await shutdownRuntime()
    startRuntime(configuredWorkspace, runtimeHome())
  })
  ipcMain.handle("runtime-shutdown", () => shutdownRuntime())
  ipcMain.handle("runtime-request", (_event, method: unknown, params: unknown) => {
    if (typeof method !== "string" || !allowedRuntimeMethods.has(method)) {
      throw new Error("Runtime method is not available to the desktop client.")
    }
    const safeParams = params && typeof params === "object" ? params as Record<string, unknown> : {}
    return requestRuntime(method, safeParams)
  })
  ipcMain.handle("open-directory", () => selectWorkspace())
  ipcMain.handle("app-quit", () => app.quit())
}

function createMainWindow() {
  const state = windowState({ defaultWidth: 1200, defaultHeight: 800 })
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
  if (rendererUrl) void win.loadURL(new URL("index.html", rendererUrl).toString())
  else void win.loadFile(join(root, "../renderer/index.html"))
  win.once("ready-to-show", () => win.show())
  win.webContents.once("did-finish-load", () => notifyRuntime(getRuntimeSnapshot()))
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined
  })
  mainWindow = win
  return win
}

function notifyRuntime(snapshot: RuntimeSnapshot) {
  mainWindow?.webContents.send("runtime-status", snapshot)
}

function notifyRuntimeEvent(event: RuntimeEvent) {
  mainWindow?.webContents.send("runtime-event", event)
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  app.whenReady().then(async () => {
    log.initialize()
    app.setName("Rind")
    app.setAppUserModelId(appId)
    configuredWorkspace = await loadWorkspace()
    subscribeRuntime(notifyRuntime)
    subscribeRuntimeEvents(notifyRuntimeEvent)
    registerIpc()
    createMainWindow()
    if (configuredWorkspace) startRuntime(configuredWorkspace, runtimeHome())
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
