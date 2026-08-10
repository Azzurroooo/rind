import { app, BrowserWindow, dialog, ipcMain } from "electron"
import log from "electron-log/main"
import windowState from "electron-window-state"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { DesktopSettings, DesktopSettingsPatch, RuntimeEvent, RuntimeSnapshot } from "../preload/types"
import {
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
const maxSettingLength = 4096

function configPath() {
  return join(app.getPath("userData"), "desktop-settings.json")
}

function runtimeSettingsPath() {
  return join(app.getPath("home"), ".rind", "settings.json")
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

async function readJsonObject(path: string) {
  try {
    const value = asObject(JSON.parse(await readFile(path, "utf8")))
    if (!value) throw new Error("Expected a JSON object.")
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot read Rind settings at ${path}: ${message}`)
  }
}

async function writeJsonObject(path: string, value: Record<string, unknown>) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2) + "\n", "utf8")
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

function publicSettings(data: Record<string, unknown>): DesktopSettings {
  return {
    model: asTrimmedString(data.model),
    baseUrl: asTrimmedString(data.baseUrl),
    reasoningEffort: asTrimmedString(data.reasoningEffort),
    hasApiKey: Boolean(asTrimmedString(data.apiKey)),
  }
}

function validateSettingsPatch(value: unknown): DesktopSettingsPatch {
  const input = asObject(value)
  if (!input) throw new Error("Settings must be an object.")
  const patch: DesktopSettingsPatch = {}
  const keys: Array<keyof DesktopSettingsPatch> = ["apiKey", "model", "baseUrl", "reasoningEffort"]
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) continue
    if (typeof input[key] !== "string") throw new Error(`${key} must be a string.`)
    const setting = input[key].trim()
    if (setting.length > maxSettingLength) throw new Error(`${key} is too long.`)
    patch[key] = setting
  }
  if (patch.baseUrl) {
    let url: URL
    try {
      url = new URL(patch.baseUrl)
    } catch {
      throw new Error("baseUrl must be a valid HTTP URL.")
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("baseUrl must be a valid HTTP URL.")
    }
  }
  return patch
}

async function loadRuntimeSettings() {
  return publicSettings(await readJsonObject(runtimeSettingsPath()))
}

async function saveRuntimeSettings(value: unknown) {
  const patch = validateSettingsPatch(value)
  const path = runtimeSettingsPath()
  const data = await readJsonObject(path)
  for (const [key, setting] of Object.entries(patch)) {
    if (key === "apiKey" && !setting) continue
    data[key] = setting
  }
  await writeJsonObject(path, data)
  return publicSettings(data)
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
  await writeJsonObject(configPath(), { workspace })
}

async function selectWorkspace() {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
  if (result.canceled || !result.filePaths[0]) return null
  const workspace = result.filePaths[0]
  await saveWorkspace(workspace)
  configuredWorkspace = workspace
  await shutdownRuntime()
  startRuntime(workspace)
  return workspace
}

function registerIpc() {
  ipcMain.handle("runtime-initialize", () => initializeRuntime())
  ipcMain.handle("runtime-restart", async () => {
    if (!configuredWorkspace) throw new Error("Choose a workspace before starting Rind.")
    await shutdownRuntime()
    startRuntime(configuredWorkspace)
  })
  ipcMain.handle("runtime-shutdown", () => shutdownRuntime())
  ipcMain.handle("runtime-request", (_event, method: unknown, params: unknown) => {
    if (typeof method !== "string" || !allowedRuntimeMethods.has(method)) {
      throw new Error("Runtime method is not available to the desktop client.")
    }
    const safeParams = params && typeof params === "object" ? params as Record<string, unknown> : {}
    return requestRuntime(method, safeParams)
  })
  ipcMain.handle("settings-get", () => loadRuntimeSettings())
  ipcMain.handle("settings-save", async (_event, settings: unknown) => {
    const saved = await saveRuntimeSettings(settings)
    if (configuredWorkspace) {
      await shutdownRuntime()
      startRuntime(configuredWorkspace)
    }
    return saved
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
    if (configuredWorkspace) startRuntime(configuredWorkspace)
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
