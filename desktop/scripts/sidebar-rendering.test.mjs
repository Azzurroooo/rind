import assert from "node:assert/strict"
import test from "node:test"

import { projectListStructureKey, recentListStructureKey } from "../src/renderer/sidebar-rendering.ts"

function session(id, workspaceRoot = "C:/work/project") {
  return {
    id,
    title: id,
    preview: "preview",
    updatedAt: "2026-08-17T00:00:00Z",
    workspaceRoot,
    hasUserMessage: true,
  }
}

function state(viewedSessionId = "session-1") {
  const first = session("session-1")
  const second = session("session-2")
  const project = { path: "C:/work/project", name: "project", available: true, sessions: [first, second], totalSessions: 2 }
  return {
    projects: [project],
    recentSessions: [{ ...first, lastInteractedAt: "2026-08-17T00:00:00Z" }],
    sessionPages: {},
    sessionTotals: {},
    expandedProjects: new Set([project.path]),
    projectMenuPath: "",
    runningSessionIds: new Set(),
    viewedSessionId,
  }
}

test("sidebar structure keys ignore only the selected session", () => {
  const first = state("session-1")
  const second = state("session-2")

  assert.equal(projectListStructureKey(first), projectListStructureKey(second))
  assert.equal(recentListStructureKey(first), recentListStructureKey(second))
})

test("sidebar structure keys change for project and expansion changes", () => {
  const first = state()
  const changedProject = { ...state(), projects: [{ ...first.projects[0], name: "renamed" }] }
  const collapsed = { ...first, expandedProjects: new Set() }

  assert.notEqual(projectListStructureKey(first), projectListStructureKey(changedProject))
  assert.notEqual(projectListStructureKey(first), projectListStructureKey(collapsed))
})

test("sidebar structure keys include running, pagination, and menu state", () => {
  const first = state()
  const running = { ...first, runningSessionIds: new Set(["session-1"]) }
  const paged = { ...first, sessionTotals: { "C:/work/project": 3 } }
  const menu = { ...first, projectMenuPath: "C:/work/project" }

  assert.notEqual(projectListStructureKey(first), projectListStructureKey(running))
  assert.notEqual(recentListStructureKey(first), recentListStructureKey(running))
  assert.notEqual(projectListStructureKey(first), projectListStructureKey(paged))
  assert.notEqual(projectListStructureKey(first), projectListStructureKey(menu))
})
