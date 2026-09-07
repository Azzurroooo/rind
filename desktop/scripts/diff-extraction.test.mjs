import assert from "node:assert/strict"
import test from "node:test"

import { diffLineCounts, extractDiffText, parseDiffLines } from "../src/renderer/diff-text.ts"
import { parseToolResult } from "../src/renderer/timeline-model.ts"

// A canned tool_result payload as emitted by the kernel for edit_file:
// JSON with { ok, tool, meta: { files: [{ path, diff, added_lines, removed_lines }] } }.
const cannedEditResult = JSON.stringify({
  ok: true,
  tool: "edit_file",
  data: "File updated",
  meta: {
    files: [
      {
        path: "src/app.py",
        added_lines: 1,
        removed_lines: 1,
        diff: "--- a/src/app.py\n+++ b/src/app.py\n@@ -1,3 +1,3 @@\n def main():\n-    print(\"hello\")\n+    print(\"hello, world\")\n",
      },
    ],
  },
})

function toolFromResult(result) {
  const parsed = parseToolResult(result)
  return { toolName: parsed.toolName, result: { ok: parsed.ok, meta: parsed.meta } }
}

test("extractDiffText pulls the unified diff from the tool result", () => {
  const tool = toolFromResult(cannedEditResult)
  const diff = extractDiffText("edit_file", tool.result)
  assert.ok(diff.includes("-    print(\"hello\")"))
  assert.ok(diff.includes("+    print(\"hello, world\")"))
})

test("extractDiffText joins multiple file diffs", () => {
  const tool = toolFromResult(JSON.stringify({
    ok: true,
    tool: "write_file",
    meta: { files: [{ path: "a.txt", diff: "+one" }, { path: "b.txt", diff: "+two" }] },
  }))
  assert.equal(extractDiffText("write_file", tool.result), "+one\n+two")
})

test("extractDiffText returns empty for non-mutation tools and failed results", () => {
  assert.equal(extractDiffText("bash", { ok: true, meta: { files: [{ diff: "+x" }] } }), "")
  assert.equal(extractDiffText("edit_file", undefined), "")
  assert.equal(extractDiffText("edit_file", { ok: false, meta: {} }), "")
  assert.equal(extractDiffText("edit_file", { ok: null, meta: {} }), "")
  const failed = toolFromResult(JSON.stringify({ ok: false, tool: "edit_file", error: "boom" }))
  assert.equal(extractDiffText("edit_file", failed.result), "")
})

test("parseDiffLines classifies plus, minus, headers, and context", () => {
  const lines = parseDiffLines("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n kept")
  assert.deepEqual(lines.map((line) => line.kind), ["context", "removed", "added", "context"])
  assert.deepEqual(lines.map((line) => line.text), ["@@ -1 +1 @@", "old", "new", "kept"])
})

test("parseDiffLines caps very large diffs", () => {
  const lines = parseDiffLines(Array.from({ length: 300 }, (_, index) => `+line ${index}`).join("\n"))
  assert.equal(lines.length, 121)
  assert.equal(lines.at(-1).text, "…")
  const counts = diffLineCounts(lines)
  assert.equal(counts.added, 120)
  assert.equal(counts.capped, true)
})

test("diffLineCounts separates added and removed rows", () => {
  const counts = diffLineCounts(parseDiffLines("+a\n+b\n-c\n d"))
  assert.deepEqual({ added: counts.added, removed: counts.removed, capped: counts.capped }, { added: 2, removed: 1, capped: false })
})
