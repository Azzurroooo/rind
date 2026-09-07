import assert from "node:assert/strict"
import test from "node:test"

import { filterSessions } from "../src/renderer/sidebar-rendering.ts"

const sessions = [
  { id: "s-1", title: "Refactor auth", preview: "move login handler", updatedAt: "", workspaceRoot: "", hasUserMessage: true },
  { id: "s-2", title: "Fix crash", preview: "null pointer in parser", updatedAt: "", workspaceRoot: "", hasUserMessage: true },
  { id: "s-3", title: "Ünïcode title", preview: "emoji test 🚀", updatedAt: "", workspaceRoot: "", hasUserMessage: true },
]

test("empty queries pass sessions through untouched", () => {
  assert.deepEqual(filterSessions(sessions, ""), sessions)
  assert.deepEqual(filterSessions(sessions, "   "), sessions)
})

test("title, preview, and id participate in the filter", () => {
  assert.deepEqual(filterSessions(sessions, "refactor").map((session) => session.id), ["s-1"])
  assert.deepEqual(filterSessions(sessions, "parser").map((session) => session.id), ["s-2"])
  assert.deepEqual(filterSessions(sessions, "S-3").map((session) => session.id), ["s-3"])
})

test("matching is case-insensitive and fails closed", () => {
  assert.deepEqual(filterSessions(sessions, "CRASH").map((session) => session.id), ["s-2"])
  assert.deepEqual(filterSessions(sessions, "nonexistent"), [])
})
