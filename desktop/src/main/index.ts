import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification } from "electron"
import log from "electron-log/main"
import windowState from "electron-window-state"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { DesktopAuthPrompt, DesktopAuthUpdate, DesktopPrefsPatch, DesktopTheme, RuntimeEvent, RuntimeSnapshot } from "../preload/types"
import { asObject, readJsonObject } from "./json-store"
import { listAvailableModels } from "./model-catalog"
import { listProjectFiles, previewProjectFile } from "./project-files"
import { DesktopProjectStore, samePath } from "./projects"
import { loadRuntimeSettings as loadSharedRuntimeSettings, resolveRindPaths, saveRuntimeSettings as saveSharedRuntimeSettings } from "./runtime-settings"
import { readRindVersion } from "./version"
import { wrapRuntimeIpcError } from "../shared/ipc-error"
import { DesktopGateway } from "./gateway/server"
import { allowGatewayOnWindows } from "./gateway/firewall"
import { workspaceFileRequest } from "./gateway/files"
import type { GatewayOptions } from "../preload/types"
import { isDesktopRuntimeMethod, isRemoteRuntimeMethod } from "./method-policy"
import {
  getRuntimeSnapshot,
  initializeRuntime,
  requestRuntime,
  respondAuthPrompt,
  subscribeAuthPrompts,
  subscribeAuthUpdates,
  shutdownRuntime,
  startRuntime,
  subscribeRuntime,
  subscribeRuntimeEvents,
} from "./runtime"
import {
  closeManagement,
  createAgentSession,
  enrichSessionReplayParams,
  forwardControlToSharedRuntimeIfNeeded,
  getManagementState,
  isManagedWorkspacePath,
  openAgentSession,
  requestManagement,
  subscribeManagement,
  subscribeSharedRuntimeEvents,
  type ManagementStatePayload,
} from "./management"

const appId = "ai.rind.desktop"
const root = dirname(fileURLToPath(import.meta.url))
const themes: DesktopTheme[] = ["system", "dark", "light"]
const themeSurfaces = {
  dark: { background: "#151d18", overlay: { color: "#151d18", symbolColor: "#a5b0a4" } },
  light: { background: "#f7f6f0", overlay: { color: "#f7f6f0", symbolColor: "#64685e" } },
} as const

let mainWindow: BrowserWindow | undefined
let desktopProjectStore: DesktopProjectStore | undefined
let quitting = false
let runtimeShutdownComplete = false
let windowFocused = false
let remoteGateway: DesktopGateway | undefined

function gateway() {
  remoteGateway ||= new DesktopGateway({
    initialize: initializeRuntime,
    request: async (method, params) => {
      if (!isRemoteRuntimeMethod(method)) throw new Error("Unsupported remote method.")
      const nextParams = method === "session/replay"
        ? await enrichSessionReplayParams(String(params.session_id || ""), params)
        : params
      try {
        return await requestRuntime(method, nextParams)
      } catch (error: any) {
        if (error?.name === "TurnNotActive" || error?.name === "QuestionNotFound") {
          const forwarded = await forwardControlToSharedRuntimeIfNeeded(method, nextParams)
          if (forwarded !== undefined) return forwarded
        }
        throw error
      }
    },
    subscribe: (listener) => {
      const offDirect = subscribeRuntimeEvents(listener)
      const offShared = subscribeSharedRuntimeEvents(listener)
      return () => {
        offDirect()
        offShared()
      }
    },
    agentsRequest: (method, params) => requestManagement(method, params),
    subscribeAgents: subscribeManagement,
  }, app.isPackaged ? join(process.resourcesPath, "web") : join(app.getAppPath(), "../frontend-web/dist"),
  (state) => mainWindow?.webContents.send("gateway-changed", state))
  return remoteGateway
}

function configPath() {
  return join(app.getPath("userData"), "desktop-settings.json")
}

function normalizeTheme(value: unknown): DesktopTheme {
  return themes.includes(value as DesktopTheme) ? value as DesktopTheme : "system"
}

function resolvedTheme(theme: DesktopTheme) {
  if (theme !== "system") return theme
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function applyThemeSurface(theme: DesktopTheme) {
  nativeTheme.themeSource = theme
  const resolved = resolvedTheme(theme)
  const surfaces = themeSurfaces[resolved]
  if (mainWindow) {
    mainWindow.setBackgroundColor(surfaces.background)
    if (process.platform === "win32" && mainWindow.setTitleBarOverlay) {
      try {
        mainWindow.setTitleBarOverlay({ ...surfaces.overlay, height: 44 })
      } catch {
        // Title bar overlays are unavailable on some Linux/Windows configurations.
      }
    }
  }
}

function notifyThemeChanged(theme: DesktopTheme) {
  mainWindow?.webContents.send("theme-changed", theme)
}

function rindHomeDir() {
  return resolveRindPaths(process.env.RIND_HOME ? undefined : join(app.getPath("home"), ".rind")).rindHome
}

function runtimeSettingsPath() {
  return join(rindHomeDir(), "settings.json")
}

function sessionIndexPath() {
  return join(rindHomeDir(), "session_index.json")
}

function appVersion() {
  return app.isPackaged ? app.getVersion() : readRindVersion(join(app.getAppPath(), "..", "agent", "version.py"))
}

function legacyRecentSessionsPath() {
  return join(rindHomeDir(), "desktop", "recent-sessions.json")
}

async function loadRuntimeSettings() {
  return loadSharedRuntimeSettings(rindHomeDir())
}

async function saveRuntimeSettings(value: unknown) {
  return saveSharedRuntimeSettings(value, rindHomeDir())
}

function projectStore() {
  desktopProjectStore ||= new DesktopProjectStore(configPath(), sessionIndexPath(), legacyRecentSessionsPath())
  return desktopProjectStore
}

async function chooseProject() {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
  if (result.canceled || !result.filePaths[0]) return null
  return projectStore().add(result.filePaths[0])
}

async function requireProject(path: unknown) {
  if (typeof path !== "string" || !path.trim()) throw new Error("Project path is required.")
  const overview = await projectStore().overview()
  const project = overview.projects.find((item) => samePath(item.path, path))
  if (project) {
    if (!project.available) throw new Error("The selected project folder is unavailable.")
    return project.path
  }
  if (await isManagedWorkspacePath(path.trim())) {
    return path.trim()
  }
  throw new Error("Choose a registered project before browsing files.")
}

function registerIpc() {
  ipcMain.handle("gateway-get", () => gateway().state())
  ipcMain.handle("gateway-start", (_event, options: GatewayOptions) => gateway().start(options))
  ipcMain.handle("gateway-stop", async () => { await gateway().stop(); return gateway().state() })
  ipcMain.handle("gateway-rotate", () => gateway().rotate())
  ipcMain.handle("gateway-allow-network", async () => {
    const current = gateway().state()
    if (!current.running || current.scope !== "lan") throw new Error("Enable local-network access first.")
    await allowGatewayOnWindows(process.execPath, current.port)
    return gateway().state()
  })
  ipcMain.handle("runtime-start", async (_event, workspace: unknown) => {
    const projectPath = await requireProject(workspace)
    return startRuntime(projectPath)
  })
  ipcMain.handle("runtime-initialize", () => initializeRuntime())
  ipcMain.handle("runtime-shutdown", () => shutdownRuntime())
  ipcMain.handle("runtime-request", async (_event, method: unknown, params: unknown) => {
    if (!isDesktopRuntimeMethod(method)) {
      throw new Error("Runtime method is not available to the desktop client.")
    }
    let safeParams = params && typeof params === "object" ? params as Record<string, unknown> : {}
    if (method === "session/replay") {
      safeParams = await enrichSessionReplayParams(String(safeParams.session_id || ""), safeParams)
    }
    // Return worker errors as a wrapped envelope instead of rejecting: Electron
    // prints a full stack for every rejected ipcMain.handle, which turned
    // expected races (e.g. TurnNotActive after a turn finished) into alarming
    // console noise. The preload bridge unwraps and re-throws for the renderer.
    try {
      return await requestRuntime(method, safeParams)
    } catch (error: any) {
      if (error?.name === "TurnNotActive" || error?.name === "QuestionNotFound") {
        try {
          const forwarded = await forwardControlToSharedRuntimeIfNeeded(method, safeParams)
          if (forwarded !== undefined) return forwarded
        } catch (sharedError) {
          return wrapRuntimeIpcError(sharedError)
        }
      }
      return wrapRuntimeIpcError(error)
    }
  })
  ipcMain.handle("agents-request", async (_event, method: unknown, params: unknown) => {
    const safeParams = params && typeof params === "object" ? params as Record<string, unknown> : {}
    try {
      return await requestManagement(String(method || ""), safeParams)
    } catch (error) {
      return wrapRuntimeIpcError(error)
    }
  })
  ipcMain.handle("agents-open-session", async (_event, params: unknown) => {
    const safeParams = params && typeof params === "object" ? params as Record<string, unknown> : {}
    try {
      return await openAgentSession(safeParams)
    } catch (error) {
      return wrapRuntimeIpcError(error)
    }
  })
  ipcMain.handle("agents-create-session", async (_event, params: unknown) => {
    const safeParams = params && typeof params === "object" ? params as Record<string, unknown> : {}
    try {
      return await createAgentSession(safeParams)
    } catch (error) {
      return wrapRuntimeIpcError(error)
    }
  })
  ipcMain.handle("auth-prompt-respond", async (_event, requestId: unknown, value: unknown) => {
    try {
      return await respondAuthPrompt(requestId, value)
    } catch (error) {
      return wrapRuntimeIpcError(error)
    }
  })
  ipcMain.handle("settings-get", () => loadRuntimeSettings())
  ipcMain.handle("app-version", () => appVersion())
  ipcMain.handle("settings-save", (_event, settings: unknown) => saveRuntimeSettings(settings))
  ipcMain.handle("models-list", async () => listAvailableModels(await readJsonObject(runtimeSettingsPath())))
  ipcMain.handle("projects-get", () => projectStore().overview())
  ipcMain.handle("projects-add", () => chooseProject())
  ipcMain.handle("projects-select", (_event, path: unknown) => {
    if (typeof path !== "string") throw new Error("Project path must be a string.")
    return projectStore().select(path)
  })
  ipcMain.handle("projects-remove", async (_event, path: unknown) => {
    if (typeof path !== "string") throw new Error("Project path must be a string.")
    const overview = await projectStore().remove(path)
    return overview
  })
  ipcMain.handle("projects-recent-page", (_event, offset: number, limit?: number) => projectStore().recentPage(offset, limit))
  ipcMain.handle("projects-mark-recent", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string") throw new Error("Session id must be a string.")
    return projectStore().markRecent(sessionId)
  })
  ipcMain.handle("projects-layout-update", (_event, patch: unknown) => {
    const input = asObject(patch)
    if (!input) throw new Error("Layout settings must be an object.")
    return projectStore().updateLayout({
      sidebarOpen: input.sidebarOpen as boolean | undefined,
      sidebarWidth: input.sidebarWidth as number | undefined,
      filesOpen: input.filesOpen as boolean | undefined,
      filePanelWidth: input.filePanelWidth as number | undefined,
    })
  })
  ipcMain.handle("projects-sessions", (_event, path: unknown, offset: unknown, limit: unknown) => {
    if (typeof path !== "string") throw new Error("Project path must be a string.")
    return projectStore().sessions(path, Number(offset), Number(limit))
  })
  ipcMain.handle("project-files-list", async (_event, projectPath: unknown, path: unknown) => listProjectFiles(await requireProject(projectPath), path))
  ipcMain.handle("project-files-preview", async (_event, projectPath: unknown, path: unknown) => previewProjectFile(await requireProject(projectPath), path))
  ipcMain.handle("project-files-upload", async (_event, projectPath: unknown, path: unknown, contentBase64: unknown) => workspaceFileRequest(await requireProject(projectPath), "file/write", { path, content_base64: contentBase64 }))
  ipcMain.handle("prefs-update", async (_event, patch: unknown) => {
    const input = asObject(patch)
    if (!input) throw new Error("Preferences must be an object.")
    const prefs: DesktopPrefsPatch = {}
    if (Object.hasOwn(input, "theme")) prefs.theme = normalizeTheme(input.theme)
    if (Object.hasOwn(input, "notificationsEnabled")) {
      if (typeof input.notificationsEnabled !== "boolean") throw new Error("notificationsEnabled must be a boolean.")
      prefs.notificationsEnabled = input.notificationsEnabled
    }
    const overview = await projectStore().updatePrefs(prefs)
    applyThemeSurface(overview.theme)
    notifyThemeChanged(overview.theme)
    return overview
  })
  ipcMain.handle("notify", async (_event, payload: unknown) => {
    const record = asObject(payload)
    if (!record) return false
    const enabled = (await projectStore().overview()).notificationsEnabled
    if (!enabled) return false
    return showDesktopNotification(record)
  })
  ipcMain.handle("app-quit", () => app.quit())
}

function createMainWindow() {
  const state = windowState({ defaultWidth: 1320, defaultHeight: 860 })
  const isMac = process.platform === "darwin"
  const isWin = process.platform === "win32"
  const resolved = resolvedTheme(nativeTheme.themeSource)
  const surfaces = themeSurfaces[resolved]
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    title: "Rind",
    autoHideMenuBar: true,
    backgroundColor: surfaces.background,
    icon: join(root, "../../resources/icon.png"),
    ...(isMac && {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 14, y: 15 },
    }),
    ...(isWin && {
      titleBarStyle: "hidden",
      titleBarOverlay: { ...surfaces.overlay, height: 44 },
    }),
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
  win.webContents.once("did-finish-load", () => {
    const snapshot = getRuntimeSnapshot()
    if (snapshot) notifyRuntime(snapshot)
    notifyAgentsState(getManagementState())
  })
  win.on("focus", () => { windowFocused = true })
  win.on("blur", () => { windowFocused = false })
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined
  })
  mainWindow = win
  return win
}

function notifyRuntime(snapshot: RuntimeSnapshot) {
  if (["stopping", "stopped", "error"].includes(snapshot.status)) void remoteGateway?.stop()
  mainWindow?.webContents.send("runtime-status", snapshot)
}

function notifyRuntimeEvent(event: RuntimeEvent) {
  mainWindow?.webContents.send("runtime-event", event)
}

function notifyAgentsState(state: ManagementStatePayload) {
  mainWindow?.webContents.send("agents-state", state)
}

function notifyAuthPrompt(prompt: DesktopAuthPrompt) {
  if (mainWindow) {
    mainWindow.webContents.send("auth-prompt", prompt)
    return
  }
  // No window can answer: cancel so the worker does not wait for the timeout.
  void respondAuthPrompt(prompt.requestId, "").catch((error) => log.warn("auth prompt cancel failed", error))
}

function notifyAuthUpdate(update: DesktopAuthUpdate) {
  mainWindow?.webContents.send("auth-update", update)
}

function showDesktopNotification(payload: { title?: unknown; body?: unknown; sessionId?: unknown }) {
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "Rind"
  const body = typeof payload.body === "string" ? payload.body : ""
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : ""
  if (!Notification.isSupported()) return false
  // Never interrupt a focused window; notifications are for background turns.
  if (mainWindow && !mainWindow.isDestroyed() && (mainWindow.isFocused() || windowFocused)) return false
  const notification = new Notification({ title, body: body.slice(0, 200), silent: false })
  notification.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      if (sessionId) mainWindow.webContents.send("notification-activate", sessionId)
    }
    notification.close()
  })
  notification.show()
  return true
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
    subscribeRuntime(notifyRuntime)
    subscribeRuntimeEvents(notifyRuntimeEvent)
    subscribeSharedRuntimeEvents(notifyRuntimeEvent)
    subscribeManagement(notifyAgentsState)
    subscribeAuthPrompts(notifyAuthPrompt)
    subscribeAuthUpdates(notifyAuthUpdate)
    registerIpc()
    try {
      const overview = await projectStore().overview()
      nativeTheme.themeSource = overview.theme
      const workspace = overview.activeProjectPath || process.cwd()
      startRuntime(workspace)
      await initializeRuntime()
    } catch (error) {
      log.warn("runtime worker failed to start", error)
    }
    nativeTheme.on("updated", () => {
      if (mainWindow && !mainWindow.isDestroyed()) applyThemeSurface(nativeTheme.themeSource)
      notifyThemeChanged(nativeTheme.themeSource as DesktopTheme)
    })
    createMainWindow()
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  app.on("before-quit", (event) => {
    if (runtimeShutdownComplete) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void (async () => {
      await remoteGateway?.stop()
      await closeManagement()
      await shutdownRuntime()
    })().finally(() => {
      runtimeShutdownComplete = true
      app.quit()
    })
  })
}
