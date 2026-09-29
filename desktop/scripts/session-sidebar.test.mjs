import assert from "node:assert/strict"
import test from "node:test"

import { groupByTime, timeGroupFor } from "../src/renderer/session-groups.ts"
import { withoutSession } from "../src/renderer/session-removal.ts"

const now = new Date(2026, 8, 29, 15, 0)
const at = (month, day, hour = 12, year = 2026) => new Date(year, month, day, hour).toISOString()

test("timeGroupFor uses local calendar days", () => {
  assert.equal(timeGroupFor(at(8, 29, 0), now).label, "Today")
  assert.equal(timeGroupFor(at(8, 29, 23), now).label, "Today")
  assert.equal(timeGroupFor(at(8, 28, 23), now).label, "Yesterday")
  assert.equal(timeGroupFor(at(8, 22), now).label, "Previous 7 days")
  assert.equal(timeGroupFor(at(8, 21), now).label, "Previous 30 days")
  assert.equal(timeGroupFor(at(7, 30), now).label, "Previous 30 days")
  assert.deepEqual(timeGroupFor(at(7, 29), now), { key: "2026-08", label: "August" })
  assert.deepEqual(timeGroupFor(at(11, 3, 12, 2025), now), { key: "2025-12", label: "December 2025" })
})

test("timeGroupFor treats future and invalid times safely", () => {
  assert.equal(timeGroupFor(at(9, 2), now).label, "Today")
  assert.deepEqual(timeGroupFor("", now), { key: "older", label: "Older" })
  assert.deepEqual(timeGroupFor("not a date", now), { key: "older", label: "Older" })
})

test("groupByTime keeps order and merges items into their group", () => {
  const items = [
    { id: "a", when: at(8, 29, 14) },
    { id: "b", when: at(8, 29, 9) },
    { id: "c", when: at(8, 28) },
    { id: "d", when: at(6, 4) },
    { id: "e", when: at(6, 2) },
  ]
  const groups = groupByTime(items, (item) => item.when, now)
  assert.deepEqual(groups.map((group) => group.label), ["Today", "Yesterday", "July"])
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.id)), [["a", "b"], ["c"], ["d", "e"]])
  assert.equal(items.length, 5)
})

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
