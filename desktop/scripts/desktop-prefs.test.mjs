import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { DesktopProjectStore } from "../src/main/projects.ts"

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "rind-desktop-prefs-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("desktop prefs default to system theme with notifications enabled", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(join(directory, "project"))
    const store = new DesktopProjectStore(
      join(directory, "desktop-settings.json"),
      join(directory, "session_index.json"),
      join(directory, "recent-sessions.json"),
    )
    await store.add(join(directory, "project"))
    const overview = await store.overview()
    assert.equal(overview.theme, "system")
    assert.equal(overview.notificationsEnabled, true)
  })
})

test("desktop prefs persist theme and notification toggles across reloads", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(join(directory, "project"))
    const configFile = join(directory, "desktop-settings.json")
    const store = new DesktopProjectStore(
      configFile,
      join(directory, "session_index.json"),
      join(directory, "recent-sessions.json"),
    )
    await store.add(join(directory, "project"))
    const updated = await store.updatePrefs({ theme: "light", notificationsEnabled: false })
    assert.equal(updated.theme, "light")
    assert.equal(updated.notificationsEnabled, false)

    // Layout updates must not clobber the prefs.
    await store.updateLayout({ sidebarOpen: false })

    const reloaded = new DesktopProjectStore(
      configFile,
      join(directory, "session_index.json"),
      join(directory, "recent-sessions.json"),
    )
    const overview = await reloaded.overview()
    assert.equal(overview.theme, "light")
    assert.equal(overview.notificationsEnabled, false)
    assert.equal(overview.sidebarOpen, false)
  })
})

test("invalid pref values fall back to defaults", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(join(directory, "project"))
    const store = new DesktopProjectStore(
      join(directory, "desktop-settings.json"),
      join(directory, "session_index.json"),
      join(directory, "recent-sessions.json"),
    )
    await store.add(join(directory, "project"))
    const updated = await store.updatePrefs({ theme: "navy" })
    assert.equal(updated.theme, "system")
  })
})
