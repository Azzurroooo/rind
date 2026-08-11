import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { DesktopProjectStore } from "../src/main/projects.ts"

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "rind-desktop-projects-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("project registry migrates the legacy workspace and pages its sessions", async () => {
  await withTempDirectory(async (directory) => {
    const firstProject = join(directory, "first")
    const secondProject = join(directory, "second")
    const configFile = join(directory, "desktop-settings.json")
    const sessionIndexFile = join(directory, "session_index.json")
    await Promise.all([mkdir(firstProject), mkdir(secondProject)])
    await writeFile(configFile, JSON.stringify({ workspace: firstProject }), "utf8")
    await writeFile(sessionIndexFile, JSON.stringify({
      sessions: [
        { id: "old", workspace_root: firstProject, title: "Old", updated_at: "2026-01-01T00:00:00Z" },
        { id: "new", workspace_root: firstProject, title: "New", updated_at: "2026-02-01T00:00:00Z" },
        { id: "other", workspace_root: secondProject, title: "Other", updated_at: "2026-03-01T00:00:00Z" },
      ],
    }), "utf8")

    const store = new DesktopProjectStore(configFile, sessionIndexFile)
    const migrated = await store.overview()
    assert.equal(migrated.projects.length, 1)
    assert.equal(migrated.activeProjectPath, firstProject)
    assert.deepEqual(migrated.projects[0].sessions.map((session) => session.id), ["new", "old"])

    await store.add(secondProject)
    const page = await store.sessions(firstProject, 1, 20)
    assert.deepEqual(page.sessions.map((session) => session.id), ["old"])
    assert.equal(page.total, 2)

    const remaining = await store.remove(firstProject)
    assert.deepEqual(remaining.projects.map((project) => project.path), [secondProject])
    assert.equal(remaining.activeProjectPath, secondProject)
    assert.equal((await readFile(sessionIndexFile, "utf8")).includes("\"old\""), true)
  })
})
