import assert from "node:assert/strict"
import test from "node:test"

import { defaultNewChatProjectPath, workingDirectorySelectionEnabled } from "../src/renderer/project-selection.ts"

function project(path, available = true) {
  return { path, name: path, available, sessions: [], totalSessions: 0 }
}

function recent(workspaceRoot) {
  return { id: workspaceRoot, workspaceRoot, title: workspaceRoot, preview: "", updatedAt: "", hasUserMessage: true, lastInteractedAt: "" }
}

test("new chat defaults to the most recent available project", () => {
  const first = project("C:/work/first")
  const second = project("C:/work/second")

  assert.equal(defaultNewChatProjectPath([first, second], [recent(second.path), recent(first.path)], first.path), second.path)
})

test("new chat skips unavailable recent projects before using the fallback", () => {
  const unavailable = project("C:/work/missing", false)
  const fallback = project("C:/work/fallback")

  assert.equal(defaultNewChatProjectPath([unavailable, fallback], [recent(unavailable.path)], fallback.path), fallback.path)
})

test("new chat uses the first available project when recent and fallback projects are unavailable", () => {
  const unavailable = project("C:/work/missing", false)
  const available = project("C:/work/available")

  assert.equal(defaultNewChatProjectPath([unavailable, available], [], unavailable.path), available.path)
  assert.equal(defaultNewChatProjectPath([unavailable], [], unavailable.path), "")
})

test("working directory selection is disabled for an existing session", () => {
  assert.equal(workingDirectorySelectionEnabled(1, ""), true)
  assert.equal(workingDirectorySelectionEnabled(0, ""), false)
  assert.equal(workingDirectorySelectionEnabled(1, "session-1"), false)
})
