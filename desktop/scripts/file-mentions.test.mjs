import assert from "node:assert/strict"
import test from "node:test"

import { applyMention, filterFiles, mentionQueryAt } from "../src/renderer/file-mentions.ts"

test("mention query opens at word boundaries and captures the caret token", () => {
  assert.deepEqual(mentionQueryAt("@src", 4), { query: "src", start: 0 })
  assert.deepEqual(mentionQueryAt("look at @src/ind", 16), { query: "src/ind", start: 8 })
  assert.equal(mentionQueryAt("email me@test.com", 17), undefined)
  assert.equal(mentionQueryAt("plain text", 10), undefined)
  assert.deepEqual(mentionQueryAt("@", 1), { query: "", start: 0 })
})

test("mention query closes on whitespace inside the token", () => {
  assert.equal(mentionQueryAt("@src main", 9), undefined)
  assert.deepEqual(mentionQueryAt("@src main @ag", 13), { query: "ag", start: 10 })
})

const files = [
  "src/renderer/index.ts",
  "src/renderer/palette.ts",
  "src/main/runtime.ts",
  "docs/cli-rendering.md",
  "README.md",
]

test("filterFiles ranks basename matches above path matches", () => {
  const matches = filterFiles(files, "palette")
  assert.equal(matches[0].path, "src/renderer/palette.ts")
  assert.ok(matches.length <= 8)
})

test("filterFiles ranks basename prefix matches first", () => {
  const matches = filterFiles(files, "read")
  assert.equal(matches[0].path, "README.md")
})

test("filterFiles finds subsequence matches across the path", () => {
  const matches = filterFiles(files, "renderer/ind")
  assert.equal(matches[0].path, "src/renderer/index.ts")
})

test("filterFiles with an empty query returns the shallow-first prefix", () => {
  const matches = filterFiles(["b/b.txt", "a.txt", "a/long/deep/path.txt"], "")
  assert.deepEqual(matches.map((match) => match.path).slice(0, 2), ["b/b.txt", "a.txt"])
})

test("applyMention replaces the token and moves the caret after a trailing space", () => {
  const result = applyMention("look at @src main", 12, 8, "src/main/runtime.ts")
  assert.equal(result.value, "look at src/main/runtime.ts  main")
  assert.equal(result.caret, "look at src/main/runtime.ts ".length)
})
