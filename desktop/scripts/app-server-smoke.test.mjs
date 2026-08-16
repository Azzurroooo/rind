import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { dirname, join, resolve } from "node:path"
import readline from "node:readline"
import test from "node:test"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

test("app-server supports desktop session lifecycle over JSONL", async () => {
  const home = await mkdtemp(join(tmpdir(), "rind-desktop-smoke-"))
  const rindHome = join(home, ".rind")
  await mkdir(rindHome, { recursive: true })
  await writeFile(join(rindHome, "settings.json"), JSON.stringify({ apiKey: "desktop-smoke-key" }), "utf8")
  const runtime = spawn(process.env.RIND_PYTHON || "python", ["main.py", "app-server", "--stdio", "--cwd", repoRoot], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const exit = once(runtime, "exit")
  const responses = new Map()
  const lines = readline.createInterface({ input: runtime.stdout })
  lines.on("line", (line) => {
    const message = JSON.parse(line)
    const pending = responses.get(String(message.request_id))
    if (pending) {
      responses.delete(String(message.request_id))
      clearTimeout(pending.timer)
      pending.resolve(message)
    }
  })

  function request(requestId, method, params = {}) {
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        responses.delete(requestId)
        reject(new Error(`Timed out waiting for ${method}.`))
      }, 15_000)
      responses.set(requestId, { resolve: resolveRequest, timer })
      runtime.stdin.write(`${JSON.stringify({ kind: "request", request_id: requestId, method, params })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        responses.delete(requestId)
        reject(error)
      })
    })
  }

  try {
    const initialize = await request("initialize", "initialize")
    assert.equal(initialize.kind, "response")
    assert.equal(initialize.result.protocol_version, "2")
    assert.ok(initialize.result.capabilities.includes("sessions"))
    assert.ok(initialize.result.methods.includes("session/new"))
    assert.equal(initialize.result.session_id, null)
    assert.equal(initialize.result.draft, true)

    const listed = await request("sessions", "session/list", { limit: 10 })
    assert.equal(listed.error, undefined)
    assert.ok(Array.isArray(listed.result.sessions))

    const created = await request("new", "session/new")
    assert.equal(created.result.session_id, null)
    assert.equal(created.result.draft, true)

    const replay = await request("replay", "session/replay")
    assert.equal(replay.error, undefined)
    assert.ok(Array.isArray(replay.result.messages))

    const shutdown = await request("shutdown", "shutdown")
    assert.deepEqual(shutdown.result, { ok: true })
    const [code] = await exit
    assert.equal(code, 0)
  } finally {
    if (runtime.exitCode === null) runtime.kill()
    lines.close()
    await rm(home, { recursive: true, force: true })
  }
})
