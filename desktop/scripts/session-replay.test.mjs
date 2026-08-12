import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { replaySession } from "../src/main/session-replay.ts"

test("session replay projects persisted messages without starting a runtime", async () => {
  const home = await mkdtemp(join(tmpdir(), "rind-desktop-replay-"))
  const workspace = join(home, "project")
  const sessionId = "20260811_134719_aceb095f"
  const base = join(home, "sessions", sessionId)
  try {
    await mkdir(base, { recursive: true })
    await mkdir(workspace)
    await writeFile(join(base, "meta.json"), JSON.stringify({ schema_version: "2.0", session_id: sessionId, workspace_root: workspace }), "utf8")
    await writeFile(join(base, "messages.jsonl"), [
      { role: "system", content: "system" },
      { role: "user", content: "inspect this" },
      { role: "assistant", content: "", meta: { tool_calls: [{ id: "call-1", name: "shell" }] } },
      { role: "tool", tool_call_id: "call-1", content: "" },
      { role: "assistant", content: "Done." },
    ].map((item) => JSON.stringify(item)).join("\n"), "utf8")
    await writeFile(join(base, "tool_calls.jsonl"), JSON.stringify({ id: "call-1", name: "shell", raw_args: "{\"command\":\"pwd\"}", model_content: "command completed" }) + "\n", "utf8")
    const result = await replaySession(home, sessionId, workspace)
    assert.deepEqual(result.messages.map((message) => message.role), ["system", "user", "assistant", "tool", "assistant"])
    assert.equal(result.messages[2].tool_calls[0].function.name, "shell")
    assert.equal(result.messages[3].content, "command completed")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("session replay rejects a session bound to another project", async () => {
  const home = await mkdtemp(join(tmpdir(), "rind-desktop-replay-"))
  const first = join(home, "first")
  const second = join(home, "second")
  const sessionId = "session-1"
  const base = join(home, "sessions", sessionId)
  try {
    await mkdir(base, { recursive: true })
    await mkdir(first)
    await mkdir(second)
    await writeFile(join(base, "meta.json"), JSON.stringify({ schema_version: "2.0", session_id: sessionId, workspace_root: first }), "utf8")
    await assert.rejects(() => replaySession(home, sessionId, second), /does not belong/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
