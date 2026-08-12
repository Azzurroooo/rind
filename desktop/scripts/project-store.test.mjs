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
    await Promise.all([mkdir(firstProject), mkdir(secondProject), mkdir(join(directory, "sessions", "legacy"), { recursive: true })])
    await writeFile(join(directory, "sessions", "legacy", "messages.jsonl"), `${JSON.stringify({ role: "user", content: "Keep this legacy session" })}\n`, "utf8")
    await writeFile(configFile, JSON.stringify({ workspace: firstProject, sidebarCollapsed: true, filePanelWidth: 300 }), "utf8")
    await writeFile(sessionIndexFile, JSON.stringify({
      sessions: [
        { id: "old", workspace_root: firstProject, title: "Old", updated_at: "2026-01-01T00:00:00Z", has_user_message: true },
        { id: "new", workspace_root: firstProject, title: "New", updated_at: "2026-02-01T00:00:00Z", has_user_message: true },
        { id: "legacy", workspace_root: firstProject, title: "Legacy", updated_at: "2026-03-15T00:00:00Z" },
        { id: "empty", workspace_root: firstProject, title: "Empty", updated_at: "2026-04-01T00:00:00Z", has_user_message: false },
        { id: "other", workspace_root: secondProject, title: "Other", updated_at: "2026-03-01T00:00:00Z", has_user_message: true },
      ],
    }), "utf8")

    const store = new DesktopProjectStore(configFile, sessionIndexFile, join(directory, "desktop", "recent-sessions.json"))
    const migrated = await store.overview()
    assert.equal(migrated.projects.length, 1)
    assert.equal(migrated.activeProjectPath, firstProject)
    assert.equal(migrated.sidebarOpen, false)
    assert.equal(migrated.sidebarWidth, 248)
    assert.equal(migrated.filePanelWidth, 300)
    assert.deepEqual(migrated.projects[0].sessions.map((session) => session.id), ["legacy", "new", "old"])

    await store.add(secondProject)
    const page = await store.sessions(firstProject, 1, 20)
    assert.deepEqual(page.sessions.map((session) => session.id), ["new", "old"])
    assert.equal(page.total, 3)

    const remaining = await store.remove(firstProject)
    assert.deepEqual(remaining.projects.map((project) => project.path), [secondProject])
    assert.equal(remaining.activeProjectPath, secondProject)
    assert.equal((await readFile(sessionIndexFile, "utf8")).includes("\"old\""), true)
  })
})

test("recent sessions keep only persisted sessions from registered projects", async () => {
  await withTempDirectory(async (directory) => {
    const project = join(directory, "project")
    const otherProject = join(directory, "other")
    const configFile = join(directory, "desktop-settings.json")
    const sessionIndexFile = join(directory, "session_index.json")
    const recentSessionsFile = join(directory, "desktop", "recent-sessions.json")
    await Promise.all([mkdir(project), mkdir(otherProject)])
    await writeFile(configFile, JSON.stringify({ projects: [project], activeProjectPath: project }), "utf8")

    const sessions = Array.from({ length: 12 }, (_value, index) => ({
      id: `recent-${String(index).padStart(2, "0")}`,
      workspace_root: project,
      title: `Recent ${index}`,
      preview: `Message ${index}`,
      updated_at: `2026-03-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      has_user_message: true,
    }))
    sessions.push(
      { id: "empty", workspace_root: project, title: "Empty", updated_at: "2026-04-01T00:00:00Z", has_user_message: false },
      { id: "other", workspace_root: otherProject, title: "Other", updated_at: "2026-04-02T00:00:00Z", has_user_message: true },
    )
    await writeFile(sessionIndexFile, JSON.stringify({ sessions }), "utf8")
    await mkdir(join(directory, "desktop"), { recursive: true })
    await writeFile(recentSessionsFile, JSON.stringify({
      sessions: [
        ...Array.from({ length: 12 }, (_value, index) => ({
          session_id: `recent-${String(index).padStart(2, "0")}`,
          last_interacted_at: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        })),
        { session_id: "recent-01", last_interacted_at: "2020-01-01T00:00:00Z" },
        { session_id: "empty", last_interacted_at: "2026-06-01T00:00:00Z" },
        { session_id: "other", last_interacted_at: "2026-06-02T00:00:00Z" },
        { session_id: "missing", last_interacted_at: "2026-06-03T00:00:00Z" },
        { session_id: "", last_interacted_at: "not-a-date" },
      ],
    }), "utf8")

    const store = new DesktopProjectStore(configFile, sessionIndexFile, recentSessionsFile)
    const overview = await store.overview()
    assert.equal(overview.recentSessions.length, 10)
    assert.deepEqual(overview.recentSessions.map((session) => session.id), [
      "recent-11", "recent-10", "recent-09", "recent-08", "recent-07",
      "recent-06", "recent-05", "recent-04", "recent-03", "recent-02",
    ])
    const refreshed = await store.markRecent("recent-02")
    assert.equal(refreshed.recentSessions[0].id, "recent-02")
    assert.equal(refreshed.recentSessions.length, 10)
    const afterInvalidMark = await store.markRecent("empty")
    assert.equal(afterInvalidMark.recentSessions[0].id, "recent-02")
    const stored = JSON.parse(await readFile(configFile, "utf8"))
    assert.equal(stored.recentSessions.length, 10)
    assert.equal(stored.recentSessions[0].session_id, "recent-02")
    await assert.rejects(() => readFile(recentSessionsFile, "utf8"), { code: "ENOENT" })
  })
})

test("recent sessions migrate into desktop settings", async () => {
  await withTempDirectory(async (directory) => {
    const project = join(directory, "project")
    const configFile = join(directory, "desktop-settings.json")
    const sessionIndexFile = join(directory, "session_index.json")
    const recentSessionsFile = join(directory, "desktop", "recent-sessions.json")
    await mkdir(project)
    await writeFile(configFile, JSON.stringify({ projects: [project], activeProjectPath: project }), "utf8")
    await writeFile(sessionIndexFile, JSON.stringify({ sessions: [{ id: "session-1", workspace_root: project, title: "Session", updated_at: "2026-06-01T00:00:00Z", has_user_message: true }] }), "utf8")
    await mkdir(join(directory, "desktop"), { recursive: true })
    await writeFile(recentSessionsFile, JSON.stringify({ sessions: [{ session_id: "session-1", last_interacted_at: "2026-06-02T00:00:00Z" }] }), "utf8")

    const store = new DesktopProjectStore(configFile, sessionIndexFile, recentSessionsFile)
    const overview = await store.overview()
    assert.equal(overview.recentSessions[0].id, "session-1")
    assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")).recentSessions, [{ session_id: "session-1", last_interacted_at: "2026-06-02T00:00:00Z" }])
    await assert.rejects(() => readFile(recentSessionsFile, "utf8"), { code: "ENOENT" })
  })
})
