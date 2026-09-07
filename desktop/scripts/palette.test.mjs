import assert from "node:assert/strict"
import test from "node:test"

import { filterCommands, moveActiveIndex } from "../src/renderer/palette.ts"

const commands = [
  { id: "new", title: "新会话", run: () => {} },
  { id: "model", title: "模型：gpt-x", keywords: "model", run: () => {} },
  { id: "effort", title: "力度：high", keywords: "reasoning effort", run: () => {} },
  { id: "compact", title: "压缩上下文", detail: "Compact context", run: () => {} },
  { id: "theme", title: "主题：浅色", detail: "Light theme", run: () => {} },
  { id: "delete", title: "删除会话：demo", detail: "session-123", run: () => {}, disabled: true },
]

test("empty query returns every command", () => {
  const matches = filterCommands(commands, "")
  assert.equal(matches.length, commands.length)
  assert.deepEqual(new Set(matches.map((match) => match.command.id)), new Set(commands.map((command) => command.id)))
})

test("exact prefix matches rank first", () => {
  const matches = filterCommands(commands, "压缩")
  assert.equal(matches.length, 1)
  assert.equal(matches[0].command.id, "compact")
  assert.equal(matches[0].score, 0)
})

test("fuzzy subsequence matches still surface commands", () => {
  const matches = filterCommands(commands, "mdl")
  assert.ok(matches.some((match) => match.command.id === "model"))
})

test("detail and keywords participate in matching with a penalty", () => {
  const byKeyword = filterCommands(commands, "light")
  assert.equal(byKeyword[0].command.id, "theme")
  const byDetail = filterCommands(commands, "session-123")
  assert.equal(byDetail[0].command.id, "delete")
  const byTitle = filterCommands(commands, "浅色")
  assert.equal(byTitle[0].command.id, "theme")
  assert.ok(byTitle[0].score < byKeyword[0].score, "title matches rank above detail matches")
})

test("non-matching queries return nothing", () => {
  assert.deepEqual(filterCommands(commands, "zzzz"), [])
})

test("moveActiveIndex wraps in both directions", () => {
  assert.equal(moveActiveIndex(0, -1, 3), 2)
  assert.equal(moveActiveIndex(2, 1, 3), 0)
  assert.equal(moveActiveIndex(1, 1, 0), 0)
})
