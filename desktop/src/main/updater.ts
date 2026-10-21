import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { createWriteStream, existsSync } from "node:fs"
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises"
import os from "node:os"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import type { DesktopUpdateState } from "../preload/types.ts"
import { asObject, readJsonObject, writeJsonObject } from "./json-store.ts"
import { resolveRindHome } from "./runtime-settings.ts"

export const DESKTOP_UPDATE_TTL_MS = 20 * 60 * 60 * 1000
export const DESKTOP_UPDATE_POLL_MS = 6 * 60 * 60 * 1000
const DEFAULT_MANIFEST_BASE_URL = "https://github.com/Azzurroooo/rind/releases"

export type DesktopChannelKind =
  | "desktop-dev"
  | "desktop-win-nsis"
  | "desktop-mac-dmg"
  | "desktop-linux-appimage"
  | "desktop-linux-deb"

export type DesktopChannelInfo = {
  channel: DesktopChannelKind
  target: string
  ext: string
  appImagePath: string
}

export type DesktopUpdateAsset = {
  name: string
  target: string
  bytes: number
  sha256: string
  url: string
}

export function parseSemver(version: unknown) {
  const clean = String(version ?? "").trim().replace(/^v/i, "")
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    raw: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ""}`,
  }
}

export function compareVersions(left: unknown, right: unknown): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return 0
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const partA = a.prerelease[i]
    const partB = b.prerelease[i]
    if (partA === undefined) return -1
    if (partB === undefined) return 1
    if (partA === partB) continue
    const numA = /^\d+$/.test(partA) ? Number(partA) : null
    const numB = /^\d+$/.test(partB) ? Number(partB) : null
    if (numA !== null && numB !== null) return numA > numB ? 1 : -1
    if (numA !== null) return -1
    if (numB !== null) return 1
    return partA > partB ? 1 : -1
  }
  return 0
}

export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  return Boolean(parseSemver(candidate) && parseSemver(current) && compareVersions(candidate, current) > 0)
}

export function resolveDesktopChannel({
  isPackaged = true,
  platform = process.platform,
  arch = process.arch,
  appImage = process.env.APPIMAGE || "",
}: {
  isPackaged?: boolean
  platform?: NodeJS.Platform
  arch?: string
  appImage?: string
} = {}): DesktopChannelInfo {
  if (!isPackaged) {
    return { channel: "desktop-dev", target: "", ext: "", appImagePath: "" }
  }
  if (platform === "win32") {
    return { channel: "desktop-win-nsis", target: "windows-x64", ext: ".exe", appImagePath: "" }
  }
  if (platform === "darwin") {
    return {
      channel: "desktop-mac-dmg",
      target: arch === "arm64" ? "macos-arm64" : "macos-x64",
      ext: ".dmg",
      appImagePath: "",
    }
  }
  if (platform === "linux") {
    const cleanAppImage = String(appImage || "").trim()
    if (cleanAppImage) {
      return {
        channel: "desktop-linux-appimage",
        target: "linux-x64",
        ext: ".AppImage",
        appImagePath: cleanAppImage,
      }
    }
    return { channel: "desktop-linux-deb", target: "linux-x64", ext: ".deb", appImagePath: "" }
  }
  return { channel: "desktop-dev", target: "", ext: "", appImagePath: "" }
}

export function selectDesktopAsset(
  manifest: Record<string, unknown>,
  channelInfo: DesktopChannelInfo,
  manifestBaseUrl = DEFAULT_MANIFEST_BASE_URL,
): DesktopUpdateAsset | null {
  if (!channelInfo.target || !channelInfo.ext) return null
  const version = String(manifest.version || "").trim().replace(/^v/i, "")
  if (!parseSemver(version) || !Array.isArray(manifest.assets)) return null
  const cleanBase = String(manifestBaseUrl).replace(/\/+$/, "")
  for (const item of manifest.assets) {
    const record = asObject(item)
    if (!record) continue
    const name = String(record.name || "").trim()
    if (
      record.product === "desktop" &&
      record.target === channelInfo.target &&
      name.endsWith(channelInfo.ext)
    ) {
      return {
        name,
        target: channelInfo.target,
        bytes: Number(record.bytes) || 0,
        sha256: String(record.sha256 || "").trim().toLowerCase(),
        url: typeof record.url === "string" && record.url.trim()
          ? record.url.trim()
          : `${cleanBase}/download/v${version}/${encodeURIComponent(name)}`,
      }
    }
  }
  return null
}

export async function downloadDesktopAsset(
  asset: DesktopUpdateAsset,
  destinationPath: string,
  {
    fetchImpl = globalThis.fetch,
    onProgress,
  }: {
    fetchImpl?: typeof fetch
    onProgress?: (percent: number) => void
  } = {},
): Promise<string> {
  await mkdir(dirname(destinationPath), { recursive: true })
  const response = await fetchImpl(asset.url, {
    headers: { "User-Agent": "rind-desktop-updater" },
  })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${asset.name} (HTTP ${response.status}).`)
  }
  const totalBytes = asset.bytes || Number(response.headers?.get?.("content-length")) || 0
  const hash = createHash("sha256")
  let received = 0
  let lastPercent = -1
  const out = createWriteStream(destinationPath)
  const stream = typeof (response.body as ReadableStream).getReader === "function"
    ? Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
    : (response.body as unknown as Readable)

  stream.on("data", (chunk: Buffer) => {
    received += chunk.length
    hash.update(chunk)
    if (totalBytes > 0 && onProgress) {
      const percent = Math.min(100, Math.round((received / totalBytes) * 100))
      if (percent !== lastPercent) {
        lastPercent = percent
        onProgress(percent)
      }
    }
  })

  await pipeline(stream, out)

  if (asset.bytes > 0 && received !== asset.bytes) {
    await rm(destinationPath, { force: true }).catch(() => {})
    throw new Error(`Downloaded size mismatch for ${asset.name}.`)
  }
  const actualSha = hash.digest("hex").toLowerCase()
  if (asset.sha256 && actualSha !== asset.sha256.toLowerCase()) {
    await rm(destinationPath, { force: true }).catch(() => {})
    throw new Error(`SHA256 verification failed for ${asset.name}.`)
  }
  return destinationPath
}

export type DesktopUpdaterOptions = {
  currentVersion: string
  isPackaged?: boolean
  platform?: NodeJS.Platform
  arch?: string
  appImage?: string
  rindHome?: string
  manifestBaseUrl?: string
  fetchImpl?: typeof fetch
  onStateChange?: (state: DesktopUpdateState) => void
  quiesceServices?: () => Promise<void>
  installAsset?: (assetPath: string, channelInfo: DesktopChannelInfo) => Promise<void>
}

export class DesktopUpdater {
  private readonly currentVersion: string
  private readonly channelInfo: DesktopChannelInfo
  private readonly cachePath: string
  private readonly manifestBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly onStateChange?: (state: DesktopUpdateState) => void
  private readonly quiesceServices: () => Promise<void>
  private readonly installAsset: (assetPath: string, channelInfo: DesktopChannelInfo) => Promise<void>
  private state: DesktopUpdateState
  private cachedAsset: DesktopUpdateAsset | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private checkPromise: Promise<DesktopUpdateState> | null = null

  constructor(options: DesktopUpdaterOptions) {
    this.currentVersion = options.currentVersion
    this.channelInfo = resolveDesktopChannel({
      isPackaged: options.isPackaged,
      platform: options.platform,
      arch: options.arch,
      appImage: options.appImage,
    })
    const home = resolveRindHome(options.rindHome)
    this.cachePath = join(home, "update-check.json")
    this.manifestBaseUrl = String(
      options.manifestBaseUrl || process.env.RIND_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_BASE_URL,
    ).replace(/\/+$/, "")
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.onStateChange = options.onStateChange
    this.quiesceServices = options.quiesceServices || (async () => {})
    this.installAsset = options.installAsset || defaultInstallDesktopAsset
    this.state = {
      status: "idle",
      currentVersion: this.currentVersion,
      latestVersion: this.currentVersion,
    }
  }

  getState(): DesktopUpdateState {
    return { ...this.state }
  }

  private setState(next: DesktopUpdateState) {
    this.state = next
    this.onStateChange?.(this.getState())
  }

  async initialize(now = Date.now()): Promise<DesktopUpdateState> {
    if (this.channelInfo.channel === "desktop-dev" || process.env.RIND_DISABLE_UPDATE_CHECK === "1") {
      return this.getState()
    }
    const cached = await readJsonObject(this.cachePath)
    const checkedAt = Number(cached.checkedAt) || 0
    const latestVersion = typeof cached.latestVersion === "string" ? cached.latestVersion.trim() : ""
    const rawAsset = asObject(cached.desktopAsset)
    if (
      latestVersion &&
      isNewerVersion(latestVersion, this.currentVersion) &&
      rawAsset &&
      rawAsset.target === this.channelInfo.target &&
      String(rawAsset.name || "").endsWith(this.channelInfo.ext)
    ) {
      this.cachedAsset = {
        name: String(rawAsset.name),
        target: String(rawAsset.target),
        bytes: Number(rawAsset.bytes) || 0,
        sha256: String(rawAsset.sha256 || "").toLowerCase(),
        url: String(rawAsset.url || `${this.manifestBaseUrl}/download/v${latestVersion}/${encodeURIComponent(String(rawAsset.name))}`),
      }
      this.setState({
        status: "available",
        currentVersion: this.currentVersion,
        latestVersion,
      })
    }

    if (!checkedAt || now - checkedAt >= DESKTOP_UPDATE_TTL_MS) {
      void this.checkForUpdates().catch(() => {})
    }

    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.checkIfExpired().catch(() => {})
      }, DESKTOP_UPDATE_POLL_MS)
      this.pollTimer.unref?.()
    }
    return this.getState()
  }

  dispose() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async checkIfExpired(now = Date.now()) {
    const cached = await readJsonObject(this.cachePath)
    const checkedAt = Number(cached.checkedAt) || 0
    if (!checkedAt || now - checkedAt >= DESKTOP_UPDATE_TTL_MS) {
      await this.checkForUpdates()
    }
  }

  async checkForUpdates(): Promise<DesktopUpdateState> {
    if (this.channelInfo.channel === "desktop-dev") return this.getState()
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      timer.unref?.()
      try {
        const response = await this.fetchImpl(`${this.manifestBaseUrl}/latest/download/release-manifest.json`, {
          headers: { Accept: "application/json", "User-Agent": "rind-desktop-updater" },
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const manifest = asObject(await response.json()) || {}
        const latestVersion = String(manifest.version || "").trim().replace(/^v/i, "")
        if (!parseSemver(latestVersion)) {
          throw new Error("Invalid version in release manifest.")
        }
        const asset = selectDesktopAsset(manifest, this.channelInfo, this.manifestBaseUrl)
        await writeJsonObject(this.cachePath, {
          checkedAt: Date.now(),
          latestVersion,
          ...(asset ? { desktopAsset: asset } : {}),
        }).catch(() => {})

        if (this.state.status === "downloading" || this.state.status === "installing") {
          return this.getState()
        }

        if (asset && isNewerVersion(latestVersion, this.currentVersion)) {
          this.cachedAsset = asset
          this.setState({
            status: "available",
            currentVersion: this.currentVersion,
            latestVersion,
          })
        } else {
          this.cachedAsset = null
          this.setState({
            status: "idle",
            currentVersion: this.currentVersion,
            latestVersion,
          })
        }
        return this.getState()
      } finally {
        clearTimeout(timer)
        this.checkPromise = null
      }
    })()
    return this.checkPromise
  }

  async applyUpdate(): Promise<DesktopUpdateState> {
    if (this.state.status === "downloading" || this.state.status === "installing") {
      return this.getState()
    }
    if (!this.cachedAsset) {
      await this.checkForUpdates()
    }
    const asset = this.cachedAsset
    if (!asset || !isNewerVersion(this.state.latestVersion, this.currentVersion)) {
      return this.getState()
    }
    const targetVersion = this.state.latestVersion
    const downloadPath = join(os.tmpdir(), "rind-desktop-update", asset.name)
    this.setState({
      status: "downloading",
      currentVersion: this.currentVersion,
      latestVersion: targetVersion,
      progress: 0,
    })

    try {
      await downloadDesktopAsset(asset, downloadPath, {
        fetchImpl: this.fetchImpl,
        onProgress: (progress) => {
          if (this.state.status === "downloading") {
            this.setState({
              status: "downloading",
              currentVersion: this.currentVersion,
              latestVersion: targetVersion,
              progress,
            })
          }
        },
      })
      this.setState({
        status: "installing",
        currentVersion: this.currentVersion,
        latestVersion: targetVersion,
      })
      await this.quiesceServices()
      await this.installAsset(downloadPath, this.channelInfo)
      return this.getState()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({
        status: "error",
        currentVersion: this.currentVersion,
        latestVersion: targetVersion,
        error: message,
      })
      return this.getState()
    }
  }
}

async function defaultInstallDesktopAsset(assetPath: string, channelInfo: DesktopChannelInfo): Promise<void> {
  const { app, shell } = await import("electron")
  if (channelInfo.channel === "desktop-win-nsis") {
    const child = spawn(assetPath, ["--updated", "--force-run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    })
    child.unref()
    app.quit()
    return
  }

  if (channelInfo.channel === "desktop-linux-appimage" && channelInfo.appImagePath) {
    const targetPath = channelInfo.appImagePath
    const stagedPath = `${targetPath}.update-${process.pid}`
    await copyFile(assetPath, stagedPath)
    await chmod(stagedPath, 0o755)
    await rename(stagedPath, targetPath)
    await rm(assetPath, { force: true }).catch(() => {})
    app.relaunch({ execPath: targetPath })
    app.quit()
    return
  }

  if (channelInfo.channel === "desktop-linux-deb") {
    const hasPkexec = existsSync("/usr/bin/pkexec")
    if (hasPkexec) {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("/usr/bin/pkexec", ["dpkg", "-i", assetPath], { stdio: "ignore" })
        proc.once("error", reject)
        proc.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`dpkg exited with status ${code}`))))
      })
      app.relaunch()
      app.quit()
      return
    }
    shell.showItemInFolder(assetPath)
    return
  }

  if (channelInfo.channel === "desktop-mac-dmg") {
    const openError = await shell.openPath(assetPath)
    if (openError) throw new Error(openError)
    app.quit()
  }
}
