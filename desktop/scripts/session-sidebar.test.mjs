import assert from "node:assert/strict"
import test from "node:test"

import { withoutSession } from "../src/renderer/session-removal.ts"

function lists() {
  const shared = { id: "s1" }
  return {
    recentSessions: [{ id: "s1" }, { id: "s2" }],
    sessionPages: { "/one": [shared, { id: "s3" }], "/two": [{ id: "s4" }] },
    sessionTotals: { "/one": 5, "/two": 1 },
    projects: [
      { path: "/one", name: "one", sessions: [shared], totalSessions: 5 },
      { path: "/two", name: "two", sessions: [{ id: "s4" }], totalSessions: 1 },
    ],
    conversationCache: { s1: { entries: [] }, s2: { entries: [] } },
    drafts: { "s1:draft": "hello", "s2:draft": "keep" },
  }
}

test("withoutSession removes the session everywhere without mutating", () => {
  const before = lists()
  const snapshot = structuredClone(before)
  const after = withoutSession(before, "s1")
  assert.deepEqual(before, snapshot)
  assert.deepEqual(after.recentSessions.map((item) => item.id), ["s2"])
  assert.deepEqual(after.sessionPages["/one"].map((item) => item.id), ["s3"])
  assert.deepEqual(after.projects[0].sessions, [])
  assert.equal(after.projects[0].totalSessions, 4)
  assert.equal(after.sessionTotals["/one"], 4)
  assert.deepEqual(Object.keys(after.conversationCache), ["s2"])
  assert.deepEqual(after.drafts, { "s2:draft": "keep" })
})

test("withoutSession leaves unrelated project totals alone", () => {
  const before = lists()
  const after = withoutSession(before, "s1")
  assert.equal(after.projects[1], before.projects[1])
  assert.equal(after.sessionTotals["/two"], 1)
  const unknown = withoutSession(before, "missing")
  assert.equal(unknown.projects[0].totalSessions, 5)
  assert.equal(unknown.sessionTotals["/one"], 5)
})
