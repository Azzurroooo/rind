import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, Notification, type NativeImage } from "electron"
import log from "electron-log/main"
import windowState from "electron-window-state"
import { existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { DesktopAuthPrompt, DesktopAuthUpdate, DesktopPrefsPatch, DesktopTheme, DesktopUpdateState, RuntimeEvent, RuntimeSnapshot } from "../preload/types"
import { asObject, readJsonObject } from "./json-store"
import { listAvailableModels } from "./model-catalog"
import { listProjectFiles, previewProjectFile } from "./project-files"
import { DesktopProjectStore, samePath } from "./projects"
import { loadRuntimeSettings as loadSharedRuntimeSettings, resolveRindPaths, saveRuntimeSettings as saveSharedRuntimeSettings } from "./runtime-settings"
import { readRindVersion } from "./version"
import { DesktopUpdater } from "./updater"
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

const appId = app.isPackaged ? "ai.rind.desktop" : "ai.rind.desktop.dev"
const root = dirname(fileURLToPath(import.meta.url))
const legacyUserDataDir = join(app.getPath("appData"), "rind-desktop")
if (existsSync(legacyUserDataDir)) {
  app.setPath("userData", legacyUserDataDir)
}
if (process.platform === "win32") {
  app.setAppUserModelId(appId)
}

const RIND_LOGO_DATA_URL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#243d2e"/><path d="M22 4h2a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-2Z" fill="#d6df9a"/></svg>',
  )

let cachedWindowIcon: NativeImage | null = null
let cachedDockIcon: NativeImage | null = null

function resourceDirs(): string[] {
  const dirs = [
    join(root, "../../resources"),
    join( process.cwd(), "resources"),
  ]
  try {
    dirs.unshift(join(app.getAppPath(), "resources"))
  } catch {
    // app.getAppPath() may not be ready in all contexts
  }
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    dirs.unshift(join(process.resourcesPath, "resources"), process.resourcesPath)
  }
  return Array.from(new Set(dirs))
}

function resolveWindowIconPath(): string | undefined {
  const filenames = process.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png", "icon.ico"]
  for (const dir of resourceDirs()) {
    for (const name of filenames) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function cleanupStaleDevStartMenuShortcut() {
  if (process.platform !== "win32" || app.isPackaged) return
  try {
    const shortcutPath = join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Rind.lnk")
    if (existsSync(shortcutPath)) {
      rmSync(shortcutPath, { force: true })
    }
  } catch {
    // Non-fatal if Start Menu folder is read-only.
  }
}

function resolveWindowIcon(purpose: "window" | "dock" = "window"): NativeImage | undefined {
  if (purpose === "window" && cachedWindowIcon && !cachedWindowIcon.isEmpty()) return cachedWindowIcon
  if (purpose === "dock" && cachedDockIcon && !cachedDockIcon.isEmpty()) return cachedDockIcon

  const filenames =
    process.platform === "win32" && purpose === "window"
      ? ["icon.ico", "icon.png"]
      : ["icon.png", "icon.ico"]

  for (const dir of resourceDirs()) {
    for (const name of filenames) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      const img = nativeImage.createFromPath(candidate)
      if (img.isEmpty()) continue
      if (name.endsWith(".png") && purpose === "window") {
        const size = img.getSize()
        if (size.width > 256 || size.height > 256) {
          const resized = img.resize({ width: 256, height: 256, quality: "best" })
          if (!resized.isEmpty()) {
            cachedWindowIcon = resized
            return resized
          }
        }
      }
      if (purpose === "dock") cachedDockIcon = img
      else cachedWindowIcon = img
      return img
    }
  }

  const fallback = nativeImage.createFromDataURL(RIND_LOGO_DATA_URL)
  if (!fallback.isEmpty()) {
    if (purpose === "dock") cachedDockIcon = fallback
    else cachedWindowIcon = fallback
    return fallback
  }
  return undefined
}

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
let desktopUpdater: DesktopUpdater | undefined

function updater() {
  desktopUpdater ||= new DesktopUpdater({
    currentVersion: appVersion(),
    isPackaged: app.isPackaged,
    onStateChange: notifyUpdateState,
    quiesceServices: async () => {
      await remoteGateway?.stop()
      await closeManagement()
      await shutdownRuntime()
      runtimeShutdownComplete = true
    },
  })
  return desktopUpdater
}

function gateway() {
  remoteGateway ||= new DesktopGateway({
    initialize: async () => {
      const initialized = asObject(await initializeRuntime()) || {}
      const overview = await projectStore().overview().catch(() => null)
      const availableProjects = (overview?.projects || []).filter((item) => item.available)
      const registeredWorkspaces = availableProjects.map((item) => item.path)
      const currentWs = typeof initialized.workspace_root === "string" ? initialized.workspace_root.trim() : ""
      const runtimeDir = join(rindHomeDir(), "runtime")
      const matchedProject = currentWs
        ? availableProjects.find((item) => samePath(item.path, currentWs))
        : undefined
      const activeProject = overview?.activeProjectPath
        ? availableProjects.find((item) => samePath(item.path, overview.activeProjectPath))
        : undefined
      const preferredProject = matchedProject || activeProject || availableProjects[0]
      if (preferredProject) {
        const nextSessionId = matchedProject
          ? initialized.session_id
          : (preferredProject.sessions[0]?.id || "")
        return {
          ...initialized,
          workspace_root: preferredProject.path,
          session_id: nextSessionId,
          workspaces: registeredWorkspaces,
        }
      }
      const isInternalOrManaged =
        !currentWs ||
        samePath(currentWs, runtimeDir) ||
        (await isManagedWorkspacePath(currentWs))
      return {
        ...initialized,
        ...(isInternalOrManaged ? { workspace_root: "", session_id: "" } : {}),
        workspaces: registeredWorkspaces,
      }
    },
    request: async (method, params) => {
      if (!isRemoteRuntimeMethod(method)) throw new Error("Unsupported remote method.")
      const nextParams = method === "session/replay"
        ? await enrichSessionReplayParams(String(params.session_id || ""), params)
        : params
      try {
        if (method === "session/list") {
          const overview = await projectStore().overview().catch(() => null)
          const availableProjects = (overview?.projects || []).filter((item) => item.available)
          const registeredWorkspaces = availableProjects.map((item) => item.path)
          const requestedWs = typeof params.workspace_root === "string" ? params.workspace_root.trim() : ""
          const matchedProject = requestedWs
            ? availableProjects.find((item) => samePath(item.path, requestedWs))
            : (overview?.activeProjectPath
                ? availableProjects.find((item) => samePath(item.path, overview.activeProjectPath))
                : undefined) || availableProjects[0]
          if (!matchedProject) {
            return { sessions: [], workspaces: registeredWorkspaces }
          }
          const result = await requestRuntime(method, {
            ...nextParams,
            workspace_root: matchedProject.path,
          })
          const rawSessions =
            result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).sessions)
              ? ((result as Record<string, unknown>).sessions as Array<Record<string, unknown>>)
              : []
          const filteredSessions = rawSessions.filter((s) => {
            const ws = typeof s?.workspace_root === "string" ? s.workspace_root.trim() : ""
            return Boolean(ws && samePath(ws, matchedProject.path))
          })
          return {
            ...(result && typeof result === "object" ? (result as Record<string, unknown>) : {}),
            sessions: filteredSessions,
            workspaces: registeredWorkspaces,
          }
        }
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
    settingsLoad: loadRuntimeSettings,
    settingsSave: saveRuntimeSettings,
  }, app.isPackaged ? join(process.resourcesPath, "web") : join(app.getAppPath(), "../frontend-web/dist"),
  (state) => mainWindow?.webContents.send("gateway-changed", state))
  return remoteGateway
}

function configPath() {
  const rindDesktopConfig = join(legacyUserDataDir, "desktop-settings.json")
  if (existsSync(rindDesktopConfig)) return rindDesktopConfig
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
  const overview = await projectStore().add(result.filePaths[0])
  remoteGateway?.notifyWorkspacesChanged()
  return overview
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
    remoteGateway?.notifyWorkspacesChanged()
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
  ipcMain.handle("update-get-state", () => updater().getState())
  ipcMain.handle("update-check", () => updater().checkForUpdates())
  ipcMain.handle("update-apply", () => updater().applyUpdate())
}

function createMainWindow() {
  const state = windowState({ defaultWidth: 1320, defaultHeight: 860 })
  const isMac = process.platform === "darwin"
  const isWin = process.platform === "win32"
  const resolved = resolvedTheme(nativeTheme.themeSource)
  const surfaces = themeSurfaces[resolved]
  const windowIconPath = resolveWindowIconPath()
  const windowIcon = resolveWindowIcon("window")
  const effectiveIcon = (isWin && windowIconPath) ? windowIconPath : (windowIcon || windowIconPath)
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: Math.max(860, state.width || 1320),
    height: Math.max(560, state.height || 860),
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: "Rind",
    autoHideMenuBar: true,
    backgroundColor: surfaces.background,
    ...(effectiveIcon && { icon: effectiveIcon }),
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
  const applyWinIcon = () => {
    if (isMac || win.isDestroyed()) return
    try {
      if (windowIcon && !windowIcon.isEmpty()) {
        win.setIcon(windowIcon)
      } else if (isWin && windowIconPath) {
        win.setIcon(windowIconPath)
      }
      if (isWin && typeof win.setOverlayIcon === "function") {
        win.setOverlayIcon(null, "")
      }
    } catch {
      // Ignore platform-specific setIcon errors
    }
  }
  applyWinIcon()
  state.manage(win)
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void win.loadURL(new URL("index.html", rendererUrl).toString())
  else void win.loadFile(join(root, "../renderer/index.html"))
  win.once("ready-to-show", () => {
    win.show()
    applyWinIcon()
  })
  win.on("show", applyWinIcon)
  win.webContents.once("did-finish-load", () => {
    applyWinIcon()
    const snapshot = getRuntimeSnapshot()
    if (snapshot) notifyRuntime(snapshot)
    notifyAgentsState(getManagementState())
    notifyUpdateState(updater().getState())
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

function notifyUpdateState(state: DesktopUpdateState) {
  mainWindow?.webContents.send("update-state", state)
}

function showDesktopNotification(payload: { title?: unknown; body?: unknown; sessionId?: unknown }) {
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "Rind"
  const body = typeof payload.body === "string" ? payload.body : ""
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : ""
  if (!Notification.isSupported()) return false
  // Never interrupt a focused window; notifications are for background turns.
  if (mainWindow && !mainWindow.isDestroyed() && (mainWindow.isFocused() || windowFocused)) return false
  const icon = resolveWindowIcon("window")
  const notification = new Notification({
    title,
    body: body.slice(0, 200),
    silent: false,
    ...(icon && !icon.isEmpty() ? { icon } : {}),
  })
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
    if (existsSync(legacyUserDataDir)) {
      app.setPath("userData", legacyUserDataDir)
    }
    if (process.platform === "win32") {
      cleanupStaleDevStartMenuShortcut()
      app.setAppUserModelId(appId)
    }
    if (process.platform === "darwin" && app.dock) {
      const dockIcon = resolveWindowIcon("dock")
      if (dockIcon && !dockIcon.isEmpty()) {
        try {
          app.dock.setIcon(dockIcon)
        } catch {
          // Ignore dock icon errors in headless environments
        }
      }
    }
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
    void updater().initialize().catch((error) => log.warn("update check failed", error))
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
