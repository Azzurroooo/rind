import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import test from "node:test"

import {
  DESKTOP_UPDATE_TTL_MS,
  DesktopUpdater,
  resolveDesktopChannel,
  selectDesktopAsset,
} from "../src/main/updater.ts"

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "rind-desktop-updater-test-"))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("resolveDesktopChannel and selectDesktopAsset match platform artifacts", () => {
  assert.equal(resolveDesktopChannel({ isPackaged: false, platform: "win32" }).channel, "desktop-dev")

  const win = resolveDesktopChannel({ isPackaged: true, platform: "win32", arch: "x64" })
  assert.equal(win.channel, "desktop-win-nsis")
  assert.equal(win.target, "windows-x64")
  assert.equal(win.ext, ".exe")

  const macArm = resolveDesktopChannel({ isPackaged: true, platform: "darwin", arch: "arm64" })
  assert.equal(macArm.channel, "desktop-mac-dmg")
  assert.equal(macArm.target, "macos-arm64")
  assert.equal(macArm.ext, ".dmg")

  const appImage = resolveDesktopChannel({
    isPackaged: true,
    platform: "linux",
    arch: "x64",
    appImage: "/home/user/Apps/Rind.AppImage",
  })
  assert.equal(appImage.channel, "desktop-linux-appimage")
  assert.equal(appImage.ext, ".AppImage")

  const deb = resolveDesktopChannel({ isPackaged: true, platform: "linux", arch: "x64", appImage: "" })
  assert.equal(deb.channel, "desktop-linux-deb")
  assert.equal(deb.ext, ".deb")

  const manifest = {
    version: "0.11.0",
    assets: [
      {
        name: "RindCLISetup-0.11.0-win-x64.exe",
        product: "cli",
        target: "windows-x64",
        bytes: 100,
        sha256: "aaa",
      },
      {
        name: "rind-desktop-0.11.0-win-x64.exe",
        product: "desktop",
        target: "windows-x64",
        bytes: 200,
        sha256: "bbb",
      },
      {
        name: "rind-desktop-0.11.0-linux-x64.AppImage",
        product: "desktop",
        target: "linux-x64",
        bytes: 300,
        sha256: "ccc",
      },
      {
        name: "rind-desktop-0.11.0-linux-x64.deb",
        product: "desktop",
        target: "linux-x64",
        bytes: 400,
        sha256: "ddd",
      },
    ],
  }

  const winAsset = selectDesktopAsset(manifest, win, "https://example.test/releases")
  assert.equal(winAsset?.name, "rind-desktop-0.11.0-win-x64.exe")
  assert.equal(winAsset?.url, "https://example.test/releases/download/v0.11.0/rind-desktop-0.11.0-win-x64.exe")

  const appImageAsset = selectDesktopAsset(manifest, appImage, "https://example.test/releases")
  assert.equal(appImageAsset?.name, "rind-desktop-0.11.0-linux-x64.AppImage")

  const debAsset = selectDesktopAsset(manifest, deb, "https://example.test/releases")
  assert.equal(debAsset?.name, "rind-desktop-0.11.0-linux-x64.deb")
})

test("DesktopUpdater reads 20h TTL cache on startup and refreshes when expired", async () => {
  await withTempDir(async (rindHome) => {
    const now = 1_760_000_000_000
    await writeFile(
      join(rindHome, "update-check.json"),
      JSON.stringify({
        checkedAt: now - 1000,
        latestVersion: "0.11.0",
        desktopAsset: {
          name: "rind-desktop-0.11.0-win-x64.exe",
          target: "windows-x64",
          bytes: 512,
          sha256: "abcd",
        },
      }),
      "utf8",
    )

    let fetchCount = 0
    const states = []
    const updater = new DesktopUpdater({
      currentVersion: "0.10.0",
      isPackaged: true,
      platform: "win32",
      arch: "x64",
      rindHome,
      onStateChange: (s) => states.push(s),
      fetchImpl: async () => {
        fetchCount += 1
        throw new Error("should not fetch while TTL is fresh")
      },
    })

    try {
      const initial = await updater.initialize(now)
      assert.equal(initial.status, "available")
      assert.equal(initial.latestVersion, "0.11.0")
      assert.equal(fetchCount, 0)
      assert.equal(states.at(-1)?.status, "available")
    } finally {
      updater.dispose()
    }

    // Expired TTL triggers background refresh
    let refreshedResolve
    const refreshedPromise = new Promise((resolve) => {
      refreshedResolve = resolve
    })
    const expiredUpdater = new DesktopUpdater({
      currentVersion: "0.10.0",
      isPackaged: true,
      platform: "win32",
      arch: "x64",
      rindHome,
      onStateChange: (s) => {
        if (s.latestVersion === "0.12.0") refreshedResolve(s)
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          version: "0.12.0",
          assets: [
            {
              name: "rind-desktop-0.12.0-win-x64.exe",
              product: "desktop",
              target: "windows-x64",
              bytes: 1024,
              sha256: "ef01",
            },
          ],
        }),
      }),
    })

    try {
      await expiredUpdater.initialize(now + DESKTOP_UPDATE_TTL_MS + 5000)
      const updatedState = await refreshedPromise
      assert.equal(updatedState.status, "available")
      assert.equal(updatedState.latestVersion, "0.12.0")
    } finally {
      expiredUpdater.dispose()
    }
  })
})

test("DesktopUpdater.applyUpdate verifies SHA256, quiesces services, and invokes installer", async () => {
  await withTempDir(async (rindHome) => {
    const payload = Buffer.from("fake-desktop-nsis-installer-binary")
    const sha256 = createHash("sha256").update(payload).digest("hex")
    const manifest = {
      version: "0.11.0",
      assets: [
        {
          name: "rind-desktop-0.11.0-win-x64.exe",
          product: "desktop",
          target: "windows-x64",
          bytes: payload.length,
          sha256,
        },
      ],
    }

    const transitions = []
    let quiesced = false
    let installedPath = ""
    let installedChannel = ""

    const updater = new DesktopUpdater({
      currentVersion: "0.10.0",
      isPackaged: true,
      platform: "win32",
      arch: "x64",
      rindHome,
      onStateChange: (s) => transitions.push(s.status),
      quiesceServices: async () => {
        quiesced = true
      },
      installAsset: async (filePath, channelInfo) => {
        installedPath = filePath
        installedChannel = channelInfo.channel
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("release-manifest.json")) {
          return { ok: true, status: 200, json: async () => manifest }
        }
        return {
          ok: true,
          status: 200,
          body: Readable.from([payload]),
        }
      },
    })

    try {
      await updater.checkForUpdates()
      assert.equal(updater.getState().status, "available")

      const finalState = await updater.applyUpdate()
      assert.equal(finalState.status, "installing")
      assert.equal(quiesced, true)
      assert.equal(installedChannel, "desktop-win-nsis")
      assert.ok(installedPath.endsWith("rind-desktop-0.11.0-win-x64.exe"))
      assert.ok(existsSync(installedPath))
      assert.deepEqual(transitions, ["available", "downloading", "downloading", "installing"])
    } finally {
      updater.dispose()
      if (installedPath) await rm(installedPath, { force: true }).catch(() => {})
    }
  })
})

test("DesktopUpdater.applyUpdate transitions to error on SHA256 mismatch", async () => {
  await withTempDir(async (rindHome) => {
    const payload = Buffer.from("corrupted-installer-bytes")
    const manifest = {
      version: "0.11.0",
      assets: [
        {
          name: "rind-desktop-0.11.0-win-x64.exe",
          product: "desktop",
          target: "windows-x64",
          bytes: payload.length,
          sha256: "0".repeat(64),
        },
      ],
    }

    const updater = new DesktopUpdater({
      currentVersion: "0.10.0",
      isPackaged: true,
      platform: "win32",
      arch: "x64",
      rindHome,
      fetchImpl: async (url) => {
        if (String(url).endsWith("release-manifest.json")) {
          return { ok: true, status: 200, json: async () => manifest }
        }
        return {
          ok: true,
          status: 200,
          body: Readable.from([payload]),
        }
      },
    })

    try {
      const state = await updater.applyUpdate()
      assert.equal(state.status, "error")
      assert.match(String(state.error), /SHA256 verification failed/)
    } finally {
      updater.dispose()
    }
  })
})
